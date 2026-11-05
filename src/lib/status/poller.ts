import { config } from "../config";
import { db, schema, sqlClient } from "../db";
import { getPrinterAttributes } from "../ipp/client";
import { lowMarkers, needsAttention, offlineStatus, printerUri, STATUS_ATTRIBUTES, statusFromIpp, type PrinterStatus } from "../ipp/interpret";
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
  });
  return printers.length;
}

const LOCK_ID = 0x5f001;

/** One poll cycle, guarded by a Postgres advisory lock so only one replica polls. */
export async function pollOnce(): Promise<boolean> {
  const sql = sqlClient();
  return sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(${LOCK_ID}) as locked`;
    if (!locked) return false;
    await pollAll();
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
