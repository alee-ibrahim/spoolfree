import { DEFAULT_SIDES, DRIVER_MODES, LEGACY_TAKEOVER_MODES, type DefaultSides, type DriverMode, type LegacyTakeover } from "../db/schema";
import { normalizeDn } from "../dn";
import { lowMarkers, needsAttention, type Marker } from "../ipp/interpret";
import { countActive, flag, matchesWords, one, oneOf, words, type SearchParams } from "./params";

export const PRINTER_HEALTH = ["online", "offline", "error"] as const;
export type PrinterHealth = (typeof PRINTER_HEALTH)[number] | "pending";
export const PRINTER_SORTS = ["name", "location", "status"] as const;
export type PrinterSort = (typeof PRINTER_SORTS)[number];

export interface PrinterFilters {
  q: string | null;
  /** A directly assigned OU (DN). */
  ou: string | null;
  brand: string | null;
  status: (typeof PRINTER_HEALTH)[number] | null;
  low: boolean;
  unassigned: boolean;
  takeover: LegacyTakeover | null;
  sides: DefaultSides | null;
  driver: DriverMode | null;
  sort: PrinterSort;
}

export function parsePrinterFilters(sp: SearchParams): PrinterFilters {
  return {
    q: one(sp, "q", 200),
    ou: one(sp, "ou", 2048),
    brand: one(sp, "brand", 64),
    status: oneOf(sp, "status", PRINTER_HEALTH),
    low: flag(sp, "low"),
    unassigned: flag(sp, "unassigned"),
    takeover: oneOf(sp, "takeover", LEGACY_TAKEOVER_MODES),
    sides: oneOf(sp, "sides", DEFAULT_SIDES),
    driver: oneOf(sp, "driver", DRIVER_MODES),
    sort: oneOf(sp, "sort", PRINTER_SORTS) ?? "name",
  };
}

export const activePrinterFilters = (f: PrinterFilters) => countActive({ ...f });

export interface PrinterStatusLike {
  online: boolean;
  stateReasons: string[];
  markers: Marker[];
}

export interface PrinterFilterRow {
  name: string;
  host: string;
  model: string | null;
  location: string | null;
  deviceId?: string | null;
  legacyAliases: string[];
  legacyShares: string[];
  /** DNs of the OUs the printer is assigned to directly. */
  ouDns: string[];
  legacyTakeover: LegacyTakeover;
  defaultSides: DefaultSides;
  driverMode: DriverMode;
  status: PrinterStatusLike | null;
}

const BRANDS: [RegExp, string][] = [
  [/^(hp|hewlett[- ]?packard)\b/i, "HP"],
  [/^konica[- ]?minolta\b/i, "Konica Minolta"],
  [/^fuji ?xerox\b/i, "Fuji Xerox"],
  [/^fujifilm\b/i, "Fujifilm"],
  [/^kyocera\b/i, "Kyocera"],
  [/^oki(data)?\b/i, "OKI"],
  [/^(brother|canon|epson|lexmark|ricoh|sharp|toshiba|xerox|samsung|dell|pantum|develop|sindoh|utax|triumph-adler)\b/i, ""],
];

/** Normalises a manufacturer or model's first word to a brand ("HEWLETT-PACKARD" -> "HP", "brother" -> "Brother"). */
function brandOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [re, name] of BRANDS) {
    const m = t.match(re);
    if (m) return name || m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  }
  const first = t.split(/\s+/)[0];
  return first.length > 1 ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

/** The printer's brand: the IEEE 1284 device ID's MFG when known, else the model's first word. */
export function printerBrand(model: string | null | undefined, deviceId?: string | null): string | null {
  const mfg = deviceId?.match(/(?:^|;)\s*(?:MFG|MANUFACTURER)\s*:\s*([^;]+)/i)?.[1];
  return (mfg && brandOf(mfg)) || (model ? brandOf(model) : null);
}

/** online (and nothing needs attention), error (jam, paper out, door open...), offline, or pending (never polled). */
export function printerHealth(s: PrinterStatusLike | null): PrinterHealth {
  if (!s) return "pending";
  if (!s.online) return "offline";
  return needsAttention(s).length ? "error" : "online";
}

const HEALTH_ORDER: Record<PrinterHealth, number> = { error: 0, offline: 1, pending: 2, online: 3 };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Filters and sorts printers (server-side; the printer list is small). */
export function filterPrinters<T extends PrinterFilterRow>(rows: T[], f: PrinterFilters): T[] {
  const terms = words(f.q);
  const ou = f.ou ? normalizeDn(f.ou) : null;
  const brand = f.brand?.toLowerCase();
  const out = rows.filter((p) => {
    if (!matchesWords(terms, [p.name, p.host, p.model, p.location, ...p.legacyAliases, ...p.legacyShares])) return false;
    if (ou && !p.ouDns.some((d) => normalizeDn(d) === ou)) return false;
    if (brand && printerBrand(p.model, p.deviceId)?.toLowerCase() !== brand) return false;
    if (f.status && printerHealth(p.status) !== f.status) return false;
    if (f.low && !(p.status && lowMarkers(p.status).length)) return false;
    if (f.unassigned && p.ouDns.length > 0) return false;
    if (f.takeover && p.legacyTakeover !== f.takeover) return false;
    if (f.sides && p.defaultSides !== f.sides) return false;
    if (f.driver && p.driverMode !== f.driver) return false;
    return true;
  });
  if (f.sort === "status") return out.sort((a, b) => HEALTH_ORDER[printerHealth(a.status)] - HEALTH_ORDER[printerHealth(b.status)] || byName(a, b));
  if (f.sort === "location")
    return out.sort((a, b) => {
      if (!a.location !== !b.location) return a.location ? -1 : 1;
      return (a.location ?? "").localeCompare(b.location ?? "", undefined, { sensitivity: "base", numeric: true }) || byName(a, b);
    });
  return out.sort(byName);
}

/** Distinct brands for the filter, sorted. */
export function brandOptions(rows: Pick<PrinterFilterRow, "model" | "deviceId">[]): string[] {
  return [...new Set(rows.map((r) => printerBrand(r.model, r.deviceId)).filter((b): b is string => !!b))].sort((a, b) => a.localeCompare(b));
}
