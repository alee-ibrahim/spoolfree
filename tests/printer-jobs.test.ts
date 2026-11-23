import path from "node:path";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { IppHttpError, IppStatusError } from "@/lib/ipp/client";
import type { IppValue } from "@/lib/ipp/encoding";
import { statusFromIpp } from "@/lib/ipp/interpret";
import { jobAttributes, jobsDue, jobTime, pollPrinterJobs, purgePrinterJobs, toPrinterJobs, unsupportedReason } from "@/lib/status/jobs";
import { pollAll } from "@/lib/status/poller";
import { recentJobsQuery, toRecentJob, type RecentJobFilters } from "@/lib/recent-jobs";
import { SIMS, startSim } from "../scripts/fake-printers";

/* Printer job list (PRINTER_JOBS_POLL): Get-Jobs inside the status poll, stored with dedupe, merged into Recent jobs. */

const pg = vi.hoisted(() => {
  process.env.ANALYTICS_COLLECT_DOCUMENT_NAMES = "1";
  process.env.POLL_TIMEOUT_MS = "2000";
  return { db: null as unknown };
});
vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;
const NOW = new Date("2026-11-20T10:00:00Z");

describe("printer job list (pure)", () => {
  it("asks only for the minimal attributes; job-name only with document names, speed attributes only when due", () => {
    expect(jobAttributes({ names: false, speed: false })).toEqual([
      "job-id",
      "job-originating-user-name",
      "job-state",
      "job-impressions-completed",
      "time-at-creation",
      "time-at-completed",
    ]);
    expect(jobAttributes({ names: true, speed: true })).toEqual(expect.arrayContaining(["job-name", "time-at-processing", "job-media-sheets-completed"]));
  });

  it("is due only for online IPP printers that have not refused Get-Jobs at this revision", () => {
    const ipp = { online: true, source: "ipp" as const };
    expect(jobsDue({ revision: 2, jobsUnsupportedRevision: null }, ipp, true)).toBe(true);
    expect(jobsDue({ revision: 2, jobsUnsupportedRevision: 2 }, ipp, true)).toBe(false);
    expect(jobsDue({ revision: 3, jobsUnsupportedRevision: 2 }, ipp, true)).toBe(true);
    expect(jobsDue({ revision: 2, jobsUnsupportedRevision: null }, { online: true, source: "snmp" }, true)).toBe(false);
    expect(jobsDue({ revision: 2, jobsUnsupportedRevision: null }, { online: false, source: "none" }, true)).toBe(false);
    expect(jobsDue({ revision: 2, jobsUnsupportedRevision: null }, ipp, false)).toBe(false);
  });

  it("remembers refusals (operation not supported, auth, HTTP 4xx) but not transient errors", () => {
    expect(unsupportedReason(new IppStatusError(0x0501, "IPP status 0x0501"))).toBe("IPP status 0x0501");
    expect(unsupportedReason(new IppStatusError(0x0403, "IPP status 0x0403"))).toBeTruthy();
    expect(unsupportedReason(new IppHttpError(401, "HTTP 401"))).toBe("HTTP 401");
    expect(unsupportedReason(new IppStatusError(0x0502, "busy"))).toBeNull();
    expect(unsupportedReason(new IppHttpError(503, "HTTP 503"))).toBeNull();
    expect(unsupportedReason(new Error("timeout after 5000 ms"))).toBeNull();
  });

  it("converts job times with printer-up-time, takes epoch times as they are, drops the rest", () => {
    expect(jobTime(9000, 10000, NOW)?.toISOString()).toBe("2026-11-20T09:43:20.000Z");
    expect(jobTime(1795400000, 1795600000 + 50, NOW)?.toISOString()).toBe(new Date(NOW.getTime() - 200_050_000).toISOString());
    expect(jobTime(NOW.getTime() / 1000 - 3200, 500, NOW)?.toISOString()).toBe("2026-11-20T09:06:40.000Z");
    expect(jobTime(9000, null, NOW)).toBeNull();
    expect(jobTime(0, 10000, NOW)).toBeNull();
    expect(jobTime(1995600000, null, NOW)).toBeNull();
  });

  it("builds rows, skipping records without a job id and duplicates; names only when collected", () => {
    const recs = [
      { "job-id": [5], "job-name": ["Copy"], "job-originating-user-name": [" copy "], "job-state": [9], "job-impressions-completed": [3], "time-at-creation": [900], "time-at-completed": [960] },
      { "job-id": [5], "job-state": [9], "time-at-creation": [900] },
      { "job-id": [6], "job-state": [7] },
      { "job-name": ["no id"] },
    ] as Record<string, IppValue[]>[];
    const rows = toPrinterJobs("p", recs, 1000, NOW, false);
    expect(rows.map((r) => [r.jobId, r.createdRaw, r.state, r.name, r.owner, r.pages])).toEqual([
      [5, 900, "completed", null, "copy", 3],
      [6, 0, "canceled", null, null, null],
    ]);
    expect(rows[0].completedAt?.toISOString()).toBe("2026-11-20T09:59:20.000Z");
    expect(toPrinterJobs("p", recs, 1000, NOW, true)[0].name).toBe("Copy");
  });

  it("reads printer-up-time in the existing status request", () => {
    expect(statusFromIpp({ "printer-state": [3], "printer-up-time": [1234] }, 15).upTime).toBe(1234);
    expect(statusFromIpp({ "printer-state": [3] }, 15).upTime).toBeNull();
  });
});

describe("printer job list (poll)", () => {
  const sim = { ...SIMS[0], port: 0, jobMs: 50 };
  const noJobs = { ...SIMS[4], port: 0 };
  let server: ReturnType<typeof startSim>;
  let noJobsServer: ReturnType<typeof startSim>;

  beforeAll(async () => {
    d = drizzle(new PGlite(), { schema });
    await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    pg.db = d;
    server = startSim(sim);
    noJobsServer = startSim(noJobs);
    await Promise.all([new Promise((r) => server.once("listening", r)), new Promise((r) => noJobsServer.once("listening", r))]);
  });
  afterAll(() => {
    server.close();
    noJobsServer.close();
  });
  beforeEach(async () => {
    await d.delete(schema.printerJobs);
    await d.delete(schema.printJobs);
    await d.delete(schema.testPrints);
    await d.delete(schema.printerStatus);
    await d.delete(schema.printers);
    sim.getJobsCalls = 0;
    noJobs.getJobsCalls = 0;
  });

  async function addPrinter(name: string, srv: ReturnType<typeof startSim>, extra: Partial<typeof schema.printers.$inferInsert> = {}) {
    const port = (srv.address() as AddressInfo).port;
    const [p] = await d
      .insert(schema.printers)
      .values({ name, host: "127.0.0.1", port, driverMode: "driverless", identityCheckedAt: new Date(), ...extra })
      .returning();
    return p;
  }

  it("one Get-Jobs per IPP printer per cycle; the same jobs read again are stored once", async () => {
    const p = await addPrinter("Brother", server);
    await pollAll();
    await pollAll();
    expect(sim.getJobsCalls).toBe(2);
    const rows = await d.select().from(schema.printerJobs).where(eq(schema.printerJobs.printerId, p.id));
    expect(rows.map((r) => [r.owner, r.name, r.pages, r.state]).sort()).toEqual([
      ["alice", "Boarding pass.pdf", 1, "completed"],
      ["copy", "Copy", 12, "completed"],
    ]);
    // Wall-clock time from printer-up-time: the copy was made an hour ago.
    const copy = rows.find((r) => r.owner === "copy")!;
    expect(Math.abs(copy.createdAt!.getTime() - (Date.now() - 3600_000))).toBeLessThan(5000);
  });

  it("a printer that refuses Get-Jobs is marked once and never asked again (until a new revision)", async () => {
    const p = await addPrinter("Kyocera", noJobsServer);
    await pollAll();
    const [after] = await d.select().from(schema.printers).where(eq(schema.printers.id, p.id));
    expect(after.jobsUnsupportedRevision).toBe(p.revision);
    expect(after.jobsUnsupportedReason).toBe("IPP status 0x0501");
    await pollAll();
    await pollAll();
    expect(noJobs.getJobsCalls).toBe(1);
  });

  it("offline printers are not asked", async () => {
    const p = await addPrinter("Gone", server, { host: "127.0.0.1", port: 1 });
    await pollAll();
    expect(sim.getJobsCalls).toBe(0);
    expect(await d.select().from(schema.printerJobs).where(eq(schema.printerJobs.printerId, p.id))).toEqual([]);
  });

  it("auto mode's speed check reuses the job list request instead of sending its own", async () => {
    const p = await addPrinter("Auto", server, { driverMode: "auto" });
    await pollAll();
    expect(sim.getJobsCalls).toBe(1);
    const [after] = await d.select().from(schema.printers).where(eq(schema.printers.id, p.id));
    expect(after.speedCheckedAt).not.toBeNull();
    expect(after.speedSamples.map((s) => s.pages).sort()).toEqual([1, 12]);
  });

  it("does nothing on a transient error", async () => {
    const p = await addPrinter("Flaky", server, { port: 1 });
    expect(await pollPrinterJobs(p, { upTime: null }, NOW, { speed: false })).toBeNull();
    const [after] = await d.select().from(schema.printers).where(eq(schema.printers.id, p.id));
    expect(after.jobsUnsupportedRevision).toBeNull();
  });

  it("retention: older than PRINTER_JOBS_RETENTION_DAYS (30), then the per-printer cap", async () => {
    const p = await addPrinter("Busy", server);
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    await d.insert(schema.printerJobs).values(
      [40, 3, 2, 1].map((days, i) => ({ printerId: p.id, jobId: i + 1, createdRaw: i, state: "completed" as const, completedAt: at(days), seenAt: at(days) })),
    );
    expect(await purgePrinterJobs(NOW, 2)).toBe(2);
    const left = await d.select().from(schema.printerJobs);
    expect(left.map((r) => r.jobId).sort()).toEqual([3, 4]);
  });

  it("merges printer jobs into Recent jobs as source printer, without PC jobs and test prints listed twice", async () => {
    const p = await addPrinter("Merged", server);
    const t = new Date("2026-11-20T09:00:00Z");
    const min = (m: number) => new Date(t.getTime() + m * 60_000);
    await d.insert(schema.printJobs).values({ computerGuid: "g", computerName: "FIN-01", recordId: 1, printedAt: t, userName: "EXAMPLE\\Alice", queueName: "Merged", printerId: p.id, pages: 2 });
    await d.insert(schema.testPrints).values({ printerId: p.id, printerName: "Merged", mode: "direct", requestedBy: "admin@example.org", state: "printed", createdAt: min(30), jobId: 77 });
    await d.insert(schema.printerJobs).values([
      // The PC job above, as the printer lists it.
      { printerId: p.id, jobId: 70, createdRaw: 1, owner: "alice", state: "completed", pages: 2, createdAt: min(0), completedAt: min(1) },
      // The test print above.
      { printerId: p.id, jobId: 77, createdRaw: 2, owner: "spoolfree", state: "completed", createdAt: min(30), completedAt: min(30) },
      // A copy at the device, and a canceled job by the same user an hour later: both only the printer knows.
      { printerId: p.id, jobId: 78, createdRaw: 3, owner: "copy", state: "completed", pages: 12, createdAt: min(40), completedAt: min(41) },
      { printerId: p.id, jobId: 79, createdRaw: 4, owner: "alice", state: "canceled", createdAt: min(60), completedAt: min(60) },
      { printerId: p.id, jobId: 80, createdRaw: 5, owner: "x", state: "aborted", createdAt: min(61), completedAt: null, seenAt: min(62) },
    ]);
    const none: Omit<RecentJobFilters, "page"> = { printer: null, state: null, source: null, q: null };
    const all = (await d.execute<Record<string, unknown>>(recentJobsQuery(none, 50))).rows.map(toRecentJob);
    expect(all.map((j) => [j.source, j.jobRef, j.owner, j.state])).toEqual([
      ["printer", "80", "x", "failed"],
      ["printer", "79", "alice", "canceled"],
      ["printer", "78", "copy", "printed"],
      ["test", "77", "admin@example.org", "printed"],
      ["pc", "1", "EXAMPLE\\Alice", "printed"],
    ]);
    const copy = all.find((j) => j.jobRef === "78")!;
    expect(copy).toMatchObject({ printer: "Merged", printerId: p.id, pages: 12, computer: null, submittedAt: min(40).toISOString(), completedAt: min(41).toISOString() });
    expect((await d.execute<Record<string, unknown>>(recentJobsQuery({ ...none, source: "printer" }, 50))).rows).toHaveLength(3);
  });
});
