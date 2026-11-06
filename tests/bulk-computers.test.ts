import { describe as group, expect, it } from "vitest";
import { describe, exportCsv, exportYaml, parseDocument, planComputers, type CurrentState } from "@/lib/bulk";

const OU_A = "OU=Admin,OU=Workstations,DC=example,DC=org";
const OU_B = "OU=Lab,OU=Workstations,DC=example,DC=org";

const DIR = [
  { objectGuid: "AAAAAAAA-0000-4000-8000-000000000001", dn: `CN=LAB-PC1,${OU_B}`, name: "LAB-PC1" },
  { objectGuid: "aaaaaaaa-0000-4000-8000-000000000002", dn: `CN=LAB-PC2,${OU_B}`, name: "LAB-PC2" },
  { objectGuid: "aaaaaaaa-0000-4000-8000-000000000003", dn: `CN=TWIN,${OU_A}`, name: "TWIN" },
  { objectGuid: "aaaaaaaa-0000-4000-8000-000000000004", dn: `CN=TWIN,${OU_B}`, name: "TWIN" },
];
const GUID1 = "aaaaaaaa-0000-4000-8000-000000000001";

function printerRow(over: Partial<CurrentState["printers"][number]> = {}): CurrentState["printers"][number] {
  return {
    id: "p1",
    name: "Staff Room Copier",
    host: "192.0.2.10",
    port: 631,
    ippPath: "/ipp/print",
    useTls: false,
    location: null,
    model: null,
    notes: null,
    revision: 1,
    legacyTakeover: "off",
    legacyShares: [],
    defaultSides: "auto",
    deviceUuid: null,
    macAddresses: [],
    identityCheckedAt: null,
    lastTestAt: null,
    lastTest: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

const DOC = [
  "printers:",
  "  - name: Staff Room Copier",
  "    ip: 192.0.2.10",
  "computers:",
  "  - name: lab-pc1",
  "    add: [Staff Room Copier]",
  `  - dn: "CN=LAB-PC2,${OU_B}"`,
  "    block: Staff Room Copier",
  "  - name: TWIN",
  `    dn: "CN=TWIN,${OU_A}"`,
  "    default: New Printer",
  "",
].join("\n");

const empty: CurrentState = { printers: [], assignments: [], ouSettings: [] };
const computers = (lines: string[]) => parseDocument(["computers:", ...lines, ""].join("\n"), "yaml").computers;

group("computers: parsing", () => {
  it("reads computers by name or DN with add, block and default", () => {
    const d = parseDocument(DOC, "yaml");
    expect(d.printers).toHaveLength(1);
    expect(d.computers).toEqual([
      { name: "lab-pc1", add: ["Staff Room Copier"], block: [], default: null },
      { dn: `CN=LAB-PC2,${OU_B}`, add: [], block: ["Staff Room Copier"], default: null },
      { name: "TWIN", dn: `CN=TWIN,${OU_A}`, add: [], block: [], default: "New Printer" },
    ]);
    expect(parseDocument("- {name: A, host: a.example.org}\n", "yaml").computers).toEqual([]);
  });

  it("rejects invalid entries", () => {
    expect(() => computers(["  - add: [X]"])).toThrow(/computers entry 1.*name or dn/);
    expect(() => computers(["  - {name: PC1, add: [X], block: [x]}"])).toThrow(/both added and blocked/);
    expect(() => computers(["  - {name: PC1, default: X, block: [X]}"])).toThrow(/both added and blocked/);
    expect(() => computers(["  - {name: PC1, add: [X, x]}"])).toThrow(/listed twice/);
    expect(() => computers(["  - {name: PC1, remove: [X]}"])).toThrow(/unrecognized/i);
    expect(() => computers(["  - {name: 'EXAMPLE\\PC1'}"])).toThrow(/computer name/);
    expect(() => computers([`  - {dn: '${OU_A}'}`])).toThrow(/computer distinguished name/);
    expect(() => computers(["  - {name: PC1}", "  - {name: pc1}"])).toThrow(/duplicate computer/);
    expect(() => parseDocument("computers: {name: PC1}\n", "yaml")).toThrow(/must be a list/);
  });
});

group("computers: planning", () => {
  it("resolves computers in the directory and printers created by the same file", () => {
    const d = parseDocument(DOC, "yaml");
    const steps = planComputers(d.computers, { ...empty, printers: [printerRow()] }, DIR, { newPrinters: ["New Printer"] });
    expect(steps.map(describe)).toEqual([
      "add      LAB-PC1: Staff Room Copier",
      "block    LAB-PC2: Staff Room Copier",
      "add      TWIN: New Printer (default)",
    ]);
    expect(steps[0]).toMatchObject({ computerGuid: GUID1, action: "add", makeDefault: false });
    expect(steps[2]).toMatchObject({ computerGuid: "aaaaaaaa-0000-4000-8000-000000000003", makeDefault: true });
  });

  it("refuses unknown or ambiguous computers and unknown printers", () => {
    const cur: CurrentState = { ...empty, printers: [printerRow()] };
    expect(() => planComputers(computers(["  - {name: NOPE, add: [Staff Room Copier]}"]), cur, DIR)).toThrow(/not found in the directory/);
    expect(() => planComputers(computers(["  - {name: TWIN, add: [Staff Room Copier]}"]), cur, DIR)).toThrow(/2 computers have this name; use dn/);
    expect(() => planComputers(computers([`  - {name: LAB-PC1, dn: "CN=LAB-PC2,${OU_B}"}`]), cur, DIR)).toThrow(/does not match/);
    expect(() => planComputers(computers(["  - {name: LAB-PC1, add: [Ghost]}"]), cur, DIR)).toThrow(/unknown printer "Ghost"/);
    expect(() => planComputers(computers(["  - {name: LAB-PC1}", `  - {dn: "CN=LAB-PC1,${OU_B}"}`]), cur, DIR)).toThrow(/listed twice/);
  });

  it("is idempotent, updates changed overrides and prunes only on request", () => {
    const cur: CurrentState = {
      ...empty,
      printers: [printerRow(), printerRow({ id: "p2", name: "Lab Printer" })],
      overrides: [
        { computerGuid: GUID1, computerName: "LAB-PC1", printerId: "p1", action: "add", makeDefault: false },
        { computerGuid: GUID1, computerName: "LAB-PC1", printerId: "p2", action: "block", makeDefault: false },
      ],
    };
    const same = computers(["  - {name: LAB-PC1, add: [Staff Room Copier], block: [Lab Printer]}"]);
    expect(planComputers(same, cur, DIR, { pruneOverrides: true }).map(describe)).toEqual(["ok       computer LAB-PC1"]);

    const changed = computers(["  - {name: LAB-PC1, default: Staff Room Copier}"]);
    expect(planComputers(changed, cur, DIR).map(describe)).toEqual(["add      LAB-PC1: Staff Room Copier (default) (was: add)"]);
    expect(planComputers(changed, cur, DIR, { pruneOverrides: true }).map(describe)).toEqual([
      "add      LAB-PC1: Staff Room Copier (default) (was: add)",
      "unset    LAB-PC1: Lab Printer",
    ]);
    // Other computers' overrides are never pruned.
    const other = computers(["  - {name: LAB-PC2, add: [Lab Printer]}"]);
    expect(planComputers(other, cur, DIR, { pruneOverrides: true }).map(describe)).toEqual(["add      LAB-PC2: Lab Printer"]);
  });
});

group("computers: export", () => {
  const cur: CurrentState = {
    ...empty,
    printers: [printerRow(), printerRow({ id: "p2", name: "Lab Printer" })],
    overrides: [
      { computerGuid: GUID1, computerName: "LAB-PC1", printerId: "p1", action: "add", makeDefault: true },
      { computerGuid: GUID1, computerName: "LAB-PC1", printerId: "p2", action: "block", makeDefault: false },
    ],
  };

  it("exports overrides by computer name and round-trips", () => {
    const yaml = exportYaml(cur);
    expect(yaml).toContain("computers:");
    const d = parseDocument(yaml, "yaml");
    expect(d.computers).toEqual([{ name: "LAB-PC1", add: [], block: ["Lab Printer"], default: "Staff Room Copier" }]);
    expect(planComputers(d.computers, cur, DIR, { pruneOverrides: true }).every((s) => s.kind === "unchanged")).toBe(true);
  });

  it("omits computers: without overrides; CSV never carries them", () => {
    expect(exportYaml({ ...cur, overrides: [] })).not.toContain("computers:");
    expect(parseDocument(exportCsv(cur), "csv").computers).toEqual([]);
  });
});
