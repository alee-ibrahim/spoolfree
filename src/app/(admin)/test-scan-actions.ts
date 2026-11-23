"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { readScannerStatus } from "@/lib/escl/client";
import { esclBase, type ScannerState } from "@/lib/escl/escl";
import { refreshScanner, runTestScan, TestScanError } from "@/lib/escl/service";
import { timeAgo } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

/** Test scan: admin-only server actions behind the Test scan dialog (printers page). */

export interface ScanSourceView {
  available: boolean;
  color: boolean;
  gray: boolean;
}

export interface TestScanOptions {
  printerId: string;
  printerName: string;
  scanner: {
    url: string;
    model: string | null;
    platen: ScanSourceView;
    feeder: ScanSourceView;
  } | null;
  checkedAgo: string | null;
  /** Read live when the dialog opens; null without a scanner. */
  status: { state: ScannerState; adfState: string | null } | { error: string } | null;
  minIntervalSeconds: number;
}

export type TestScanStart =
  | { ok: true; dataUrl: string; format: string; bytes: number; settings: string; durationMs: number }
  | { ok: false; error: string };

export type DetectScannerResult = { ok: true; found: boolean; tried: { url: string; result: string }[] } | { ok: false; error: string };

async function loadPrinter(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [p] = await db().select().from(schema.printers).where(eq(schema.printers.id, id));
  return p ?? null;
}

function sourceView(caps: { colorModes: string[] } | null): ScanSourceView {
  return {
    available: !!caps,
    color: !!caps?.colorModes.some((m) => /^RGB/.test(m)),
    gray: !!caps?.colorModes.some((m) => /^(Grayscale|BlackAndWhite)/.test(m)),
  };
}

export async function testScanOptions(printerId: string): Promise<TestScanOptions | null> {
  await requireAdmin();
  const p = await loadPrinter(printerId);
  if (!p) return null;
  let status: TestScanOptions["status"] = null;
  if (p.scanner) {
    try {
      const s = await readScannerStatus(p.host, p.scanner, config().POLL_TIMEOUT_MS);
      status = { state: s.state, adfState: s.adfState };
    } catch (e) {
      status = { error: (e as Error).message };
    }
  }
  return {
    printerId: p.id,
    printerName: p.name,
    scanner: p.scanner
      ? { url: esclBase(p.host, p.scanner), model: p.scanner.makeAndModel, platen: sourceView(p.scanner.platen), feeder: sourceView(p.scanner.feeder) }
      : null,
    checkedAgo: p.scannerCheckedAt ? timeAgo(p.scannerCheckedAt) : null,
    status,
    minIntervalSeconds: config().TEST_PRINT_MIN_INTERVAL_SECONDS,
  };
}

/** Looks for the printer's eSCL scanner now (the poller does this once a day). Audit-logged when it changes. */
export async function detectPrinterScanner(printerId: string): Promise<DetectScannerResult> {
  const admin = await requireAdmin();
  const p = await loadPrinter(printerId);
  if (!p) return { ok: false, error: "Printer not found" };
  const r = await refreshScanner(p, admin.email);
  return { ok: true, found: !!r.scanner, tried: r.tried };
}

const StartInput = z.object({
  printerId: z.string().uuid(),
  source: z.enum(["platen", "feeder"]),
  color: z.enum(["gray", "color"]),
});

/** Scans one page and returns it to the browser; nothing of the image is stored. Admin only; rate limited; audited. */
export async function startTestScan(input: z.input<typeof StartInput>): Promise<TestScanStart> {
  const admin = await requireAdmin();
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const p = await loadPrinter(parsed.data.printerId);
  if (!p) return { ok: false, error: "Printer not found" };
  try {
    const r = await runTestScan(p, admin.email, parsed.data.source, parsed.data.color);
    return {
      ok: true,
      dataUrl: `data:${r.format};base64,${r.data.toString("base64")}`,
      format: r.format,
      bytes: r.data.length,
      settings: r.settings,
      durationMs: r.durationMs,
    };
  } catch (e) {
    if (e instanceof TestScanError) return { ok: false, error: e.message };
    throw e;
  }
}
