import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { count, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFilters } from "@/lib/analytics/filters";
import { where as jobsWhere } from "@/lib/analytics/queries";
import * as schema from "@/lib/db/schema";
import { auditWhere, parseAuditFilters } from "@/lib/list-filters/audit";

/* The server-side filter builders (audit log, analytics job log) against a real Postgres (PGlite + migrations). */

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;

beforeAll(async () => {
  d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  await d.insert(schema.auditLog).values([
    { at: new Date("2026-11-01T09:00:00Z"), actor: "admin@example.org", action: "printer.create", entityType: "printer", entityId: "p1", details: { name: "Finance Laser" } },
    { at: new Date("2026-11-03T23:59:00Z"), actor: "admin@example.org", action: "printer.update", entityType: "printer", entityId: "p1", details: { name: "Finance Laser 100%" } },
    { at: new Date("2026-11-04T00:00:00Z"), actor: "cli", action: "printer.delete", entityType: "printer", entityId: "p2", details: { name: "Old_Kiosk" } },
    { at: new Date("2026-11-05T10:00:00Z"), actor: "helpdesk@example.org", action: "ou.assign", entityType: "ou", entityId: "OU=HR,DC=example,DC=org", details: null },
  ]);
  const job = (recordId: number, userName: string | null, documentName: string | null, printedAt: string) => ({
    computerGuid: "g1",
    computerName: "FIN-01",
    recordId,
    printedAt: new Date(printedAt),
    userName,
    queueName: "Finance Laser",
    pages: 1,
    documentName,
  });
  await d.insert(schema.printJobs).values([
    job(1, "EXAMPLE\\alice", "Budget 2027.xlsx", "2026-11-05T08:00:00Z"),
    job(2, "EXAMPLE\\bob", "Minutes.docx", "2026-11-05T09:00:00Z"),
    job(3, "EXAMPLE\\alice", null, "2026-11-06T09:00:00Z"),
    job(4, null, "budget draft.pdf", "2026-11-06T10:00:00Z"),
  ]);
});

async function audit(sp: Record<string, string>) {
  const rows = await d.select().from(schema.auditLog).where(auditWhere(parseAuditFilters(sp))).orderBy(desc(schema.auditLog.id));
  return rows.map((r) => r.action);
}

describe("audit log filter (SQL)", () => {
  it("returns everything without filters", async () => {
    expect(auditWhere(parseAuditFilters({}))).toBeUndefined();
    expect(await audit({})).toHaveLength(4);
  });

  it("searches actor, action, target and details; every word must match", async () => {
    expect(await audit({ q: "finance" })).toEqual(["printer.update", "printer.create"]);
    expect(await audit({ q: "finance update" })).toEqual(["printer.update"]);
    expect(await audit({ q: "OU=HR" })).toEqual(["ou.assign"]);
    expect(await audit({ q: "helpdesk" })).toEqual(["ou.assign"]);
  });

  it("treats LIKE wildcards in the search as text", async () => {
    expect(await audit({ q: "100%" })).toEqual(["printer.update"]);
    expect(await audit({ q: "old_kiosk" })).toEqual(["printer.delete"]);
    expect(await audit({ q: "%" })).toEqual(["printer.update"]);
  });

  it("filters by actor, action (exact or family) and UTC day range", async () => {
    expect(await audit({ actor: "cli" })).toEqual(["printer.delete"]);
    expect(await audit({ action: "printer.*" })).toEqual(["printer.delete", "printer.update", "printer.create"]);
    expect(await audit({ action: "printer.update" })).toEqual(["printer.update"]);
    expect(await audit({ from: "2026-11-03", to: "2026-11-03" })).toEqual(["printer.update"]);
    expect(await audit({ from: "2026-11-04" })).toEqual(["ou.assign", "printer.delete"]);
    expect(await audit({ to: "2026-11-01" })).toEqual(["printer.create"]);
    expect(await audit({ actor: "admin@example.org", action: "printer.*", from: "2026-11-02" })).toEqual(["printer.update"]);
    const [{ n }] = await d.select({ n: count() }).from(schema.auditLog).where(auditWhere(parseAuditFilters({ action: "printer.*" })));
    expect(n).toBe(3);
  });
});

describe("analytics job log search (SQL)", () => {
  const ids = async (sp: Record<string, string>) => {
    const w = jobsWhere(parseFilters({ from: "2026-11-01", to: "2026-11-08", ...sp }, "2026-11-08"), "UTC");
    const r = await d.execute<{ record_id: number }>(sql`select j.record_id from print_jobs j where ${w} order by j.record_id`);
    return r.rows.map((x) => Number(x.record_id));
  };

  it("matches user or document name, every word", async () => {
    expect(await ids({})).toEqual([1, 2, 3, 4]);
    expect(await ids({ q: "alice" })).toEqual([1, 3]);
    expect(await ids({ q: "budget" })).toEqual([1, 4]);
    expect(await ids({ q: "alice budget" })).toEqual([1]);
    expect(await ids({ q: "minutes" })).toEqual([2]);
    expect(await ids({ q: "nobody" })).toEqual([]);
  });

  it("combines the search with the other filters and the date range", async () => {
    expect(await ids({ q: "alice", user: "EXAMPLE\\alice", from: "2026-11-06" })).toEqual([3]);
  });
});
