import { sql } from "drizzle-orm";
import { dayIn } from "../analytics/counters";
import { config } from "../config";
import { db, schema, sqlClient } from "../db";
import { getCompletedJobs, getPrinterAttributes } from "../ipp/client";
import { autoSettings } from "../config";
import { mergeSpeedSamples, newStickyReason } from "../drivers/auto";
import { eq } from "drizzle-orm";
import { lowMarkers, needsAttention, offlineStatus, printerUri, STATUS_ATTRIBUTES, statusFromIpp, type PrinterStatus } from "../ipp/interpret";
import { identityDue, refreshIdentity } from "./identity";
import { snmpStatus } from "./snmp";

type PrinterRow = typeof schema.printers.$inferSelect;

/** IPP first; SNMP Printer-MIB when IPP fails or reports no supplies. */
export async function pollPrinter(p: PrinterRow): Promise<PrinterStatus> {
  const c = config();
  let ipp: PrinterStatus | null = null;
  let ippError: string | null = null;
  try {
    const attrs = await getPrinterAttributes(printerUri(p), STATUS_ATTRIBUTES, c.POLL_TIMEOUT_MS);
    ipp = statusFromIpp(attrs, c.LOW_TONER_PERCENT);
    if (ipp.markers.length > 0 && ipp.pageCount !== null) return ipp;
  } catch (e) {
    ippError = (e as Error).message;
  }
  try {
    const s = await snmpStatus(p.host, c.SNMP_COMMUNITY, c.POLL_TIMEOUT_MS, c.LOW_TONER_PERCENT);
    if (!ipp) return s;
    // Merge: IPP state is authoritative; fill gaps from SNMP.
    return {
      ...ipp,
      markers: ipp.markers.length ? ipp.markers : s.markers,
      pageCount: ipp.pageCount ?? s.pageCount,
    };
  } catch (e) {
    if (ipp) return ipp;
    return offlineStatus(`IPP: ${ippError ?? "n/a"}; SNMP: ${(e as Error).message}`);
  }
}

/** Stable string describing the alert-worthy condition; webhooks fire on change. */
export function alertKey(s: PrinterStatus): string | null {
  if (!s.online) return "offline";
  const parts = [...needsAttention(s), ...lowMarkers(s).map((m) => `low:${m.name}`)];
  return parts.length ? parts.sort().join(",") : null;
}

async function sendWebhook(p: PrinterRow, s: PrinterStatus, key: string | null, previous: string | null) {
  const url = config().ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = key
    ? `Printer ${p.name} (${p.location ?? p.host}): ${key}`
    : `Printer ${p.name} (${p.location ?? p.host}) recovered (was: ${previous})`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        printer: { id: p.id, name: p.name, host: p.host, location: p.location },
        condition: key,
        previous,
        online: s.online,
        markers: s.markers,
        stateReasons: s.stateReasons,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`[spoolfree] webhook failed: ${(e as Error).message}`);
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export async function pollAll(): Promise<number> {
  const d = db();
  const printers = await d.select().from(schema.printers);
  const previous = new Map((await d.select().from(schema.printerStatus)).map((r) => [r.printerId, r]));
  await mapLimit(printers, config().POLL_CONCURRENCY, async (p) => {
    const s = await pollPrinter(p);
    const now = new Date();
    const prev = previous.get(p.id);
    const key = alertKey(s);
    const values = {
      online: s.online,
      state: s.state,
      stateReasons: s.stateReasons,
      stateMessage: s.stateMessage,
      markers: s.markers,
      pageCount: s.pageCount ?? prev?.pageCount ?? null,
      source: s.source,
      error: s.error,
      lastPolledAt: now,
      lastSeen: s.online ? now : (prev?.lastSeen ?? null),
      alertKey: key,
    };
    await d.insert(schema.printerStatus).values({ printerId: p.id, ...values }).onConflictDoUpdate({ target: schema.printerStatus.printerId, set: values });
    if (prev && (prev.alertKey ?? null) !== key) await sendWebhook(p, s, key, prev.alertKey ?? null);
    // Daily page-counter readings for analytics (total pages per printer, pages not sent from PCs).
    if (s.online && s.pageCount !== null && s.pageCount >= 0) {
      await recordCounter(p, s.pageCount, now).catch((e) => console.warn(`[spoolfree] counter of ${p.name}: ${(e as Error).message}`));
    }
    // Auto driver mode: measure seconds per page of completed IPP jobs (Get-Jobs) to spot slow printers.
    if (s.online && speedDue(p, now)) {
      await measureSpeed(p, now).catch((e) => console.warn(`[spoolfree] job speed of ${p.name}: ${(e as Error).message}`));
    }
    // Device identity (printer-uuid, MACs) for legacy queue matching on PCs: once a day per printer.
    if (s.online && identityDue(p, now)) {
      await refreshIdentity(p).catch((e) => console.warn(`[spoolfree] identity of ${p.name}: ${(e as Error).message}`));
    }
  });
  return printers.length;
}

const JOB_ATTRIBUTES = ["job-id", "job-state", "time-at-processing", "time-at-completed", "job-impressions-completed", "job-media-sheets-completed"];

/** Speed is measured for auto-mode printers that have not switched to a vendor driver yet. */
export function speedDue(p: Pick<PrinterRow, "driverMode" | "autoVendorReason" | "speedCheckedAt">, now: Date): boolean {
  const minutes = config().DRIVER_AUTO_SPEED_INTERVAL_MINUTES;
  if (!minutes || p.driverMode !== "auto" || p.autoVendorReason) return false;
  return !p.speedCheckedAt || now.getTime() - p.speedCheckedAt.getTime() >= minutes * 60_000;
}

/** Reads completed jobs, stores the samples and, when the printer is now "slow", auto mode's sticky vendor decision. */
export async function measureSpeed(p: PrinterRow, now: Date) {
  let samples = p.speedSamples;
  try {
    const jobs = await getCompletedJobs(printerUri(p), JOB_ATTRIBUTES, config().POLL_TIMEOUT_MS, 20);
    samples = mergeSpeedSamples(p.speedSamples, jobs as Record<string, unknown[]>[], now);
  } finally {
    const sticky = newStickyReason({ ...p, speedSamples: samples }, autoSettings());
    await db()
      .update(schema.printers)
      .set({ speedSamples: samples, speedCheckedAt: now, ...(sticky ? { autoVendorReason: sticky, autoVendorAt: now } : {}) })
      .where(eq(schema.printers.id, p.id));
    if (sticky) {
      await db()
        .insert(schema.auditLog)
        .values({ actor: "poller", action: "printer.driver_auto", entityType: "printer", entityId: p.id, details: { mode: "vendor", reason: sticky, source: "job speed" } });
      console.log(`[spoolfree] ${p.name}: auto driver mode switched to vendor (${sticky})`);
    }
  }
}

/** Upserts today's counter reading: first reading of the day stays, last is replaced. */
export async function recordCounter(p: Pick<PrinterRow, "id" | "revision">, count: number, now: Date) {
  const day = dayIn(config().ANALYTICS_TIME_ZONE, now);
  await db()
    .insert(schema.printerCounterDaily)
    .values({ printerId: p.id, day, revision: p.revision, firstCount: count, lastCount: count, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.printerCounterDaily.printerId, schema.printerCounterDaily.day],
      set: {
        lastCount: count,
        updatedAt: now,
        // A replaced device (new revision) or a reset counter starts the day over.
        firstCount: sql`case when ${schema.printerCounterDaily.revision} <> ${p.revision} or ${count} < ${schema.printerCounterDaily.lastCount} then ${count} else ${schema.printerCounterDaily.firstCount} end`,
        revision: p.revision,
      },
    });
}

const PURGE_EVERY_MS = 3600_000;
const gp = globalThis as unknown as { __spoolfreeLastPurge?: number };

/** Analytics retention: at most once an hour, inside the poll lock. */
async function purgeIfDue() {
  if (gp.__spoolfreeLastPurge && Date.now() - gp.__spoolfreeLastPurge < PURGE_EVERY_MS) return;
  gp.__spoolfreeLastPurge = Date.now();
  const { purgeAnalytics } = await import("../analytics/queries");
  const r = await purgeAnalytics();
  if (r.jobs || r.counters) console.log(`[spoolfree] analytics retention: deleted ${r.jobs} print jobs and ${r.counters} counter readings`);
}

/**
 * Housekeeping after each poll cycle (inside the poll lock): analytics retention, and test prints whose command
 * expired are finalised (L7) on a schedule instead of only when an admin opens them, so their audit rows are written on time.
 */
export async function runHousekeeping(deps: { purge?: () => Promise<void>; expire?: () => Promise<number> } = {}): Promise<void> {
  await (deps.purge ?? purgeIfDue)().catch((e) => console.warn(`[spoolfree] analytics purge failed: ${(e as Error).message}`));
  const expire =
    deps.expire ??
    (async () => {
      const { expireTestPrints } = await import("../test-print/service");
      return expireTestPrints();
    });
  try {
    const n = await expire();
    if (n) console.log(`[spoolfree] test prints: ${n} expired`);
  } catch (e) {
    console.warn(`[spoolfree] test print expiry failed: ${(e as Error).message}`);
  }
}

const LOCK_ID = 0x5f001;

/** One poll cycle, guarded by a Postgres advisory lock so only one replica polls. */
export async function pollOnce(): Promise<boolean> {
  const sql = sqlClient();
  return sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(${LOCK_ID}) as locked`;
    if (!locked) return false;
    await pollAll();
    await runHousekeeping();
    return true;
  });
}

const g = globalThis as unknown as { __spoolfreePoller?: NodeJS.Timeout };

export function startPoller() {
  if (g.__spoolfreePoller) return;
  const c = config();
  const tick = async () => {
    try {
      await pollOnce();
    } catch (e) {
      console.error("[spoolfree] poll cycle failed:", (e as Error).message);
    }
  };
  setTimeout(tick, 5_000);
  g.__spoolfreePoller = setInterval(tick, c.POLL_INTERVAL_SECONDS * 1000);
  console.log(`[spoolfree] printer poller started (every ${c.POLL_INTERVAL_SECONDS}s)`);
}
