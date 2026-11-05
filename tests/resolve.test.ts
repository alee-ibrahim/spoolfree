import { describe, expect, it } from "vitest";
import { ancestorChain, dnEquals, isUnder, normalizeDn, parentDn, rdnValue, splitDn } from "@/lib/dn";
import { ousWithoutPrinters, resolvePrinters, type Policy } from "@/lib/resolve";

const BASE = "DC=example,DC=org";
const W = `OU=Workstations,${BASE}`;
const ADM = `OU=Administration,${W}`;
const FIN = `OU=Finance,${ADM}`;
const KIOSK = `OU=Kiosks,${W}`;

function policy(p: Partial<Policy> = {}): Policy {
  return { baseDn: BASE, assignments: [], ouSettings: [], overrides: [], ...p };
}
const setting = (ouDn: string, s: Partial<Policy["ouSettings"][number]>) => ({
  ouDn,
  blockInheritance: false,
  blockedPrinterIds: [],
  defaultPrinterId: null,
  ...s,
});
const ids = (r: ReturnType<typeof resolvePrinters>) => r.printers.map((p) => p.printerId);

describe("dn helpers", () => {
  it("splits with escaped commas", () => {
    expect(splitDn("CN=Smith\\, John,OU=Users,DC=example,DC=org")).toEqual(["CN=Smith\\, John", "OU=Users", "DC=example", "DC=org"]);
    expect(rdnValue("CN=Smith\\, John,OU=Users,DC=x")).toBe("Smith, John");
  });
  it("normalizes case and whitespace", () => {
    expect(normalizeDn("OU=Lab , ou=Staff,DC=Example, DC=ORG")).toBe("ou=lab,ou=staff,dc=example,dc=org");
    expect(dnEquals("ou=FINANCE,dc=example,dc=org", "OU=Finance,DC=example,DC=org")).toBe(true);
  });
  it("finds parents and ancestry", () => {
    expect(parentDn(FIN)).toBe(ADM);
    expect(parentDn("DC=org")).toBeNull();
    expect(isUnder(`CN=PC1,${FIN}`, W)).toBe(true);
    expect(isUnder(KIOSK, ADM)).toBe(false);
    // "OU=Workstations2" must not count as under "OU=Workstations".
    expect(isUnder(`OU=X,OU=Workstations2,${BASE}`, W)).toBe(false);
  });
  it("builds the chain from base to parent", () => {
    expect(ancestorChain(`CN=PC1,${FIN}`, BASE)).toEqual([BASE, W, ADM, FIN]);
    expect(ancestorChain(`CN=PC1,${FIN}`, W)).toEqual([W, ADM, FIN]);
  });
});

describe("resolvePrinters", () => {
  it("inherits printers from parent OUs", () => {
    const r = resolvePrinters(
      policy({ assignments: [{ ouDn: W, printerId: "all" }, { ouDn: ADM, printerId: "adm" }, { ouDn: FIN, printerId: "fin" }] }),
      { dn: `CN=FIN-01,${FIN}` },
    );
    expect(ids(r)).toEqual(["all", "adm", "fin"]);
    expect(r.printers[1].source).toEqual({ kind: "ou", ouDn: ADM });
  });

  it("matches OU DNs case-insensitively", () => {
    const r = resolvePrinters(policy({ assignments: [{ ouDn: ADM.toLowerCase(), printerId: "adm" }] }), { dn: `CN=X,${FIN}` });
    expect(ids(r)).toEqual(["adm"]);
  });

  it("does not leak printers to sibling OUs", () => {
    const r = resolvePrinters(policy({ assignments: [{ ouDn: ADM, printerId: "adm" }] }), { dn: `CN=K1,${KIOSK}` });
    expect(ids(r)).toEqual([]);
  });

  it("block inheritance drops everything from above but keeps own and children", () => {
    const p = policy({
      assignments: [
        { ouDn: W, printerId: "all" },
        { ouDn: KIOSK, printerId: "kiosk" },
        { ouDn: `OU=Sub,${KIOSK}`, printerId: "sub" },
      ],
      ouSettings: [setting(KIOSK, { blockInheritance: true })],
    });
    expect(ids(resolvePrinters(p, { dn: `CN=K1,${KIOSK}` }))).toEqual(["kiosk"]);
    expect(ids(resolvePrinters(p, { dn: `CN=K2,OU=Sub,${KIOSK}` }))).toEqual(["kiosk", "sub"]);
  });

  it("blocks a single inherited printer at an OU and below", () => {
    const p = policy({
      assignments: [{ ouDn: W, printerId: "all" }, { ouDn: W, printerId: "colour" }],
      ouSettings: [setting(ADM, { blockedPrinterIds: ["colour"] })],
    });
    expect(ids(resolvePrinters(p, { dn: `CN=A,${ADM}` }))).toEqual(["all"]);
    expect(ids(resolvePrinters(p, { dn: `CN=F,${FIN}` }))).toEqual(["all"]);
    const r = resolvePrinters(p, { dn: `CN=A,${ADM}` });
    expect(r.trace.find((t) => t.ouDn === ADM)?.blocked).toEqual(["colour"]);
  });

  it("re-assigning a blocked printer lower down brings it back", () => {
    const p = policy({
      assignments: [{ ouDn: W, printerId: "colour" }, { ouDn: FIN, printerId: "colour" }],
      ouSettings: [setting(ADM, { blockedPrinterIds: ["colour"] })],
    });
    expect(ids(resolvePrinters(p, { dn: `CN=F,${FIN}` }))).toEqual(["colour"]);
    expect(resolvePrinters(p, { dn: `CN=F,${FIN}` }).printers[0].source).toEqual({ kind: "ou", ouDn: FIN });
  });

  it("inherits defaults, lets child OUs override them, and clears blocked defaults", () => {
    const p = policy({
      assignments: [{ ouDn: W, printerId: "a" }, { ouDn: FIN, printerId: "b" }],
      ouSettings: [setting(W, { defaultPrinterId: "a" })],
    });
    expect(resolvePrinters(p, { dn: `CN=X,${FIN}` }).defaultPrinterId).toBe("a");

    p.ouSettings.push(setting(FIN, { defaultPrinterId: "b" }));
    expect(resolvePrinters(p, { dn: `CN=X,${FIN}` }).defaultPrinterId).toBe("b");
    expect(resolvePrinters(p, { dn: `CN=X,${ADM}` }).defaultPrinterId).toBe("a");

    const blocked = policy({ ...p, ouSettings: [setting(W, { defaultPrinterId: "a" }), setting(ADM, { blockedPrinterIds: ["a"] })] });
    expect(resolvePrinters(blocked, { dn: `CN=X,${FIN}` }).defaultPrinterId).toBeNull();
  });

  it("ignores a default that points at a printer not in the set", () => {
    const p = policy({ assignments: [{ ouDn: W, printerId: "a" }], ouSettings: [setting(W, { defaultPrinterId: "zzz" })] });
    expect(resolvePrinters(p, { dn: `CN=X,${W}` }).defaultPrinterId).toBeNull();
  });

  it("applies per-computer block and add overrides", () => {
    const guid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const p = policy({
      assignments: [{ ouDn: W, printerId: "a" }, { ouDn: W, printerId: "b" }],
      ouSettings: [setting(W, { defaultPrinterId: "a" })],
      overrides: [
        { computerGuid: guid.toUpperCase(), printerId: "a", action: "block", makeDefault: false },
        { computerGuid: guid, printerId: "c", action: "add", makeDefault: true },
        { computerGuid: "other", printerId: "d", action: "add", makeDefault: false },
      ],
    });
    const r = resolvePrinters(p, { dn: `CN=X,${W}`, objectGuid: guid });
    expect(ids(r)).toEqual(["b", "c"]);
    expect(r.defaultPrinterId).toBe("c");
    expect(r.printers[1].source).toEqual({ kind: "computer" });
    expect(r.overridesApplied).toHaveLength(2);
    // Without the GUID, overrides are not applied.
    expect(ids(resolvePrinters(p, { dn: `CN=X,${W}` }))).toEqual(["a", "b"]);
  });

  it("an explicit add wins over a block for the same printer", () => {
    const g = "a";
    const p = policy({
      overrides: [
        { computerGuid: g, printerId: "p", action: "block", makeDefault: false },
        { computerGuid: g, printerId: "p", action: "add", makeDefault: false },
      ],
    });
    expect(ids(resolvePrinters(p, { dn: `CN=X,${W}`, objectGuid: g }))).toEqual(["p"]);
  });

  it("computers in the default Computers container only get domain-root printers", () => {
    const p = policy({ assignments: [{ ouDn: BASE, printerId: "root" }, { ouDn: W, printerId: "w" }] });
    expect(ids(resolvePrinters(p, { dn: `CN=NEW,CN=Computers,${BASE}` }))).toEqual(["root"]);
  });

  it("ignores containers above the base DN", () => {
    const p = policy({ baseDn: W, assignments: [{ ouDn: BASE, printerId: "root" }, { ouDn: W, printerId: "w" }] });
    expect(ids(resolvePrinters(p, { dn: `CN=X,${ADM}` }))).toEqual(["w"]);
  });

  it("lists OUs without printers", () => {
    const p = policy({ assignments: [{ ouDn: ADM, printerId: "adm" }] });
    expect(ousWithoutPrinters(p, [W, ADM, FIN, KIOSK])).toEqual([W, KIOSK]);
  });
});
