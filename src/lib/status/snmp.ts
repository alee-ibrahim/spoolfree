import snmp from "net-snmp";
import type { Marker, PrinterState, PrinterStatus } from "../ipp/interpret";

/** SNMP Printer-MIB (RFC 3805) + Host-Resources-MIB fallback for printers without useful IPP. */

export const OID = {
  hrDeviceDescr: "1.3.6.1.2.1.25.3.2.1.3.1",
  hrPrinterStatus: "1.3.6.1.2.1.25.3.5.1.1.1",
  hrPrinterDetectedErrorState: "1.3.6.1.2.1.25.3.5.1.2.1",
  prtMarkerLifeCount: "1.3.6.1.2.1.43.10.2.1.4.1.1",
  suppliesDescription: "1.3.6.1.2.1.43.11.1.1.6.1",
  suppliesMaxCapacity: "1.3.6.1.2.1.43.11.1.1.8.1",
  suppliesLevel: "1.3.6.1.2.1.43.11.1.1.9.1",
  ifPhysAddress: "1.3.6.1.2.1.2.2.1.6",
} as const;

const ERROR_BITS: [number, string][] = [
  [0, "media-low"],
  [1, "media-empty"],
  [2, "toner-low"],
  [3, "toner-empty"],
  [4, "door-open"],
  [5, "media-jam"],
  [6, "offline"],
  [7, "service-requested"],
  [8, "input-tray-missing"],
  [9, "output-tray-missing"],
  [10, "marker-supply-missing"],
  [11, "output-area-almost-full"],
  [12, "output-area-full"],
  [13, "media-empty"],
  [14, "overdue-maintenance"],
];

/** hrPrinterDetectedErrorState: bit 0 is the MSB of the first octet. */
export function errorStateToReasons(bytes: Buffer): string[] {
  const out = new Set<string>();
  for (const [bit, reason] of ERROR_BITS) {
    const byte = bytes[bit >> 3];
    if (byte === undefined) continue;
    if (byte & (0x80 >> (bit & 7))) out.add(reason);
  }
  return [...out];
}

export function hrStatusToState(v: number | null): PrinterState {
  if (v === 3) return "idle";
  if (v === 4 || v === 5) return "processing";
  return "unknown";
}

export interface SupplyRow {
  description: string;
  max: number;
  level: number;
}

export function suppliesToMarkers(rows: SupplyRow[], lowPercent: number): Marker[] {
  return rows.map((r) => {
    let level: number | null = null;
    if (r.level >= 0 && r.max > 0) level = Math.max(0, Math.min(100, Math.round((r.level / r.max) * 100)));
    const name = r.description.replace(/\0/g, "").trim();
    const lower = name.toLowerCase();
    const color =
      ["black", "cyan", "magenta", "yellow"].find((c) => lower.includes(c)) ?? null;
    return { name, type: null, color, level, low: level !== null && level <= lowPercent };
  });
}

function snmpGet(session: snmp.Session, oids: string[]): Promise<(snmp.Varbind | null)[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      resolve((varbinds ?? []).map((vb) => (snmp.isVarbindError(vb) ? null : vb)));
    });
  });
}

function snmpWalk(session: snmp.Session, oid: string): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    const out: snmp.Varbind[] = [];
    session.subtree(
      oid,
      (vbs) => {
        for (const vb of vbs) if (!snmp.isVarbindError(vb)) out.push(vb);
      },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

function num(vb: snmp.Varbind | null | undefined): number | null {
  if (!vb) return null;
  const v = vb.value as unknown;
  return typeof v === "number" ? v : null;
}

export async function snmpStatus(
  host: string,
  community: string,
  timeoutMs: number,
  lowPercent: number,
  /** For tests: a session-like object instead of a real SNMP session. */
  makeSession: () => snmp.Session = () => snmp.createSession(host, community, { version: snmp.Version2c, timeout: timeoutMs, retries: 1 }),
): Promise<PrinterStatus> {
  const session = makeSession();
  try {
    const [descr, status, errors, life] = await snmpGet(session, [
      OID.hrDeviceDescr,
      OID.hrPrinterStatus,
      OID.hrPrinterDetectedErrorState,
      OID.prtMarkerLifeCount,
    ]);
    // Some devices (seen on a Brother DCP-L3551CDW) answer GETs but time out on the supplies table walk (GetBulk).
    // The page counter and state from the GET still count; supplies are then just unknown.
    const walk = (oid: string) => snmpWalk(session, oid).catch(() => [] as snmp.Varbind[]);
    const [descs, maxes, levels] = await Promise.all([walk(OID.suppliesDescription), walk(OID.suppliesMaxCapacity), walk(OID.suppliesLevel)]);
    const rows: SupplyRow[] = descs.map((d, i) => ({
      description: Buffer.isBuffer(d.value) ? d.value.toString("utf8") : String(d.value),
      max: num(maxes[i]) ?? -1,
      level: num(levels[i]) ?? -1,
    }));
    const errBuf = errors && Buffer.isBuffer(errors.value) ? errors.value : Buffer.alloc(0);
    return {
      online: true,
      state: hrStatusToState(num(status)),
      stateReasons: errorStateToReasons(errBuf),
      stateMessage: null,
      markers: suppliesToMarkers(rows, lowPercent),
      pageCount: num(life),
      model: descr && Buffer.isBuffer(descr.value) ? descr.value.toString("utf8") : null,
      source: "snmp",
      error: null,
    };
  } finally {
    session.close();
  }
}

/** Raw ifPhysAddress values of the printer's interfaces (IF-MIB); callers validate them (normalizeMac). */
export async function snmpPhysAddresses(host: string, community: string, timeoutMs: number): Promise<Buffer[]> {
  const session = snmp.createSession(host, community, { version: snmp.Version2c, timeout: timeoutMs, retries: 1 });
  try {
    const vbs = await snmpWalk(session, OID.ifPhysAddress);
    return vbs.map((vb) => vb.value).filter((v): v is Buffer => Buffer.isBuffer(v));
  } finally {
    session.close();
  }
}
