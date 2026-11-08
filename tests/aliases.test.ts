import { describe, expect, it } from "vitest";
import { aliasKey, aliasList, manifestAliases, splitAliases } from "@/lib/aliases";
import { exportCsv, exportYaml, parseInput, plan, type CurrentState } from "@/lib/bulk";
import { buildManifest, type ManifestPrinterInput } from "@/lib/manifest";
import { resolvePrinters } from "@/lib/resolve";

describe("legacy aliases", () => {
  it("splits, trims and de-duplicates case-insensitively (.local optional)", () => {
    expect(splitAliases("OLD-PRN-OFFICE2, old-prn-office2.local; old-printer.  OLD-PRINTER")).toEqual(["OLD-PRN-OFFICE2", "old-printer"]);
    expect(aliasKey("Old-Printer.LOCAL.")).toBe("old-printer");
  });

  it("rejects UNC paths and ports", () => {
    expect(aliasList.safeParse("\\\\server\\share").success).toBe(false);
    expect(aliasList.safeParse("printer:9100").success).toBe(false);
    expect(aliasList.safeParse("OLD-PRN-OFFICE2").success).toBe(true);
  });

  it("goes into the manifest lower-cased, only when takeover is on or dry-run", () => {
    const OU = "OU=Staff,DC=example,DC=org";
    const computer = { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", dn: `CN=PC1,${OU}`, name: "PC1" };
    const base = { host: "192.0.2.13", port: 631, ippPath: "/ipp/print", useTls: false, model: null, location: null, revision: 1, legacyAliases: ["OLD-PRN-OFFICE2", "old.local."] };
    const printers = new Map<string, ManifestPrinterInput>([
      ["p1", { id: "p1", name: "On", legacyTakeover: "on", ...base }],
      ["p2", { id: "p2", name: "Off", legacyTakeover: "off", ...base }],
    ]);
    const resolution = resolvePrinters(
      { baseDn: "DC=example,DC=org", assignments: [{ ouDn: OU, printerId: "p1" }, { ouDn: OU, printerId: "p2" }], ouSettings: [], overrides: [] },
      computer,
    );
    const m = buildManifest({ resolution, printers, computer, now: new Date(0), ttlHours: 1, analytics: { enabled: true, collectDocumentNames: false } });
    expect(m.printers.find((p) => p.name === "On")?.legacyAliases).toEqual(["old-prn-office2", "old.local"]);
    expect(m.printers.find((p) => p.name === "Off")?.legacyAliases).toEqual([]);
    expect(m.analytics).toEqual({ enabled: true, collectDocumentNames: false });
    expect(manifestAliases(null)).toEqual([]);
  });
});

describe("bulk CLI: aliases and IPP path", () => {
  const row = (over: Partial<CurrentState["printers"][number]> = {}): CurrentState["printers"][number] => ({
    id: "p1",
    name: "IT Printer",
    host: "192.0.2.13",
    port: 631,
    ippPath: "/ipp/printer",
    ippPathAuto: true,
    useTls: false,
    location: null,
    model: null,
    notes: null,
    revision: 1,
    legacyTakeover: "dry-run",
    legacyShares: [],
    legacyAliases: ["OLD-PRN-OFFICE2"],
    defaultSides: "auto",
    deviceUuid: null,
    driverMode: "auto",
    driverPackageId: null,
    driverName: null,
    vendorProtocol: "raw9100",
    lprQueue: null,
    autoVendorReason: null,
    autoVendorAt: null,
    deviceId: null,
    speedSamples: [],
    speedCheckedAt: null,
    macAddresses: [],
    identityCheckedAt: null,
    lastTestAt: null,
    lastTest: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });

  it("imports aliases from YAML and CSV", () => {
    const [y] = parseInput("- {name: IT Printer, host: 192.0.2.13, legacyAliases: [OLD-PRN-OFFICE2, old-it]}\n", "yaml");
    expect(y.legacyAliases).toEqual(["OLD-PRN-OFFICE2", "old-it"]);
    const [c] = parseInput("name,host,aliases\nIT Printer,192.0.2.13,OLD-PRN-OFFICE2;old-it\n", "csv");
    expect(c.legacyAliases).toEqual(["OLD-PRN-OFFICE2", "old-it"]);
  });

  it("an omitted IPP path keeps the detected one; a given path is a manual override", () => {
    const cur: CurrentState = { printers: [row()], assignments: [], ouSettings: [] };
    const auto = parseInput("- {name: IT Printer, host: 192.0.2.13, legacyTakeover: dry-run, legacyAliases: [OLD-PRN-OFFICE2]}\n", "yaml");
    expect(plan(auto, cur)[0].kind).toBe("unchanged");
    const manual = parseInput("- {name: IT Printer, host: 192.0.2.13, ippPath: /ipp, legacyTakeover: dry-run, legacyAliases: [OLD-PRN-OFFICE2]}\n", "yaml");
    expect(plan(manual, cur)[0]).toMatchObject({ kind: "update", changes: { ippPathAuto: false, ippPath: "/ipp" }, bumpRevision: true });
  });

  it("round-trips aliases and manual paths through export", () => {
    const cur: CurrentState = { printers: [row(), row({ id: "p2", name: "Manual", ippPath: "/printers/lp1", ippPathAuto: false, legacyAliases: [] })], assignments: [], ouSettings: [] };
    expect(exportYaml(cur)).toContain("legacyAliases");
    expect(exportYaml(cur)).toContain("ippPath: /printers/lp1");
    for (const [text, fmt] of [[exportYaml(cur), "yaml"], [exportCsv(cur), "csv"]] as const) {
      expect(plan(parseInput(text, fmt), cur).every((s) => s.kind === "unchanged")).toBe(true);
    }
  });
});
