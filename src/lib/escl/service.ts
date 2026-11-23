import { eq } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import type { Printer } from "../db/schema";
import { detectScanner, readScannerStatus, runScanJob, ScanError, type DetectResult } from "./client";
import { chooseScan, describeScan, type ScanColor, type ScanSource } from "./escl";

/**
 * Scanners of MFPs (eSCL): detection (daily from the poller, and on every printer Test), status for the poller, and test
 * scans. A test scan's image goes back to the admin's browser only; it is never written to the database or a log.
 */

/** Re-detected at most this often by the poller (Test always re-detects). */
export const SCANNER_MAX_AGE_MS = 24 * 3600_000;

export function scannerDue(p: Pick<Printer, "scannerCheckedAt">, now: Date): boolean {
  return !p.scannerCheckedAt || now.getTime() - p.scannerCheckedAt.getTime() >= SCANNER_MAX_AGE_MS;
}

async function audit(actor: string, action: string, entityId: string, details: Record<string, unknown>) {
  await db().insert(schema.auditLog).values({ actor, action, entityType: "printer", entityId, details });
}

/**
 * Looks for the scanner and stores what was found. When no endpoint answered at all (device unreachable), the stored
 * scanner is kept and the check is not counted, so a printer that is off for a day does not lose its scanner.
 */
export async function refreshScanner(p: Printer, actor = "poller", detect: typeof detectScanner = detectScanner): Promise<DetectResult> {
  const timeout = Math.min(config().POLL_TIMEOUT_MS, 5000);
  const r = await detect(p, timeout);
  const answered = r.scanner !== null || r.tried.some((t) => t.result === "no eSCL service");
  if (!answered) return r;
  await db().update(schema.printers).set({ scanner: r.scanner, scannerCheckedAt: new Date() }).where(eq(schema.printers.id, p.id));
  const before = p.scanner ? `${p.scanner.scheme}:${p.scanner.port}${p.scanner.path}` : null;
  const after = r.scanner ? `${r.scanner.scheme}:${r.scanner.port}${r.scanner.path}` : null;
  if (before !== after) await audit(actor, "printer.scanner_detected", p.id, { printer: p.name, before, after, model: r.scanner?.makeAndModel ?? null });
  return r;
}

export interface ScannerStatusColumns {
  scannerState: string | null;
  scannerAdfState: string | null;
  scannerError: string | null;
}

/** Scanner status for printer_status; all null for a printer without a scanner. */
export async function pollScanner(p: Pick<Printer, "host" | "scanner">, read: typeof readScannerStatus = readScannerStatus): Promise<ScannerStatusColumns> {
  if (!p.scanner) return { scannerState: null, scannerAdfState: null, scannerError: null };
  try {
    const s = await read(p.host, p.scanner, config().POLL_TIMEOUT_MS);
    return { scannerState: s.state, scannerAdfState: s.adfState, scannerError: null };
  } catch (e) {
    return { scannerState: null, scannerAdfState: null, scannerError: (e as Error).message.slice(0, 300) };
  }
}

export class TestScanError extends Error {}

export interface TestScanResult {
  format: string;
  data: Buffer;
  settings: string;
  durationMs: number;
}

/** Largest scanned page accepted (a 150 dpi A4 page is well below 5 MB in any listed format). */
export const TEST_SCAN_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Runs one test scan. At most one per printer per TEST_PRINT_MIN_INTERVAL_SECONDS (printer row locked, so two admins
 * clicking at once cannot both start one). Writes "printer.test_scan" and "printer.test_scan_result" audit rows with the
 * settings and outcome, never the image.
 */
export async function runTestScan(
  printer: Printer,
  actor: string,
  source: ScanSource,
  color: ScanColor,
  scan: typeof runScanJob = runScanJob,
  now = new Date(),
): Promise<TestScanResult> {
  if (!printer.scanner) throw new TestScanError("No scanner was found on this printer. Run Detect scanner (or Test) first.");
  const choice = chooseScan(printer.scanner, source, color);
  if (typeof choice === "string") throw new TestScanError(choice);
  const minGap = config().TEST_PRINT_MIN_INTERVAL_SECONDS * 1000;
  await db().transaction(async (tx) => {
    const [row] = await tx.select({ last: schema.printers.lastTestScanAt }).from(schema.printers).where(eq(schema.printers.id, printer.id)).for("update");
    if (!row) throw new TestScanError("Printer not found");
    if (minGap > 0 && row.last && now.getTime() - row.last.getTime() < minGap) {
      const wait = Math.max(1, Math.ceil((row.last.getTime() + minGap - now.getTime()) / 1000));
      throw new TestScanError(`A test scan was started on this printer moments ago. Try again in ${wait} s.`);
    }
    await tx.update(schema.printers).set({ lastTestScanAt: now }).where(eq(schema.printers.id, printer.id));
  });
  const settings = describeScan(choice);
  await audit(actor, "printer.test_scan", printer.id, { printer: printer.name, settings });
  const started = Date.now();
  try {
    const r = await scan(printer.host, printer.scanner, choice, { requestTimeoutMs: Math.max(config().POLL_TIMEOUT_MS, 10_000), totalTimeoutMs: 120_000, maxBytes: TEST_SCAN_MAX_BYTES });
    const durationMs = Date.now() - started;
    await audit(actor, "printer.test_scan_result", printer.id, { printer: printer.name, ok: true, settings, format: r.format, bytes: r.data.length, durationMs });
    return { ...r, settings, durationMs };
  } catch (e) {
    const msg = e instanceof ScanError ? e.message : `could not reach the scanner: ${(e as Error).message}`;
    await audit(actor, "printer.test_scan_result", printer.id, { printer: printer.name, ok: false, settings, error: msg.slice(0, 500) });
    throw new TestScanError(msg);
  }
}
