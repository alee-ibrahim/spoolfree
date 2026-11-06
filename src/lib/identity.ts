/**
 * Printer device identity (pure). Agents use it to recognise legacy queues for a printer that do not carry
 * its address: WSD/IPP ports only store the device UUID, and Brother default host names (BRNxxxxxxxxxxxx)
 * embed the MAC address instead of resolving in DNS.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "urn:uuid:XXXXXXXX-...", "{...}" or a bare UUID -> lower-case bare UUID; null when not a UUID. */
export function normalizeUuid(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1");
  if (!UUID_RE.test(v) || v === "00000000-0000-0000-0000-000000000000") return null;
  return v;
}

/**
 * A unicast, globally or locally administered MAC from a 6-byte buffer or a hex string with or without
 * separators -> 12 lower-case hex digits. All-zero, broadcast and multicast addresses are rejected.
 */
export function normalizeMac(value: Buffer | Uint8Array | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let hex: string;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!/^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/.test(v)) return null;
    hex = v.replace(/[:-]/g, "");
  } else {
    if (value.length !== 6) return null;
    hex = Buffer.from(value).toString("hex");
  }
  if (hex === "000000000000" || hex === "ffffffffffff") return null;
  if (parseInt(hex.slice(0, 2), 16) & 1) return null; // multicast bit
  return hex;
}

/**
 * Brother printers use a time-based (version 1) printer-uuid whose node field is the MAC address
 * (e.g. e3248000-80ce-11db-8000-<mac>). Only trusted for Brother models; null otherwise.
 */
export function macFromPrinterUuid(uuid: string | null | undefined, model: string | null | undefined): string | null {
  const u = normalizeUuid(uuid);
  if (!u || !model || !/\bbrother\b/i.test(model)) return null;
  const parts = u.split("-");
  if (parts[2][0] !== "1") return null; // version 1 only
  if (!/^[89ab]/.test(parts[3])) return null; // RFC 4122 variant
  return normalizeMac(parts[4]);
}

export interface PrinterIdentity {
  deviceUuid: string | null;
  macAddresses: string[];
}

/**
 * Merges a fresh lookup into the stored identity. Values are only replaced by values that were actually
 * read: a failed lookup (uuid null, snmpMacs null) keeps what is stored. A successful SNMP read replaces
 * the stored MACs. When the printer-uuid changes (another device now answers at this address) the stored
 * MACs are dropped with it.
 */
export function mergeIdentity(
  previous: PrinterIdentity,
  lookup: { uuid?: string | null; model?: string | null; snmpMacs?: (Buffer | string)[] | null },
): PrinterIdentity {
  const uuid = normalizeUuid(lookup.uuid ?? null);
  const deviceChanged = uuid !== null && previous.deviceUuid !== null && uuid !== previous.deviceUuid;
  const snmpRead = Array.isArray(lookup.snmpMacs);
  const macs = new Set<string>(deviceChanged || snmpRead ? [] : previous.macAddresses);
  for (const m of lookup.snmpMacs ?? []) {
    const n = normalizeMac(m);
    if (n) macs.add(n);
  }
  const fromUuid = macFromPrinterUuid(uuid, lookup.model ?? null);
  if (fromUuid) macs.add(fromUuid);
  return { deviceUuid: uuid ?? previous.deviceUuid, macAddresses: [...macs].sort() };
}
