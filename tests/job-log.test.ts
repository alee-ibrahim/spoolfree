import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SQL } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { filterParams, parseFilters, type AnalyticsFilters } from "@/lib/analytics/filters";
import { jobLogCountQuery, jobLogQuery, printerJobOptionsQuery, toJobLogRow } from "@/lib/analytics/job-log";
import * as schema from "@/lib/db/schema";

/* Analytics job log: PC jobs (print_jobs) and printer jobs (printer_jobs) as one filtered, paged list (PGlite + migrations). */

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const TZ = "Indian/Maldives";

beforeAll(async () => {
  d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  await d.insert(schema.printers).values([
    { id: P1, name: "Finance Laser", host: "192.0.2.10" },
    { id: P2, name: "HR Colour", host: "192.0.2.11" },
  ] as (typeof schema.printers.$inferInsert)[]);
  const job = (recordId: number, printerId: string | null, queueName: string, printedAt: string, userName: string | null, documentName: string | null, pages: number | null) => ({
    computerGuid: "g1",
    computerName: "FIN-01",
    ouDn: "OU=Finance,DC=example,DC=org",
    recordId,
    printedAt: new Date(printedAt),
    userName,
    queueName,
    printerId,
    pages,
    documentName,
  });
  await d.insert(schema.printJobs).values([
    job(1, P1, "Finance Laser", "2026-11-05T08:00:00Z", "EXAMPLE\\alice", "Budget 2027.xlsx", 3),
    job(2, null, "Hand Installed HP", "2026-11-05T09:00:00Z", "EXAMPLE\\bob", null, null),
    job(3, P2, "HR Colour", "2026-11-06T09:00:00Z", "EXAMPLE\\carol", "Leave form.pdf", 1),
  ]);
  const pj = (printerId: string, jobId: number, owner: string | null, completedAt: string, extra: Partial<typeof schema.printerJobs.$inferInsert> = {}) => ({
    printerId,
    jobId,
    createdRaw: jobId,
    owner,
    state: "completed" as const,
    completedAt: new Date(completedAt),
    seenAt: new Date(completedAt),
    ...extra,
  });
  await d.insert(schema.printerJobs).values([
    // The printer's copy of PC job 1 (bare user name, 2 minutes later): not listed again.
    pj(P1, 10, "alice", "2026-11-05T08:02:00Z", { pages: 3 }),
    // A copy at the device and a USB print: only the printer knows these.
    pj(P1, 11, "alice", "2026-11-05T11:00:00Z", { pages: 20, name: "Scan copy" }),
    pj(P2, 12, "", "2026-11-06T07:00:00Z", { pages: 4, state: "canceled" }),
    // Outside the range.
    pj(P2, 13, "dave", "2026-10-01T07:00:00Z"),
  ]);
});

const base: AnalyticsFilters = { from: "2026-11-01", to: "2026-11-07", user: null, printer: null, ou: null, computer: null, q: null, source: null };

async function rows(q: SQL) {
  return (await d.execute<Record<string, unknown>>(q)).rows;
}
async function list(f: Partial<AnalyticsFilters> = {}, limit = 50, offset = 0) {
  return (await rows(jobLogQuery({ ...base, ...f }, TZ, limit, offset))).map(toJobLogRow);
}
async function count(f: Partial<AnalyticsFilters> = {}) {
  return Number((await rows(jobLogCountQuery({ ...base, ...f }, TZ)))[0].c);
}

describe("job log (SQL)", () => {
  it("merges PC and printer jobs newest first, without the printer's copy of a PC job", async () => {
    const all = await list();
    expect(all.map((j) => [j.source, j.printer, j.userName, j.pages])).toEqual([
      ["pc", "HR Colour", "EXAMPLE\\carol", 1],
      ["printer", "HR Colour", null, 4],
      ["printer", "Finance Laser", "alice", 20],
      ["pc", "Hand Installed HP", "EXAMPLE\\bob", null],
      ["pc", "Finance Laser", "EXAMPLE\\alice", 3],
    ]);
    expect(await count()).toBe(5);
    expect(all[1]).toMatchObject({ state: "canceled", computerName: null, ouDn: null, queueName: null, bytes: null });
    expect(all[2]).toMatchObject({ documentName: "Scan copy", printerId: P1, printedAt: "2026-11-05T11:00:00.000Z" });
  });

  it("filters by source", async () => {
    expect((await list({ source: "pc" })).every((j) => j.source === "pc")).toBe(true);
    expect(await count({ source: "pc" })).toBe(3);
    expect(await count({ source: "printer" })).toBe(2);
  });

  it("applies printer, user (domain-insensitive for printer jobs), search and date range to both sources", async () => {
    expect((await list({ printer: P1 })).map((j) => j.source)).toEqual(["printer", "pc"]);
    expect((await list({ user: "EXAMPLE\\alice" })).map((j) => j.source)).toEqual(["printer", "pc"]);
    expect((await list({ q: "scan" })).map((j) => j.documentName)).toEqual(["Scan copy"]);
    expect((await list({ from: "2026-11-06", to: "2026-11-06" })).map((j) => j.source)).toEqual(["pc", "printer"]);
    expect(await count({ from: "2026-10-01", to: "2026-10-01" })).toBe(1);
    expect(await list({ q: "100%" })).toEqual([]);
  });

  it("drops printer jobs for PC, OU and unmanaged-queue filters (they have none)", async () => {
    expect((await list({ computer: "FIN-01" })).every((j) => j.source === "pc")).toBe(true);
    expect((await list({ ou: "DC=example,DC=org" })).every((j) => j.source === "pc")).toBe(true);
    expect((await list({ printer: "queue:Hand Installed HP" })).map((j) => j.userName)).toEqual(["EXAMPLE\\bob"]);
    expect(await count({ computer: "FIN-01", source: "printer" })).toBe(0);
    expect(await list({ computer: "FIN-01", source: "printer" })).toEqual([]);
  });

  it("pages with limit and offset across both sources", async () => {
    expect((await list({}, 2, 1)).map((j) => j.source)).toEqual(["printer", "printer"]);
  });

  it("offers printer job users and printers in the range as filter choices", async () => {
    expect((await rows(printerJobOptionsQuery(base, TZ, "users"))).map((r) => r.v)).toEqual(["alice"]);
    expect((await rows(printerJobOptionsQuery(base, TZ, "printers"))).map((r) => [r.v, r.label])).toEqual([
      [P1, "Finance Laser"],
      [P2, "HR Colour"],
    ]);
  });
});

describe("job log filters", () => {
  it("parses the source and keeps it in links; unknown sources are ignored", () => {
    const f = parseFilters({ from: "2026-11-01", to: "2026-11-02", source: "printer" }, "2026-11-06");
    expect(f.source).toBe("printer");
    expect(filterParams(f)).toBe("from=2026-11-01&to=2026-11-02&source=printer");
    expect(parseFilters({ source: "usb" }, "2026-11-06").source).toBeNull();
  });
});
