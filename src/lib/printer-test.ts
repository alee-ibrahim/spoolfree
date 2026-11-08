import { eq } from "drizzle-orm";
import { autoSettings, config } from "./config";
import { db, schema } from "./db";
import { newStickyReason } from "./drivers/auto";
import { getPrinterAttributes } from "./ipp/client";
import { detectIppPath, IppDetectError, type DetectedPath } from "./ipp/detect";
import { checkDriverless, printerUri, TEST_ATTRIBUTES, type DriverlessCheck } from "./ipp/interpret";
import { refreshIdentity } from "./status/identity";

/**
 * Printer Test (IPP Get-Printer-Attributes), shared by the admin UI and the CLI (printers test): confirms the device
 * is reachable and driverless-capable, detects the IPP path in auto mode, and stores what auto driver mode decides
 * on (IPP versions, formats, compression, printer-device-id). Writes "printer.test" audit rows.
 */

export interface TestDetection {
  /** true: the path was auto-detected; false: manual override. */
  auto: boolean;
  path: string | null;
  /** IPP request version the device answered ("2.0" or "1.1"). */
  version: string | null;
  /** Auto mode only: the stored path changed (revision bumped; PCs re-create the queue). */
  changed: boolean;
  tried: DetectedPath["tried"];
}

export type TestResult =
  | { ok: true; check: DriverlessCheck; uri: string; detection: TestDetection; autoVendor?: string | null }
  | { ok: false; error: string; uri: string; detection: TestDetection | null };

async function audit(actor: string, action: string, entityId: string, details: Record<string, unknown>) {
  await db().insert(schema.auditLog).values({ actor, action, entityType: "printer", entityId, details });
}

export async function runPrinterTest(actor: string, p: typeof schema.printers.$inferSelect): Promise<TestResult> {
  const d = db();
  let result: TestResult;
  const timeout = Math.max(config().POLL_TIMEOUT_MS, 8000);
  try {
    const found = await detectIppPath(p, TEST_ATTRIBUTES, timeout, getPrinterAttributes, p.ippPathAuto ? undefined : [p.ippPath]);
    const changed = p.ippPathAuto && found.path !== p.ippPath;
    const check = checkDriverless(found.attrs);
    const lastTest = { ...check, ippPath: found.path, ippRequestVersion: found.version };
    // Auto driver mode: a device that needs a vendor driver keeps that decision (sticky).
    const sticky = newStickyReason({ ...p, lastTest }, autoSettings());
    result = {
      ok: true,
      check,
      uri: found.uri,
      detection: { auto: p.ippPathAuto, path: found.path, version: found.version, changed, tried: found.tried },
      autoVendor: sticky,
    };
    await d
      .update(schema.printers)
      .set({
        lastTest,
        lastTestAt: new Date(),
        ...(check.deviceId ? { deviceId: check.deviceId } : {}),
        ...(sticky ? { autoVendorReason: sticky, autoVendorAt: new Date() } : {}),
        ...(changed ? { ippPath: found.path, revision: p.revision + 1, updatedAt: new Date() } : {}),
      })
      .where(eq(schema.printers.id, p.id));
    if (sticky) await audit(actor, "printer.driver_auto", p.id, { mode: "vendor", reason: sticky, source: "test" });
    if (changed) await audit(actor, "printer.ipp_path_detected", p.id, { before: p.ippPath, after: found.path, version: found.version });
    // printer-uuid and MAC addresses go into the manifest for legacy queue matching on PCs.
    await refreshIdentity({ ...p, ippPath: found.path }, { uuid: check.uuid, model: check.model }).catch(() => undefined);
  } catch (e) {
    const tried = e instanceof IppDetectError ? e.tried : [];
    result = {
      ok: false,
      error: (e as Error).message,
      uri: printerUri(p),
      detection: { auto: p.ippPathAuto, path: null, version: null, changed: false, tried },
    };
  }
  await audit(actor, "printer.test", p.id, { uri: result.uri, ok: result.ok && result.check.ok });
  return result;
}
