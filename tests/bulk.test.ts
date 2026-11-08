import { describe as group, expect, it } from "vitest";
import { describe, exportCsv, exportYaml, parseCsv, parseInput, plan, type CurrentState } from "@/lib/bulk";

const OU_A = "OU=Admin,OU=Workstations,DC=example,DC=org";
const OU_B = "OU=Lab,OU=Workstations,DC=example,DC=org";

const YAML = `
printers:
  - name: Staff Room Copier
    ip: 192.0.2.10
    location: Block A
    defaultSides: two-sided-long-edge
    legacyTakeover: dry-run
    legacyShares: [StaffRoom, StaffRoom2]
    assignments: ["${OU_A}"]
    defaultFor: ["${OU_A}"]
  - name: Lab Printer
    host: lab-printer.example.org
    useTls: true
    port: 443
`;

function printerRow(over: Partial<CurrentState["printers"][number]> = {}): CurrentState["printers"][number] {
  return {
    id: "p1",
    name: "Staff Room Copier",
    host: "192.0.2.10",
    port: 631,
    ippPath: "/ipp/print",
    ippPathAuto: true,
    useTls: false,
    location: "Block A",
    model: null,
    notes: null,
    revision: 3,
    legacyTakeover: "dry-run",
    legacyShares: ["StaffRoom", "StaffRoom2"],
    defaultSides: "two-sided-long-edge",
    legacyAliases: [],
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
  };
}

group("bulk import parsing", () => {
  it("reads YAML with ip/host aliases and defaults", () => {
    const [a, b] = parseInput(YAML, "yaml");
    expect(a).toMatchObject({ name: "Staff Room Copier", host: "192.0.2.10", port: 631, ippPathAuto: true, useTls: false, defaultSides: "two-sided-long-edge", legacyTakeover: "dry-run", legacyShares: ["StaffRoom", "StaffRoom2"], assignments: [OU_A], defaultFor: [OU_A] });
    expect(b).toMatchObject({ host: "lab-printer.example.org", useTls: true, port: 443, defaultSides: "auto", legacyTakeover: "off", assignments: [] });
  });

  it("reads CSV with quoted DNs and ;-separated lists", () => {
    const csv = `name,ip,location,duplex,takeover,shares,assignments,default_for\r\nCopier,192.0.2.10,"Block A, level 1",one-sided,on,S1;S2,"${OU_A};${OU_B}","${OU_B}"\r\n`;
    const [p] = parseInput(csv, "csv");
    expect(p).toMatchObject({ location: "Block A, level 1", defaultSides: "one-sided", legacyTakeover: "on", legacyShares: ["S1", "S2"], assignments: [OU_A, OU_B], defaultFor: [OU_B] });
    expect(parseCsv('a,"b ""q""",c\n')).toEqual([["a", 'b "q"', "c"]]);
  });

  it("rejects bad input with the entry named", () => {
    expect(() => parseInput("printers:\n  - name: X\n", "yaml")).toThrow(/entry 1 \(X\).*host/);
    expect(() => parseInput("printers:\n  - {name: X, host: 'bad host!'}\n", "yaml")).toThrow(/not a valid hostname/);
    expect(() => parseInput("- {name: A, host: a.example.org}\n- {name: a, host: b.example.org}\n", "yaml")).toThrow(/duplicate/);
    expect(() => parseInput("- {name: A, host: a.example.org, defaultSides: duplex}\n", "yaml")).toThrow();
    expect(() => parseInput("- {name: A, host: a.example.org, legacyShares: ['\\\\\\\\srv\\\\x']}\n", "yaml")).toThrow(/share names only/);
    expect(() => parseInput("nope,cols\n1,2\n", "csv")).toThrow(/unknown CSV column/);
  });
});

group("bulk import planning", () => {
  const specs = parseInput(YAML, "yaml");

  it("creates everything on an empty database", () => {
    const steps = plan(specs, { printers: [], assignments: [], ouSettings: [] });
    expect(steps.map(describe)).toEqual([
      "create   Staff Room Copier (192.0.2.10)",
      `assign   Staff Room Copier -> ${OU_A}`,
      `default  ${OU_A}: (none) -> Staff Room Copier`,
      "create   Lab Printer (lab-printer.example.org)",
    ]);
  });

  it("is idempotent", () => {
    const cur: CurrentState = {
      printers: [printerRow(), printerRow({ id: "p2", name: "Lab Printer", host: "lab-printer.example.org", useTls: true, port: 443, location: null, legacyTakeover: "off", legacyShares: [], defaultSides: "auto" })],
      assignments: [{ ouDn: OU_A.toLowerCase(), printerId: "p1" }],
      ouSettings: [{ ouDn: OU_A, defaultPrinterId: "p1" }],
    };
    expect(plan(specs, cur).every((s) => s.kind === "unchanged")).toBe(true);
  });

  it("updates changed fields, bumps the revision only for endpoint changes, prunes on request", () => {
    const cur: CurrentState = {
      printers: [printerRow({ host: "192.0.2.99", location: "Old" })],
      assignments: [{ ouDn: OU_B, printerId: "p1" }],
      ouSettings: [{ ouDn: OU_A, defaultPrinterId: "other" }],
    };
    const steps = plan([specs[0]], cur, { pruneAssignments: true });
    const upd = steps.find((s) => s.kind === "update");
    expect(upd).toMatchObject({ changes: { host: "192.0.2.10", location: "Block A" }, bumpRevision: true });
    expect(steps.map((s) => s.kind)).toEqual(["update", "assign", "unassign", "default"]);
    const onlyLocation = plan([specs[0]], { ...cur, printers: [printerRow({ location: "Old" })] });
    expect(onlyLocation[0]).toMatchObject({ kind: "update", bumpRevision: false });
  });
});

group("bulk export", () => {
  const cur: CurrentState = { printers: [printerRow()], assignments: [{ ouDn: OU_A, printerId: "p1" }], ouSettings: [{ ouDn: OU_A, defaultPrinterId: "p1" }] };
  it("round-trips through YAML and CSV", () => {
    for (const [text, fmt] of [[exportYaml(cur), "yaml"], [exportCsv(cur), "csv"]] as const) {
      const again = parseInput(text, fmt);
      expect(plan(again, cur).every((s) => s.kind === "unchanged")).toBe(true);
    }
  });
});
