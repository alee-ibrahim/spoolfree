import type { IppValue } from "./encoding";

/** Pure helpers that turn raw IPP printer attributes into Spoolfree concepts. */

export const DRIVERLESS_FORMATS = ["image/pwg-raster", "image/urf", "application/pdf"] as const;

export const TEST_ATTRIBUTES = [
  "printer-make-and-model",
  "printer-name",
  "printer-info",
  "printer-location",
  "printer-uuid",
  "printer-state",
  "printer-state-reasons",
  "document-format-supported",
  "ipp-versions-supported",
  "ipp-features-supported",
  "urf-supported",
  "pwg-raster-document-resolution-supported",
  "color-supported",
  "sides-supported",
  "sides-default",
  "printer-uri-supported",
  "printer-device-id",
  "compression-supported",
];

export const STATUS_ATTRIBUTES = [
  "printer-state",
  "printer-state-reasons",
  "printer-state-message",
  "printer-is-accepting-jobs",
  "marker-names",
  "marker-levels",
  "marker-colors",
  "marker-types",
  "marker-low-levels",
  "marker-high-levels",
  "printer-impressions-completed",
  "printer-make-and-model",
];

export type PrinterState = "idle" | "processing" | "stopped" | "unknown";

export interface Marker {
  name: string;
  type: string | null;
  color: string | null;
  /** 0-100, or null when the printer reports "unknown"/"some remaining". */
  level: number | null;
  low: boolean;
}

export interface PrinterStatus {
  online: boolean;
  state: PrinterState;
  stateReasons: string[];
  stateMessage: string | null;
  markers: Marker[];
  pageCount: number | null;
  model: string | null;
  source: "ipp" | "snmp" | "none";
  error: string | null;
}

export interface DriverlessCheck {
  ok: boolean;
  formats: string[];
  driverlessFormats: string[];
  ippVersions: string[];
  model: string | null;
  uuid: string | null;
  features: string[];
  color: boolean | null;
  duplex: boolean;
  /** IPP sides-supported / sides-default (one-sided, two-sided-long-edge, two-sided-short-edge). */
  sidesSupported?: string[];
  sidesDefault?: string | null;
  /** IEEE 1284 device ID (printer-device-id), used to match vendor driver packages. */
  deviceId?: string | null;
  /** compression-supported (none, deflate, gzip, ...); absent on old test results. */
  compression?: string[];
  /** Highest pwg-raster-document-resolution-supported (dpi), null when not advertised. */
  maxRasterDpi?: number | null;
  problems: string[];
}

function strings(v: IppValue[] | undefined): string[] {
  return (v ?? []).filter((x): x is string => typeof x === "string");
}
function numbers(v: IppValue[] | undefined): number[] {
  return (v ?? []).map((x) => (typeof x === "number" ? x : NaN));
}
function first<T extends IppValue>(v: IppValue[] | undefined): T | null {
  return (v?.[0] as T | undefined) ?? null;
}

export function checkDriverless(attrs: Record<string, IppValue[]>): DriverlessCheck {
  const formats = strings(attrs["document-format-supported"]).map((f) => f.toLowerCase());
  const driverlessFormats = DRIVERLESS_FORMATS.filter((f) => formats.includes(f));
  const ippVersions = strings(attrs["ipp-versions-supported"]);
  const problems: string[] = [];
  if (driverlessFormats.length === 0)
    problems.push("Printer does not advertise image/pwg-raster, image/urf or application/pdf.");
  if (!ippVersions.some((v) => v.startsWith("2.")))
    problems.push("Printer does not advertise IPP 2.x; Windows' IPP Class Driver expects IPP Everywhere / Mopria.");
  const sides = strings(attrs["sides-supported"]);
  return {
    ok: driverlessFormats.length > 0,
    formats,
    driverlessFormats,
    ippVersions,
    model: first<string>(attrs["printer-make-and-model"]),
    uuid: first<string>(attrs["printer-uuid"]),
    features: strings(attrs["ipp-features-supported"]),
    color: first<boolean>(attrs["color-supported"]),
    duplex: sides.some((s) => s.startsWith("two-sided")),
    sidesSupported: sides,
    sidesDefault: first<string>(attrs["sides-default"]),
    deviceId: first<string>(attrs["printer-device-id"]),
    compression: strings(attrs["compression-supported"]).map((c) => c.toLowerCase()),
    maxRasterDpi: maxDpi(attrs["pwg-raster-document-resolution-supported"]),
    problems,
  };
}

function maxDpi(v: IppValue[] | undefined): number | null {
  let best: number | null = null;
  for (const r of v ?? []) {
    if (r && typeof r === "object" && "x" in r && typeof r.x === "number") {
      // units 3 = dots per inch, 4 = dots per cm.
      const dpi = r.units === 4 ? Math.round(Math.max(r.x, r.y as number) * 2.54) : Math.max(r.x, r.y as number);
      best = best === null ? dpi : Math.max(best, dpi);
    }
  }
  return best;
}

const STATE_MAP: Record<number, PrinterState> = { 3: "idle", 4: "processing", 5: "stopped" };

export function normalizeLevel(level: number, high: number | undefined): number | null {
  // RFC 3805 / PWG: -1 other, -2 unknown, -3 "some remaining".
  if (!Number.isFinite(level) || level < 0) return null;
  const max = high && high > 0 ? high : 100;
  return Math.max(0, Math.min(100, Math.round((level / max) * 100)));
}

export function markersFrom(attrs: Record<string, IppValue[]>, lowPercent: number): Marker[] {
  const names = strings(attrs["marker-names"]);
  const levels = numbers(attrs["marker-levels"]);
  const highs = numbers(attrs["marker-high-levels"]);
  const lows = numbers(attrs["marker-low-levels"]);
  const colors = strings(attrs["marker-colors"]);
  const types = strings(attrs["marker-types"]);
  return names.map((name, i) => {
    const level = normalizeLevel(levels[i], highs[i]);
    const lowThreshold = Number.isFinite(lows[i]) && lows[i] > 0 ? lows[i] : lowPercent;
    return {
      name,
      type: types[i] ?? null,
      color: colors[i] ?? null,
      level,
      low: level !== null && level <= lowThreshold,
    };
  });
}

/** Reasons that mean someone has to walk to the printer. */
export const ATTENTION_REASONS = [
  "media-jam",
  "media-empty",
  "media-needed",
  "toner-empty",
  "marker-supply-empty",
  "door-open",
  "cover-open",
  "input-tray-missing",
  "output-area-full",
  "paused",
  "offline",
];

export function stripSeverity(reason: string): string {
  return reason.replace(/-(report|warning|error)$/, "");
}

export function statusFromIpp(attrs: Record<string, IppValue[]>, lowPercent: number): PrinterStatus {
  const stateNum = first<number>(attrs["printer-state"]);
  const reasons = strings(attrs["printer-state-reasons"]).filter((r) => r !== "none");
  const pages = first<number>(attrs["printer-impressions-completed"]);
  return {
    online: true,
    state: (stateNum !== null && STATE_MAP[stateNum]) || "unknown",
    stateReasons: reasons,
    stateMessage: first<string>(attrs["printer-state-message"]),
    markers: markersFrom(attrs, lowPercent),
    pageCount: typeof pages === "number" && pages >= 0 ? pages : null,
    model: first<string>(attrs["printer-make-and-model"]),
    source: "ipp",
    error: null,
  };
}

export function offlineStatus(error: string): PrinterStatus {
  return {
    online: false,
    state: "unknown",
    stateReasons: [],
    stateMessage: null,
    markers: [],
    pageCount: null,
    model: null,
    source: "none",
    error,
  };
}

export function needsAttention(s: Pick<PrinterStatus, "stateReasons">): string[] {
  return s.stateReasons.map(stripSeverity).filter((r) => ATTENTION_REASONS.includes(r));
}

export function lowMarkers(s: Pick<PrinterStatus, "markers">): Marker[] {
  return s.markers.filter((m) => m.low);
}

/** Build the IPP URI Windows and the poller should use for a printer. */
export function printerUri(p: { host: string; port?: number | null; ippPath?: string | null; useTls?: boolean | null }): string {
  const scheme = p.useTls ? "ipps" : "ipp";
  const port = p.port ?? 631;
  const path = (p.ippPath ?? "/ipp/print").startsWith("/") ? (p.ippPath ?? "/ipp/print") : `/${p.ippPath}`;
  const host = p.host.includes(":") && !p.host.startsWith("[") ? `[${p.host}]` : p.host;
  return `${scheme}://${host}:${port}${path}`;
}
