import { describe, expect, it } from "vitest";
import { addDays, counterTotals, dayIn, daysBetween, pagesNotFromPcs, type CounterDay } from "@/lib/analytics/counters";
import { csvCell, filterParams, likeEscape, parseFilters } from "@/lib/analytics/filters";
import { JobsBatch, parentDn, toJobRows, type PrintEvent } from "@/lib/analytics/ingest";

const computer = { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "PC1", dn: "CN=PC1,OU=Finance,OU=Staff,DC=example,DC=org" };
const printers = [{ id: "11111111-1111-4111-8111-111111111111", name: "Finance Laser" }];
const ev = (over: Partial<PrintEvent> = {}): PrintEvent => ({
  recordId: 10,
  time: "2026-11-05T08:12:33.123Z",
  user: "EXAMPLE\\alice",
  userSid: "S-1-5-21-1-2-3-1001",
  clientComputer: "\\\\PC1",
  printer: "Finance Laser",
  port: "WSD-1234",
  portHost: "Printer1.example.org",
  pages: 3,
  bytes: 12345,
  document: "Budget 2027.xlsx",
  printerId: null,
  ...over,
});

describe("print job ingest", () => {
  it("validates agent batches", () => {
    expect(JobsBatch.safeParse({ events: [ev()] }).success).toBe(true);
    expect(JobsBatch.safeParse({ events: [ev({ time: "yesterday" })] }).success).toBe(false);
    expect(JobsBatch.safeParse({ events: [ev({ userSid: "not-a-sid" })] }).success).toBe(false);
    expect(JobsBatch.safeParse({ events: Array.from({ length: 501 }, (_, i) => ev({ recordId: i })) }).success).toBe(false);
  });

  it("maps managed queues by name, keeps unmanaged ones with their port host, drops document names unless enabled", () => {
    const rows = toJobRows([ev(), ev({ recordId: 11, printer: "Hand Installed HP", portHost: "192.0.2.99" })], {
      agentId: "a1",
      computer,
      printers,
      collectDocumentNames: false,
    });
    expect(rows[0]).toMatchObject({
      printerId: printers[0].id,
      ouDn: "OU=Finance,OU=Staff,DC=example,DC=org",
      clientComputer: "PC1",
      portHost: "printer1.example.org",
      documentName: null,
      pages: 3,
    });
    expect(rows[1]).toMatchObject({ printerId: null, queueName: "Hand Installed HP", portHost: "192.0.2.99" });
  });

  it("keeps document names when collection is on, and trusts only known printer ids", () => {
    const rows = toJobRows([ev({ printerId: "22222222-2222-4222-8222-222222222222", printer: "Renamed queue" })], {
      agentId: "a1",
      computer,
      printers,
      collectDocumentNames: true,
    });
    expect(rows[0].documentName).toBe("Budget 2027.xlsx");
    expect(rows[0].printerId).toBeNull();
  });

  it("drops duplicates within a batch (same record id and time)", () => {
    const rows = toJobRows([ev(), ev(), ev({ time: "2026-11-05T09:00:00Z" })], { agentId: "a1", computer, printers, collectDocumentNames: false });
    expect(rows).toHaveLength(2);
  });

  it("finds the parent OU of a DN with escaped commas", () => {
    expect(parentDn("CN=Smith\\, J,OU=HR,DC=example,DC=org")).toBe("OU=HR,DC=example,DC=org");
    expect(parentDn("DC=org")).toBeNull();
  });
});

describe("printer page counters", () => {
  const P = "p1";
  const row = (day: string, first: number, last: number, revision = 1): CounterDay => ({ printerId: P, day, revision, firstCount: first, lastCount: last });

  it("sums daily deltas from the last reading before the range", () => {
    const t = counterTotals([row("2026-11-01", 900, 1000), row("2026-11-02", 1010, 1100), row("2026-11-03", 1100, 1150)], "2026-11-02", "2026-11-03");
    expect(t.get(P)).toEqual({ pages: 150, days: 2 });
  });

  it("counts a first day without a baseline from its own first reading", () => {
    expect(counterTotals([row("2026-11-02", 500, 540)], "2026-11-01", "2026-11-05").get(P)?.pages).toBe(40);
  });

  it("restarts at a counter reset or a replaced device (new revision)", () => {
    const reset = counterTotals([row("2026-11-01", 900, 1000), row("2026-11-02", 5, 20)], "2026-11-02", "2026-11-02");
    expect(reset.get(P)?.pages).toBe(15);
    const replaced = counterTotals([row("2026-11-01", 900, 1000), row("2026-11-02", 2000, 2050, 2)], "2026-11-02", "2026-11-02");
    expect(replaced.get(P)?.pages).toBe(50);
  });

  it("ignores readings after the range and printers without readings in it", () => {
    const t = counterTotals([row("2026-10-01", 1, 2), row("2026-11-09", 10, 20)], "2026-11-01", "2026-11-05");
    expect(t.has(P)).toBe(false);
  });

  it("pages not from PCs never go negative", () => {
    expect(pagesNotFromPcs(150, 100)).toBe(50);
    expect(pagesNotFromPcs(100, 150)).toBe(0);
    expect(pagesNotFromPcs(null, 10)).toBeNull();
  });

  it("does calendar arithmetic and time zones", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(daysBetween("2026-11-01", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(dayIn("Indian/Maldives", new Date("2026-11-05T20:00:00Z"))).toBe("2026-11-06");
    expect(dayIn("UTC", new Date("2026-11-05T20:00:00Z"))).toBe("2026-11-05");
  });
});

describe("analytics filters", () => {
  it("defaults to the last 30 days and swaps reversed ranges", () => {
    expect(parseFilters({}, "2026-11-06")).toMatchObject({ from: "2026-10-08", to: "2026-11-06", user: null });
    expect(parseFilters({ from: "2026-11-05", to: "2026-11-01" }, "2026-11-06")).toMatchObject({ from: "2026-11-01", to: "2026-11-05" });
    expect(parseFilters({ from: "2026-02-30", user: " EXAMPLE\\bob " }, "2026-11-06")).toMatchObject({ from: "2026-10-08", user: "EXAMPLE\\bob" });
  });

  it("builds links with only the set filters", () => {
    const f = parseFilters({ from: "2026-11-01", to: "2026-11-02", printer: "queue:HP" }, "2026-11-06");
    expect(filterParams(f)).toBe("from=2026-11-01&to=2026-11-02&printer=queue%3AHP");
  });

  it("escapes LIKE wildcards and neutralises CSV formulas", () => {
    expect(likeEscape("OU=100%_x")).toBe("OU=100\\%\\_x");
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});
