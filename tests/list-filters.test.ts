import { describe, expect, it } from "vitest";
import type { AgentReport } from "@/lib/db/schema";
import { agentOuOptions, agentStates, filterAgents, parseAgentFilters, type AgentFilterRow } from "@/lib/list-filters/agents";
import { parseAuditFilters, activeAuditFilters, auditActionOptions } from "@/lib/list-filters/audit";
import {
  containerOptions,
  filterComputers,
  matchOuTree,
  parseOuTreeFilters,
  parseUnassignedFilters,
  visibleOuTree,
} from "@/lib/list-filters/directory";
import { countActive, day, flag, likeEscape, matchesWords, one, oneOf, pageNumber, toQuery, words } from "@/lib/list-filters/params";
import {
  activePrinterFilters,
  brandOptions,
  filterPrinters,
  parsePrinterFilters,
  printerBrand,
  printerHealth,
  type PrinterFilterRow,
} from "@/lib/list-filters/printers";

const W = "OU=Workstations,DC=example,DC=org";
const FIN = `OU=Finance,OU=Administration,${W}`;
const HR = `OU=HR,OU=Administration,${W}`;
const LAB = `OU=Science Lab,OU=Teaching,${W}`;

describe("query param parsing", () => {
  it("reads, trims and caps single values", () => {
    expect(one({ q: "  laser  " }, "q")).toBe("laser");
    expect(one({ q: ["a", "b"] }, "q")).toBe("a");
    expect(one({ q: "   " }, "q")).toBeNull();
    expect(one({}, "q")).toBeNull();
    expect(one({ q: "x".repeat(500) }, "q", 10)).toHaveLength(10);
  });

  it("accepts only allowed values, flags and real days", () => {
    expect(oneOf({ s: "on" }, "s", ["off", "on"] as const)).toBe("on");
    expect(oneOf({ s: "maybe" }, "s", ["off", "on"] as const)).toBeNull();
    expect(flag({ a: "1" }, "a")).toBe(true);
    expect(flag({ a: "true" }, "a")).toBe(true);
    expect(flag({ a: "0" }, "a")).toBe(false);
    expect(flag({}, "a")).toBe(false);
    expect(day({ d: "2026-11-08" }, "d")).toBe("2026-11-08");
    expect(day({ d: "2026-02-30" }, "d")).toBeNull();
    expect(day({ d: "08/11/2026" }, "d")).toBeNull();
    expect(pageNumber({ page: "3" })).toBe(3);
    expect(pageNumber({ page: "-2" })).toBe(1);
    expect(pageNumber({ page: "abc" })).toBe(1);
  });

  it("matches every search word in any field, case-insensitively", () => {
    expect(words("  Finance   LASER ")).toEqual(["finance", "laser"]);
    expect(matchesWords(words("finance laser"), ["Finance Laser", null])).toBe(true);
    expect(matchesWords(words("finance 192.0"), ["Finance Laser", "192.0.2.10"])).toBe(true);
    expect(matchesWords(words("finance hr"), ["Finance Laser"])).toBe(false);
    expect(matchesWords([], [])).toBe(true);
    expect(likeEscape("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("builds link query strings and counts active filters", () => {
    expect(toQuery({ q: "a b", low: true, ou: null, page: 2, x: "" })).toBe("?q=a+b&low=1&page=2");
    expect(toQuery({ q: null })).toBe("");
    expect(countActive({ q: "x", sort: "name", ou: "OU=A", low: false, brand: null, status: "online" })).toBe(2);
  });
});

const printer = (over: Partial<PrinterFilterRow> & { name: string }): PrinterFilterRow => ({
  host: "192.0.2.10",
  model: null,
  location: null,
  deviceId: null,
  legacyAliases: [],
  legacyShares: [],
  ouDns: [],
  legacyTakeover: "off",
  defaultSides: "auto",
  driverMode: "auto",
  status: null,
  ...over,
});
const ok = { online: true, stateReasons: ["none"], markers: [] };

describe("printer filters", () => {
  const rows = [
    printer({
      name: "Finance Laser",
      host: "192.0.2.21",
      model: "HP LaserJet Pro M404dn",
      location: "Floor 2",
      ouDns: [FIN],
      status: { ...ok, markers: [{ name: "Black Toner", color: "#000000", type: "toner", level: 5, low: true } as never] },
      legacyAliases: ["FIN-PRN-01"],
      defaultSides: "two-sided-long-edge",
    }),
    printer({ name: "Admin MFP", host: "192.0.2.20", model: "Brother MFC-L8900CDW", location: "Floor 1", ouDns: [HR], status: ok, legacyTakeover: "dry-run" }),
    printer({ name: "Lab Colour", host: "192.0.2.30", model: "Kyocera ECOSYS", status: { online: true, stateReasons: ["media-jam-error"], markers: [] }, driverMode: "vendor" }),
    printer({ name: "Library", host: "192.0.2.40", deviceId: "MFG:HEWLETT-PACKARD;MDL:Color LaserJet;", status: { online: false, stateReasons: [], markers: [] }, location: "Floor 1" }),
    printer({ name: "Kiosk", host: "192.0.2.50", legacyShares: ["KIOSK-Q"] }),
  ];
  const names = (sp: Record<string, string>) => filterPrinters(rows, parsePrinterFilters(sp)).map((p) => p.name);

  it("parses only known values and defaults the sort to name", () => {
    expect(parsePrinterFilters({ status: "broken", takeover: "dry-run", low: "1", sort: "weird" })).toMatchObject({
      status: null,
      takeover: "dry-run",
      low: true,
      sort: "name",
    });
    expect(activePrinterFilters(parsePrinterFilters({ q: "x", sort: "status" }))).toBe(0);
    expect(activePrinterFilters(parsePrinterFilters({ brand: "HP", unassigned: "1" }))).toBe(2);
  });

  it("derives brands and health", () => {
    expect(printerBrand("HP LaserJet Pro")).toBe("HP");
    expect(printerBrand("brother HL-L2350DW")).toBe("Brother");
    expect(printerBrand("Konica Minolta bizhub C300i")).toBe("Konica Minolta");
    expect(printerBrand("LaserJet", "MFG:Hewlett-Packard;MDL:X;")).toBe("HP");
    expect(printerBrand(null)).toBeNull();
    expect(brandOptions(rows)).toEqual(["Brother", "HP", "Kyocera"]);
    expect(printerHealth(null)).toBe("pending");
    expect(printerHealth(ok)).toBe("online");
    expect(printerHealth({ online: true, stateReasons: ["media-jam-error"], markers: [] })).toBe("error");
    expect(printerHealth({ online: false, stateReasons: [], markers: [] })).toBe("offline");
  });

  it("searches name, IP, model, location and aliases", () => {
    expect(names({ q: "finance" })).toEqual(["Finance Laser"]);
    expect(names({ q: "192.0.2.3" })).toEqual(["Lab Colour"]);
    expect(names({ q: "mfc-l8900" })).toEqual(["Admin MFP"]);
    expect(names({ q: "floor" })).toEqual(["Admin MFP", "Finance Laser", "Library"]);
    expect(names({ q: "fin-prn" })).toEqual(["Finance Laser"]);
    expect(names({ q: "kiosk-q" })).toEqual(["Kiosk"]);
  });

  it("filters by OU, brand, status, toner, assignment, takeover, duplex and driver mode", () => {
    expect(names({ ou: FIN.toLowerCase() })).toEqual(["Finance Laser"]);
    expect(names({ brand: "hp" })).toEqual(["Finance Laser", "Library"]);
    expect(names({ status: "online" })).toEqual(["Admin MFP", "Finance Laser"]);
    expect(names({ status: "offline" })).toEqual(["Library"]);
    expect(names({ status: "error" })).toEqual(["Lab Colour"]);
    expect(names({ low: "1" })).toEqual(["Finance Laser"]);
    expect(names({ unassigned: "1" })).toEqual(["Kiosk", "Lab Colour", "Library"]);
    expect(names({ takeover: "dry-run" })).toEqual(["Admin MFP"]);
    expect(names({ sides: "two-sided-long-edge" })).toEqual(["Finance Laser"]);
    expect(names({ driver: "vendor" })).toEqual(["Lab Colour"]);
    expect(names({ brand: "hp", status: "offline" })).toEqual(["Library"]);
  });

  it("sorts by name, location (empty last) and status (problems first)", () => {
    expect(names({})).toEqual(["Admin MFP", "Finance Laser", "Kiosk", "Lab Colour", "Library"]);
    expect(names({ sort: "location" })).toEqual(["Admin MFP", "Library", "Finance Laser", "Kiosk", "Lab Colour"]);
    expect(names({ sort: "status" })).toEqual(["Lab Colour", "Library", "Kiosk", "Admin MFP", "Finance Laser"]);
  });
});

const NOW = Date.parse("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000);
const agent = (computerName: string, dn: string, report: AgentReport | null, over: Partial<AgentFilterRow> = {}): AgentFilterRow => ({
  computerName,
  dn: `CN=${computerName},${dn}`,
  lastReportAt: hoursAgo(1),
  lastReport: report,
  revokedAt: null,
  ...over,
});

describe("agent filters", () => {
  const ctx = { staleBefore: NOW - 24 * 3600_000, latest: "0.7.0" };
  const rows = [
    agent("FIN-01", FIN, { agentVersion: "0.7.0", osVersion: "10.0.26100", errors: [] }),
    agent("FIN-02", FIN, { agentVersion: "0.6.3", osVersion: "10.0.22631", errors: ["Add-Printer failed"] }, { lastReportAt: hoursAgo(3) }),
    agent("HR-01", HR, { agentVersion: "0.7.0", osVersion: "10.0.26100", critical: ["PC left without printer HR Laser"], legacy: [] }),
    agent("LAB-01", LAB, { agentVersion: "0.7.0", osVersion: "10.0.26100", legacy: [{ printer: "Lab", queue: "Old Lab", reason: "same host", action: "would-remove", scope: "user:EXAMPLE\\bob" }] }, { lastReportAt: hoursAgo(30) }),
    agent("LAB-02", LAB, null, { lastReportAt: null }),
    agent("OLD-01", LAB, { agentVersion: "0.5.0" }, { revokedAt: hoursAgo(100) }),
  ];
  const names = (sp: Record<string, string>, users?: Map<string, string[]>) => filterAgents(rows, parseAgentFilters(sp), ctx, users).map((a) => a.computerName);

  it("works out every state of an agent", () => {
    expect([...agentStates(rows[0], ctx)]).toEqual(["ok"]);
    expect([...agentStates(rows[1], ctx)].sort()).toEqual(["error", "outdated"]);
    expect([...agentStates(rows[2], ctx)]).toEqual(["critical"]);
    expect([...agentStates(rows[3], ctx)].sort()).toEqual(["ok", "stale", "would-remove"]);
    expect([...agentStates(rows[4], ctx)]).toEqual(["stale"]);
    expect([...agentStates(rows[5], ctx)]).toEqual(["revoked"]);
  });

  it("searches computer names and users (print jobs, per-user legacy queues)", () => {
    expect(names({ q: "fin" })).toEqual(["FIN-01", "FIN-02"]);
    expect(names({ q: "bob" })).toEqual(["LAB-01"]);
    expect(names({ q: "alice" }, new Map([["hr-01", ["EXAMPLE\\alice"]]]))).toEqual(["HR-01"]);
  });

  it("filters by OU including child OUs, state, version and OS build", () => {
    expect(names({ ou: "OU=Administration,OU=Workstations,DC=example,DC=org" })).toEqual(["FIN-01", "HR-01", "FIN-02"]);
    expect(names({ ou: HR })).toEqual(["HR-01"]);
    expect(names({ state: "stale" })).toEqual(["LAB-01", "LAB-02"]);
    expect(names({ state: "outdated" })).toEqual(["FIN-02"]);
    expect(names({ state: "critical" })).toEqual(["HR-01"]);
    expect(names({ state: "would-remove" })).toEqual(["LAB-01"]);
    expect(names({ state: "error" })).toEqual(["FIN-02"]);
    expect(names({ state: "revoked" })).toEqual(["OLD-01"]);
    expect(names({ version: "0.6.3" })).toEqual(["FIN-02"]);
    expect(names({ os: "10.0.26100", ou: LAB })).toEqual(["LAB-01"]);
  });

  it("sorts by last seen (newest first by default) or name", () => {
    expect(names({})).toEqual(["FIN-01", "HR-01", "OLD-01", "FIN-02", "LAB-01", "LAB-02"]);
    expect(names({ sort: "seen-asc" })[0]).toBe("LAB-02");
    expect(names({ sort: "name" })).toEqual(["FIN-01", "FIN-02", "HR-01", "LAB-01", "LAB-02", "OLD-01"]);
  });

  it("offers each OU with its parents, top-down", () => {
    expect(agentOuOptions(rows)).toEqual([W, `OU=Administration,${W}`, FIN, HR, `OU=Teaching,${W}`, LAB]);
  });
});

describe("OU tree and unassigned PC filters", () => {
  const items = [
    { key: "dc=example,dc=org", label: "example.org", parentKey: null, count: 0 },
    { key: "ou=workstations,dc=example,dc=org", label: "Workstations", parentKey: "dc=example,dc=org", count: 1 },
    { key: "ou=finance,ou=workstations,dc=example,dc=org", label: "Finance", parentKey: "ou=workstations,dc=example,dc=org", count: 0 },
    { key: "ou=lab,ou=workstations,dc=example,dc=org", label: "Lab", parentKey: "ou=workstations,dc=example,dc=org", count: 2 },
  ];

  it("matches names, OUs with printers and OUs that get a printer, keeping ancestors", () => {
    expect(matchOuTree(items, parseOuTreeFilters({}))).toBeNull();
    const byName = matchOuTree(items, parseOuTreeFilters({ q: "fin" }));
    expect([...byName!]).toEqual(["ou=finance,ou=workstations,dc=example,dc=org"]);
    expect(visibleOuTree(items, byName).map((i) => i.label)).toEqual(["example.org", "Workstations", "Finance"]);
    expect([...matchOuTree(items, parseOuTreeFilters({ assigned: "1" }))!]).toHaveLength(2);
    const gets = matchOuTree(items, parseOuTreeFilters({ printer: "p1" }), (k) => k.startsWith("ou=lab"));
    expect(visibleOuTree(items, gets).map((i) => i.label)).toEqual(["example.org", "Workstations", "Lab"]);
  });

  it("filters computers by name/OS and OU subtree", () => {
    const pcs = [
      { name: "FIN-01", dn: `CN=FIN-01,${FIN}`, operatingSystem: "Windows 11 Pro" },
      { name: "HR-01", dn: `CN=HR-01,${HR}`, operatingSystem: "Windows 10 Pro" },
      { name: "NEW-PC", dn: "CN=NEW-PC,CN=Computers,DC=example,DC=org", operatingSystem: null },
    ];
    expect(filterComputers(pcs, parseUnassignedFilters({ q: "windows 10" })).map((c) => c.name)).toEqual(["HR-01"]);
    expect(filterComputers(pcs, parseUnassignedFilters({ ou: `OU=Administration,${W}` })).map((c) => c.name)).toEqual(["FIN-01", "HR-01"]);
    expect(filterComputers(pcs, parseUnassignedFilters({ ou: "CN=Computers,DC=example,DC=org" })).map((c) => c.name)).toEqual(["NEW-PC"]);
    expect(containerOptions(pcs)).toEqual(["CN=Computers,DC=example,DC=org", W, `OU=Administration,${W}`, FIN, HR]);
  });
});

describe("audit filter parsing", () => {
  it("swaps a reversed range and counts filters", () => {
    const f = parseAuditFilters({ from: "2026-11-08", to: "2026-11-01", actor: "admin@example.org", q: "laser", page: "2" });
    expect(f).toMatchObject({ from: "2026-11-01", to: "2026-11-08", actor: "admin@example.org", q: "laser", page: 2 });
    expect(activeAuditFilters(f)).toBe(2);
    expect(activeAuditFilters(parseAuditFilters({ q: "x" }))).toBe(0);
  });

  it("offers action families before single actions", () => {
    expect(auditActionOptions(["printer.update", "printer.create", "ou.assign"]).map((o) => o.value)).toEqual([
      "ou.*",
      "printer.*",
      "ou.assign",
      "printer.create",
      "printer.update",
    ]);
  });
});

describe("printer driver filter: resolved vendor and needed", () => {
  it("filters on the decision, not only the stored mode", async () => {
    const { filterPrinters, parsePrinterFilters } = await import("@/lib/list-filters/printers");
    const base = { host: "h", model: null, location: null, legacyAliases: [], legacyShares: [], ouDns: [], legacyTakeover: "off" as const, defaultSides: "auto" as const, status: null };
    const rows = [
      { ...base, name: "Auto vendor", driverMode: "auto" as const, resolvedDriver: "vendor" as const, driverNeeded: false },
      { ...base, name: "Auto needs one", driverMode: "auto" as const, resolvedDriver: "driverless" as const, driverNeeded: true },
      { ...base, name: "Manual vendor", driverMode: "vendor" as const, resolvedDriver: "vendor" as const, driverNeeded: false },
      { ...base, name: "Plain", driverMode: "auto" as const, resolvedDriver: "driverless" as const, driverNeeded: false },
    ];
    const names = (driver: string) => filterPrinters(rows, parsePrinterFilters({ driver })).map((r) => r.name);
    expect(names("resolved-vendor")).toEqual(["Auto vendor", "Manual vendor"]);
    expect(names("needed")).toEqual(["Auto needs one"]);
    expect(names("auto")).toEqual(["Auto needs one", "Auto vendor", "Plain"]);
    expect(parsePrinterFilters({ driver: "bogus" }).driver).toBeNull();
  });
});
