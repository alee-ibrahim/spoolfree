import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SQL } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  activeRecentJobFilters,
  parseRecentJobFilters,
  recentJobPrintersQuery,
  recentJobsCountQuery,
  recentJobsQuery,
  stateTone,
  toRecentJob,
  type RecentJobFilters,
} from "@/lib/recent-jobs";

/* Recent jobs view: PC job reports and test prints merged from Spoolfree's own tables (PGlite + migrations). */

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

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
  await d.insert(schema.testPrints).values([
    {
      printerId: P1,
      printerName: "Finance Laser",
      mode: "direct",
      requestedBy: "admin@example.org",
      state: "failed",
      createdAt: new Date("2026-11-05T10:00:00Z"),
      completedAt: new Date("2026-11-05T10:00:05Z"),
      jobId: 42,
      error: "media-jam",
    },
    { printerId: P2, printerName: "HR Colour", mode: "pc", computerName: "HR-02", requestedBy: "admin@example.org", state: "queued", createdAt: new Date("2026-11-07T10:00:00Z") },
  ]);
});

const none: Omit<RecentJobFilters, "page"> = { printer: null, state: null, source: null, q: null };

async function rows(q: SQL) {
  return (await d.execute<Record<string, unknown>>(q)).rows;
}
async function list(f: Partial<RecentJobFilters> = {}, limit = 50, offset = 0) {
  return (await rows(recentJobsQuery({ ...none, ...f }, limit, offset))).map(toRecentJob);
}
async function count(f: Partial<RecentJobFilters> = {}) {
  return Number((await rows(recentJobsCountQuery({ ...none, ...f })))[0].c);
}

describe("recent jobs (SQL)", () => {
  it("merges PC jobs and test prints from all printers, newest first", async () => {
    const all = await list();
    expect(all.map((j) => [j.source, j.printer, j.state])).toEqual([
      ["test", "HR Colour", "queued"],
      ["pc", "HR Colour", "printed"],
      ["test", "Finance Laser", "failed"],
      ["pc", "Hand Installed HP", "printed"],
      ["pc", "Finance Laser", "printed"],
    ]);
    expect(await count()).toBe(5);
  });

  it("maps the columns the view shows", async () => {
    const [queued, leave, failed, unmanaged] = await list();
    expect(leave).toMatchObject({ name: "Leave form.pdf", owner: "EXAMPLE\\carol", computer: "FIN-01", pages: 1, jobRef: "3", submittedAt: null, completedAt: "2026-11-06T09:00:00.000Z" });
    expect(failed).toMatchObject({ name: "Test page", owner: "admin@example.org", jobRef: "42", message: "media-jam", submittedAt: "2026-11-05T10:00:00.000Z", completedAt: "2026-11-05T10:00:05.000Z" });
    expect(queued).toMatchObject({ computer: "HR-02", completedAt: null, pages: null });
    expect(unmanaged).toMatchObject({ printerId: null, name: null, pages: null });
  });

  it("filters by printer (managed or unmanaged queue), state, source and search words", async () => {
    expect((await list({ printer: P1 })).map((j) => j.source)).toEqual(["test", "pc"]);
    expect((await list({ printer: "queue:Hand Installed HP" })).map((j) => j.owner)).toEqual(["EXAMPLE\\bob"]);
    expect((await list({ state: "printed" })).length).toBe(3);
    expect((await list({ state: "failed" })).map((j) => j.printer)).toEqual(["Finance Laser"]);
    expect((await list({ source: "test" })).length).toBe(2);
    expect((await list({ q: "budget" })).map((j) => j.name)).toEqual(["Budget 2027.xlsx"]);
    expect((await list({ q: "hr-02" })).map((j) => j.state)).toEqual(["queued"]);
    expect(await list({ q: "100%" })).toEqual([]);
    expect(await count({ printer: P2, state: "printed" })).toBe(1);
  });

  it("pages with limit and offset", async () => {
    expect((await list({}, 2, 2)).map((j) => j.state)).toEqual(["failed", "printed"]);
  });

  it("offers printers that have jobs, unmanaged queues marked", async () => {
    const opts = await rows(recentJobPrintersQuery());
    expect(opts.map((r) => [r.v, r.label])).toEqual([
      [P1, "Finance Laser"],
      ["queue:Hand Installed HP", "Hand Installed HP (unmanaged)"],
      [P2, "HR Colour"],
    ]);
  });
});

describe("recent jobs filters", () => {
  it("parses URL params and ignores unknown states and sources", () => {
    expect(parseRecentJobFilters({ printer: P1, state: "printed", source: "pc", q: " alice ", page: "2" })).toEqual({ printer: P1, state: "printed", source: "pc", q: "alice", page: 2 });
    expect(parseRecentJobFilters({ state: "deleted", source: "usb" })).toEqual({ printer: null, state: null, source: null, q: null, page: 1 });
    expect(activeRecentJobFilters(parseRecentJobFilters({ printer: P1, state: "failed", q: "x" }))).toBe(2);
  });

  it("gives printed, failed, in-progress and unknown states their own badge look", () => {
    expect(stateTone("printed")).toBe("default");
    expect(stateTone("rejected")).toBe("destructive");
    expect(stateTone("printing")).toBe("secondary");
    expect(stateTone("unknown")).toBe("outline");
  });
});
