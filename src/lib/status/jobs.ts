import { sql } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import type { PrinterJobState } from "../db/schema";
import { getCompletedJobs, IppHttpError, IppStatusError } from "../ipp/client";
import type { IppValue } from "../ipp/encoding";
import { printerUri, type PrinterStatus } from "../ipp/interpret";

/*
 * Printer job list (PRINTER_JOBS_POLL): inside the status poll, one IPP Get-Jobs (which-jobs=completed, limit 20) per
 * printer that answered the status request over IPP. No new timer, port, host or connection type: it reuses the poll
 * cycle, the printer's IPP URI and POLL_TIMEOUT_MS. Not-completed jobs are not read (that would be a second request;
 * the Queue column already counts them, and they are listed here once they complete).
 */

type PrinterRow = typeof schema.printers.$inferSelect;

/** At most this many jobs per request (the printer's newest completed jobs). */
export const JOBS_LIMIT = 20;
/** Rows kept per printer on top of PRINTER_JOBS_RETENTION_DAYS. */
export const JOBS_MAX_PER_PRINTER = 1000;

/** Minimal attributes for the job list. job-name only when document names are collected. */
export function jobAttributes(opts: { names: boolean; speed: boolean }): string[] {
  return [
    "job-id",
    ...(opts.names ? ["job-name"] : []),
    "job-originating-user-name",
    "job-state",
    "job-impressions-completed",
    "time-at-creation",
    "time-at-completed",
    // Auto driver mode's speed check reuses this request when it is due (instead of a Get-Jobs of its own).
    ...(opts.speed ? ["time-at-processing", "job-media-sheets-completed"] : []),
  ];
}

/** Ask this printer for its job list in this cycle? Only IPP-reachable printers that have not refused Get-Jobs. */
export function jobsDue(p: Pick<PrinterRow, "revision" | "jobsUnsupportedRevision">, s: Pick<PrinterStatus, "online" | "source">, enabled = config().PRINTER_JOBS_POLL): boolean {
  if (!enabled || !s.online || s.source !== "ipp") return false;
  return p.jobsUnsupportedRevision !== p.revision;
}

/**
 * Errors that mean the device will never answer Get-Jobs (so it is not asked again): IPP operation not supported,
 * bad request, not authenticated/authorised, version not supported, or an HTTP 4xx. Timeouts, refused connections and
 * server errors are transient and are not remembered.
 */
export function unsupportedReason(e: unknown): string | null {
  if (e instanceof IppStatusError) {
    const st = e.status;
    if (st === 0x0501 || st === 0x0503 || (st >= 0x0400 && st <= 0x0403)) return e.message;
    return null;
  }
  if (e instanceof IppHttpError) return e.status >= 400 && e.status < 500 ? e.message : null;
  return null;
}

const STATE: Record<number, PrinterJobState> = { 7: "canceled", 8: "aborted", 9: "completed" };

function num(v: IppValue[] | undefined): number | null {
  const x = v?.[0];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function str(v: IppValue[] | undefined): string | null {
  const x = v?.[0];
  return typeof x === "string" && x.trim() ? x.trim().slice(0, 500) : null;
}

/**
 * IPP time-at-* (RFC 8011) counts seconds of printer-up-time; some devices (CUPS) use epoch seconds for both. With
 * printer-up-time from the same poll the job time is now - (upTime - t). Without it, epoch-looking values are taken as
 * they are. Anything in the future or before 2000 is dropped.
 */
export function jobTime(t: number | null, upTime: number | null | undefined, now: Date): Date | null {
  if (t === null || t <= 0) return null;
  let ms: number;
  if (upTime && upTime > 0 && t <= upTime + 60) ms = now.getTime() - (upTime - t) * 1000;
  else if (t > 946_684_800) ms = t * 1000;
  else return null;
  if (ms > now.getTime() + 5 * 60_000 || ms < 946_684_800_000) return null;
  return new Date(Math.round(ms / 1000) * 1000);
}

export type PrinterJobInsert = typeof schema.printerJobs.$inferInsert;

/** Turns Get-Jobs job groups into rows (skips records without a job-id or with a non-final state). */
export function toPrinterJobs(printerId: string, records: Record<string, IppValue[]>[], upTime: number | null | undefined, now: Date, names: boolean): PrinterJobInsert[] {
  const out: PrinterJobInsert[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const jobId = num(r["job-id"]);
    const state = STATE[num(r["job-state"]) ?? 9];
    if (jobId === null || !Number.isInteger(jobId) || jobId <= 0 || !state) continue;
    const created = num(r["time-at-creation"]);
    const createdRaw = created !== null && created > 0 ? Math.floor(created) : 0;
    const key = `${jobId}:${createdRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pages = num(r["job-impressions-completed"]);
    out.push({
      printerId,
      jobId,
      createdRaw,
      name: names ? str(r["job-name"]) : null,
      owner: str(r["job-originating-user-name"]),
      state,
      pages: pages !== null && pages >= 0 ? Math.floor(pages) : null,
      createdAt: jobTime(created, upTime, now),
      completedAt: jobTime(num(r["time-at-completed"]), upTime, now),
      seenAt: now,
    });
  }
  return out;
}

/**
 * Reads the printer's completed jobs and stores new ones. Returns the raw job records (for the speed check), or null
 * when the request failed. A refusal is stored on the printer so this device is never asked again.
 */
export async function pollPrinterJobs(p: PrinterRow, s: Pick<PrinterStatus, "upTime">, now: Date, opts: { speed: boolean }): Promise<Record<string, IppValue[]>[] | null> {
  const c = config();
  const names = c.ANALYTICS_COLLECT_DOCUMENT_NAMES;
  let records: Record<string, IppValue[]>[];
  try {
    records = await getCompletedJobs(printerUri(p), jobAttributes({ names, speed: opts.speed }), c.POLL_TIMEOUT_MS, JOBS_LIMIT);
  } catch (e) {
    const reason = unsupportedReason(e);
    if (reason) {
      await db()
        .update(schema.printers)
        .set({ jobsUnsupportedRevision: p.revision, jobsUnsupportedReason: reason.slice(0, 200) })
        .where(sql`${schema.printers.id} = ${p.id}`);
      console.log(`[spoolfree] ${p.name}: no job list from this printer (${reason}); not asked again`);
    } else {
      console.warn(`[spoolfree] job list of ${p.name}: ${(e as Error).message}`);
    }
    return null;
  }
  const rows = toPrinterJobs(p.id, records, s.upTime, now, names);
  if (rows.length) await db().insert(schema.printerJobs).values(rows).onConflictDoNothing();
  return records;
}

/** Retention: older than PRINTER_JOBS_RETENTION_DAYS, then at most JOBS_MAX_PER_PRINTER rows per printer. */
export async function purgePrinterJobs(now = new Date(), maxPerPrinter = JOBS_MAX_PER_PRINTER): Promise<number> {
  const cutoff = new Date(now.getTime() - config().PRINTER_JOBS_RETENTION_DAYS * 86_400_000).toISOString();
  const d = db();
  const old = await d.execute(sql`delete from printer_jobs where coalesce(completed_at, seen_at) < ${cutoff}::timestamptz`);
  const over = await d.execute(sql`delete from printer_jobs where id in (
    select id from (
      select id, row_number() over (partition by printer_id order by coalesce(completed_at, seen_at) desc, id desc) as n from printer_jobs
    ) x where x.n > ${maxPerPrinter}
  )`);
  const count = (r: unknown) => (r as { count?: number; affectedRows?: number }).count ?? (r as { affectedRows?: number }).affectedRows ?? 0;
  return count(old) + count(over);
}
