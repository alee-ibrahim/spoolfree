import { describe, expect, it } from "vitest";
import { exportYaml, parseDocument, planComputers, planOus, type CurrentState } from "@/lib/bulk";
import type { AgentReport, UnmanagedQueue } from "@/lib/db/schema";
import { filterAgents, parseAgentFilters } from "@/lib/list-filters/agents";
import { buildManifest, type ManifestPrinterInput } from "@/lib/manifest";
import { resolvePrinters } from "@/lib/resolve";
import {
  learnedUuids,
  matchesUnmanagedFilter,
  parseKeepList,
  resolveUnmanaged,
  serialsFromDeviceId,
  toManifestUnmanaged,
  unmanagedAuditEntries,
  unmanagedSummary,
  type OuUnmanagedSetting,
} from "@/lib/unmanaged";

const BASE = "DC=example,DC=org";
const STAFF = `OU=Staff,${BASE}`;
const DEPT = `OU=Department A,${STAFF}`;
const TEAM = `OU=Team 1,${DEPT}`;
const PC = { dn: `CN=PC1,${TEAM}`, objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e" };
const DEFAULT_KEEP = ["Microsoft Print to PDF"];

const ou = (ouDn: string, s: Partial<OuUnmanagedSetting>): OuUnmanagedSetting => ({ ouDn, removeUnmanaged: null, unmanagedKeep: null, keepLocalPrinters: null, ...s });

describe("resolveUnmanaged (inheritance)", () => {
  it("defaults to off, the server keep list and keeping USB/local printers", () => {
    const p = resolveUnmanaged({ baseDn: BASE, ouSettings: [], computer: PC, defaultKeep: DEFAULT_KEEP });
    expect(p).toEqual({ mode: "off", keep: DEFAULT_KEEP, keepLocal: true, from: { mode: "default", keep: "default", keepLocal: "default" } });
  });

  it("inherits each value separately down the OU tree; the nearest OU wins", () => {
    const p = resolveUnmanaged({
      baseDn: BASE,
      ouSettings: [
        ou(STAFF, { removeUnmanaged: "dry-run", unmanagedKeep: ["Microsoft Print to PDF", "Label*"] }),
        ou(DEPT, { removeUnmanaged: "on", keepLocalPrinters: false }),
        ou(TEAM, {}),
      ],
      computer: PC,
      defaultKeep: DEFAULT_KEEP,
    });
    expect(p.mode).toBe("on");
    expect(p.from.mode).toBe(DEPT);
    expect(p.keep).toEqual(["Microsoft Print to PDF", "Label*"]);
    expect(p.from.keep).toBe(STAFF);
    expect(p.keepLocal).toBe(false);
    expect(p.from.keepLocal).toBe(DEPT);
  });

  it("an empty keep list is a value (removes the inherited one)", () => {
    const p = resolveUnmanaged({ baseDn: BASE, ouSettings: [ou(TEAM, { unmanagedKeep: [] })], computer: PC, defaultKeep: DEFAULT_KEEP });
    expect(p.keep).toEqual([]);
  });

  it("matches OU DNs case-insensitively and ignores OUs outside the computer's chain", () => {
    const p = resolveUnmanaged({
      baseDn: BASE,
      ouSettings: [ou(DEPT.toUpperCase(), { removeUnmanaged: "on" }), ou(`OU=Other,${BASE}`, { removeUnmanaged: "dry-run", keepLocalPrinters: false })],
      computer: PC,
      defaultKeep: DEFAULT_KEEP,
    });
    expect(p.mode).toBe("on");
    expect(p.keepLocal).toBe(true);
  });

  it("the per-PC override wins over the OUs, for the mode and keep-local only", () => {
    const p = resolveUnmanaged({
      baseDn: BASE,
      ouSettings: [ou(DEPT, { removeUnmanaged: "on", unmanagedKeep: ["X"] })],
      computerSettings: [{ computerGuid: PC.objectGuid.toUpperCase(), removeUnmanaged: "off", keepLocalPrinters: false }],
      computer: PC,
      defaultKeep: DEFAULT_KEEP,
    });
    expect(p.mode).toBe("off");
    expect(p.from.mode).toBe("computer");
    expect(p.keepLocal).toBe(false);
    expect(p.keep).toEqual(["X"]);
  });

  it("an OU probe resolves what PCs directly in it get", () => {
    const p = resolveUnmanaged({ baseDn: BASE, ouSettings: [ou(STAFF, { removeUnmanaged: "dry-run" })], computer: { dn: `CN=__probe__,${DEPT}` }, defaultKeep: DEFAULT_KEEP });
    expect(p.mode).toBe("dry-run");
  });
});

describe("parseKeepList", () => {
  it("splits lines and semicolons, trims and drops duplicates", () => {
    expect(parseKeepList("Microsoft Print to PDF\n  label*  ; LABEL*\r\n\nGeneric Label Driver")).toEqual(["Microsoft Print to PDF", "label*", "Generic Label Driver"]);
    expect(parseKeepList(["a", " a ", "b"])).toEqual(["a", "b"]);
    expect(parseKeepList("")).toEqual([]);
  });
  it("rejects control characters, long entries and long lists", () => {
    expect(() => parseKeepList(["bad\u0007"])).toThrow(/control/);
    expect(() => parseKeepList(["x".repeat(201)])).toThrow(/longer/);
    expect(() => parseKeepList(Array.from({ length: 51 }, (_, i) => `q${i}`))).toThrow(/at most/);
  });
});

describe("serialsFromDeviceId", () => {
  it("reads SN / SERN fields of an IEEE 1284 device ID", () => {
    expect(serialsFromDeviceId("MFG:Acme;MDL:Office 500;SN:abc12345;CMD:PCL")).toEqual(["ABC12345"]);
    expect(serialsFromDeviceId("MFG:Acme;SERN:XY-0001-Z;")).toEqual(["XY-0001-Z"]);
    expect(serialsFromDeviceId("MFG:Acme;SN:12;")).toEqual([]);
    expect(serialsFromDeviceId(null)).toEqual([]);
  });
});

describe("manifest (0.9.0 fields)", () => {
  const OU = `OU=Staff,${BASE}`;
  const input: ManifestPrinterInput = {
    id: "p1",
    name: "Office Copier",
    host: "192.0.2.20",
    port: 631,
    ippPath: "/ipp/print",
    useTls: false,
    model: "Acme Office 500",
    location: null,
    revision: 1,
    legacyTakeover: "on",
    deviceUuid: "6A1B2C3D-0000-4000-8000-00000000AA01",
    extraUuids: ["6a1b2c3d-0000-4000-8000-00000000bb02", "6a1b2c3d-0000-4000-8000-00000000aa01", "junk"],
    deviceId: "MFG:Acme;SN:ABC12345;",
  };
  const res = resolvePrinters({ baseDn: BASE, assignments: [{ ouDn: OU, printerId: "p1" }], ouSettings: [], overrides: [] }, { dn: `CN=PC1,${OU}` });
  const build = (p: ManifestPrinterInput, unmanaged?: Parameters<typeof buildManifest>[0]["unmanaged"]) =>
    buildManifest({ resolution: res, printers: new Map([["p1", p]]), computer: { objectGuid: "g", dn: `CN=PC1,${OU}`, name: "PC1" }, now: new Date(0), ttlHours: 1, unmanaged });

  it("carries every device UUID and the serial numbers", () => {
    const m = build(input);
    expect(m.printers[0].deviceUuids).toEqual(["6a1b2c3d-0000-4000-8000-00000000aa01", "6a1b2c3d-0000-4000-8000-00000000bb02"]);
    expect(m.printers[0].serialNumbers).toEqual(["ABC12345"]);
  });
  it("sends serial numbers only with takeover on or dry-run; device UUIDs always", () => {
    const m = build({ ...input, legacyTakeover: "off" });
    expect(m.printers[0].serialNumbers).toEqual([]);
    expect(m.printers[0].deviceUuids?.length).toBe(2);
  });
  it("carries the unmanaged policy, off by default", () => {
    expect(build(input).unmanaged).toEqual({ mode: "off", keep: [], keepLocal: true });
    const policy = resolveUnmanaged({ baseDn: BASE, ouSettings: [ou(OU, { removeUnmanaged: "dry-run" })], computer: { dn: `CN=PC1,${OU}` }, defaultKeep: DEFAULT_KEEP });
    expect(build(input, toManifestUnmanaged(policy)).unmanaged).toEqual({ mode: "dry-run", keep: DEFAULT_KEEP, keepLocal: true });
  });
});

const u = (q: Partial<UnmanagedQueue>): UnmanagedQueue => ({ queue: "Q", scope: "machine", portKind: "tcpip", class: "other-network", action: "report", ...q });
const report = (unmanaged: UnmanagedQueue[]): AgentReport => ({ unmanaged });

describe("reports", () => {
  const rows = [
    { computerName: "PC1", dn: `CN=PC1,${TEAM}`, lastReport: report([u({ class: "virtual" }), u({ queue: "R", class: "legacy-of-managed", action: "removed" })]), lastReportAt: new Date(), revokedAt: null },
    { computerName: "PC2", dn: `CN=PC2,${TEAM}`, lastReport: report([u({ class: "other-network", action: "would-remove" }), u({ queue: "Q2", class: "other-network" })]), lastReportAt: new Date(), revokedAt: null },
    { computerName: "PC3", dn: `CN=PC3,${TEAM}`, lastReport: report([]), lastReportAt: new Date(), revokedAt: null },
    { computerName: "PC4", dn: `CN=PC4,${TEAM}`, lastReport: {} as AgentReport, lastReportAt: new Date(), revokedAt: null },
    { computerName: "PC5", dn: `CN=PC5,${TEAM}`, lastReport: report([u({ class: "virtual" })]), lastReportAt: new Date(), revokedAt: new Date() },
  ];

  it("summarises the fleet by class, without removed queues and revoked PCs", () => {
    const s = unmanagedSummary(rows);
    expect(s.reportingPcs).toBe(3);
    expect(s.pcs).toBe(2);
    expect(s.byClass.virtual).toEqual({ pcs: 1, queues: 1 });
    expect(s.byClass["other-network"]).toEqual({ pcs: 1, queues: 2 });
    expect(s.byClass["legacy-of-managed"]).toEqual({ pcs: 0, queues: 0 });
    expect(s.wouldRemovePcs).toBe(1);
    expect(s.removedPcs).toBe(1);
  });

  it("filters agents with the unmanaged filter", () => {
    const ctx = { staleBefore: 0, latest: null };
    const names = (unmanaged: string) => filterAgents(rows, parseAgentFilters({ unmanaged, sort: "name" }), ctx).map((a) => a.computerName);
    expect(names("any")).toEqual(["PC1", "PC2"]);
    expect(names("virtual")).toEqual(["PC1"]);
    expect(names("would-remove")).toEqual(["PC2"]);
    expect(names("removed")).toEqual(["PC1"]);
    expect(names("legacy-of-managed")).toEqual([]);
    expect(names("bogus")).toEqual(["PC1", "PC2", "PC3", "PC4", "PC5"]);
    expect(matchesUnmanagedFilter(null, "any")).toBe(false);
  });

  it("audits removals and failures only", () => {
    const e = unmanagedAuditEntries(report([u({ action: "removed", queue: "A" }), u({ action: "failed", queue: "B", error: "denied" }), u({ action: "kept" })]));
    expect(e.map((x) => x.action)).toEqual(["agent.unmanaged_removed", "agent.unmanaged_remove_failed"]);
    expect(e[1].details).toMatchObject({ queue: "B", error: "denied" });
  });
});

describe("learnedUuids", () => {
  const printers = [
    { name: "Office Copier", deviceUuid: "6a1b2c3d-0000-4000-8000-00000000aa01", extraUuids: [] as string[] },
    { name: "Other Laser", deviceUuid: "6a1b2c3d-0000-4000-8000-00000000cc03", extraUuids: [] as string[] },
  ];
  const WSD = "6a1b2c3d-0000-4000-8000-00000000bb02";

  it("learns WSD UUIDs of legacy queues matched by MAC or serial, and of the PC's own queue ports", () => {
    const r = learnedUuids(
      {
        queues: [{ name: "office copier", uuids: ["6A1B2C3D-0000-4000-8000-00000000AA01", "6a1b2c3d-0000-4000-8000-00000000ee05"] }],
        unmanaged: [u({ class: "legacy-of-managed", matchedPrinter: "Office Copier", matchBy: "mac", wsdUuid: WSD })],
      },
      printers,
    );
    expect(r.get("office copier")).toEqual(["6a1b2c3d-0000-4000-8000-00000000ee05", WSD]);
  });

  it("never learns from address or alias matches, or a UUID another printer has", () => {
    const r = learnedUuids(
      {
        unmanaged: [
          u({ matchedPrinter: "Office Copier", matchBy: "address", wsdUuid: WSD }),
          u({ matchedPrinter: "Office Copier", matchBy: "alias", wsdUuid: WSD }),
          u({ matchedPrinter: "Office Copier", matchBy: "uuid", wsdUuid: "6a1b2c3d-0000-4000-8000-00000000cc03" }),
          u({ matchedPrinter: "Unknown", matchBy: "mac", wsdUuid: WSD }),
        ],
      },
      printers,
    );
    expect(r.size).toBe(0);
  });

  it("stops at 8 UUIDs per printer", () => {
    const full = [{ ...printers[0], extraUuids: Array.from({ length: 8 }, (_, i) => `6a1b2c3d-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`) }];
    expect(learnedUuids({ unmanaged: [u({ matchedPrinter: "Office Copier", matchBy: "mac", wsdUuid: WSD })] }, full).size).toBe(0);
  });
});

describe("bulk CLI (ous: and computer settings)", () => {
  const state: CurrentState = {
    printers: [],
    assignments: [],
    ouSettings: [
      { ouDn: STAFF, defaultPrinterId: null, removeUnmanaged: "dry-run", unmanagedKeep: null, keepLocalPrinters: null },
      { ouDn: DEPT, defaultPrinterId: null, removeUnmanaged: null, unmanagedKeep: ["Microsoft Print to PDF"], keepLocalPrinters: false },
    ],
    computerSettings: [{ computerGuid: PC.objectGuid, computerName: "PC1", removeUnmanaged: "off", keepLocalPrinters: null }],
  };

  it("parses ous: entries ('inherit' clears a value, absent fields stay)", () => {
    const doc = parseDocument(
      `ous:\n  - dn: "${STAFF}"\n    removeUnmanaged: "on"\n  - dn: "${DEPT}"\n    unmanagedKeep: inherit\n    keepLocalPrinters: inherit\n`,
      "yaml",
    );
    expect(doc.ous[0]).toEqual({ dn: STAFF, removeUnmanaged: "on", unmanagedKeep: undefined, keepLocalPrinters: undefined });
    const steps = planOus(doc.ous, state);
    expect(steps.map((s) => s.kind)).toEqual(["ou-unmanaged", "ou-unmanaged"]);
    expect(steps[0]).toMatchObject({ changes: { removeUnmanaged: "on" } });
    expect(steps[1]).toMatchObject({ changes: { unmanagedKeep: null, keepLocalPrinters: null } });
  });

  it("is idempotent and rejects bad values", () => {
    const doc = parseDocument(`ous:\n  - dn: "${STAFF}"\n    removeUnmanaged: dry-run\n`, "yaml");
    expect(planOus(doc.ous, state).map((s) => s.kind)).toEqual(["unchanged"]);
    expect(() => parseDocument(`ous:\n  - dn: "${STAFF}"\n    removeUnmanaged: always\n`, "yaml")).toThrow(/ous entry 1/);
    expect(() => parseDocument(`ous:\n  - dn: "${STAFF}"\n    bogus: 1\n`, "yaml")).toThrow(/ous entry 1/);
  });

  it("sets per-PC overrides from computers: entries", () => {
    const doc = parseDocument(`computers:\n  - name: PC1\n    removeUnmanaged: inherit\n    keepLocalPrinters: false\n`, "yaml");
    const steps = planComputers(doc.computers, state, [{ objectGuid: PC.objectGuid, dn: PC.dn, name: "PC1" }]);
    expect(steps).toEqual([
      { kind: "computer-unmanaged", name: "computer PC1", computer: "PC1", computerGuid: PC.objectGuid, changes: { removeUnmanaged: null, keepLocalPrinters: false } },
    ]);
  });

  it("exports ous: and computer settings, and the export imports without changes", () => {
    const yaml = exportYaml(state);
    expect(yaml).toContain("ous:");
    expect(yaml).toContain("removeUnmanaged: dry-run");
    expect(yaml).toContain("keepLocalPrinters: false");
    const doc = parseDocument(yaml, "yaml");
    expect(planOus(doc.ous, state).every((s) => s.kind === "unchanged")).toBe(true);
    expect(planComputers(doc.computers, state, [{ objectGuid: PC.objectGuid, dn: PC.dn, name: "PC1" }]).map((s) => s.kind)).toEqual(["unchanged"]);
  });
});
