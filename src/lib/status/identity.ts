import { eq } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import { mergeIdentity, type PrinterIdentity } from "../identity";
import { getPrinterAttributes } from "../ipp/client";
import { printerUri } from "../ipp/interpret";
import { snmpPhysAddresses } from "./snmp";

type PrinterRow = typeof schema.printers.$inferSelect;

/** Re-read at most this often by the poller (Test always re-reads). */
export const IDENTITY_MAX_AGE_MS = 24 * 3600_000;

/**
 * Reads the printer's IPP printer-uuid and SNMP MAC addresses and stores them (printers.device_uuid,
 * mac_addresses). Failed lookups keep the stored values. `known` skips the IPP request when the caller
 * already has the attributes (Test).
 */
export async function refreshIdentity(
  p: PrinterRow,
  known?: { uuid: string | null; model: string | null },
): Promise<PrinterIdentity> {
  const c = config();
  let uuid: string | null = known?.uuid ?? null;
  let model: string | null = known?.model ?? p.model;
  let deviceId: string | null = null;
  if (!known) {
    try {
      const attrs = await getPrinterAttributes(printerUri(p), ["printer-uuid", "printer-make-and-model", "printer-device-id"], c.POLL_TIMEOUT_MS);
      uuid = (attrs["printer-uuid"]?.[0] as string | undefined) ?? null;
      model = (attrs["printer-make-and-model"]?.[0] as string | undefined) ?? model;
      deviceId = (attrs["printer-device-id"]?.[0] as string | undefined) ?? null;
    } catch {
      uuid = null;
    }
  }
  let snmpMacs: Buffer[] | null = null;
  try {
    snmpMacs = await snmpPhysAddresses(p.host, c.SNMP_COMMUNITY, c.POLL_TIMEOUT_MS);
  } catch {
    snmpMacs = null;
  }
  const next = mergeIdentity({ deviceUuid: p.deviceUuid, macAddresses: p.macAddresses }, { uuid, model, snmpMacs });
  // 0.9.0: another device answers at this address: the WSD UUIDs agents reported for the old one are dropped too.
  const deviceChanged = !!p.deviceUuid && next.deviceUuid !== p.deviceUuid;
  await db()
    .update(schema.printers)
    .set({ deviceUuid: next.deviceUuid, macAddresses: next.macAddresses, identityCheckedAt: new Date(), ...(deviceId ? { deviceId } : {}), ...(deviceChanged ? { extraUuids: [] } : {}) })
    .where(eq(schema.printers.id, p.id));
  return next;
}

export function identityDue(p: Pick<PrinterRow, "identityCheckedAt">, now: Date): boolean {
  return !p.identityCheckedAt || now.getTime() - p.identityCheckedAt.getTime() > IDENTITY_MAX_AGE_MS;
}
