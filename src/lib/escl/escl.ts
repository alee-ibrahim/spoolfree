/**
 * eSCL ("AirScan", Mopria Scan): the driverless scan protocol of network MFPs. Plain HTTP(S) with small XML documents
 * under a base path (usually /eSCL): GET ScannerCapabilities, GET ScannerStatus, POST ScanJobs, GET <job>/NextDocument.
 * Pure helpers here (parsing, choices, request bodies); the HTTP side is in ./client.
 */

export type ScannerState = "idle" | "processing" | "testing" | "stopped" | "down" | "unknown";
export type ScanSource = "platen" | "feeder";
export type ScanColor = "gray" | "color";

export interface ScanSourceCaps {
  colorModes: string[];
  /** Discrete resolutions (dpi), plus 150/300 when the scanner gives a range that includes them. */
  resolutions: number[];
  formats: string[];
  /** In 1/300 inch, 0 when not given. */
  maxWidth: number;
  maxHeight: number;
}

/** Where the eSCL service answers on the device (the host is always the printer's own, never stored here). */
export interface EsclEndpoint {
  scheme: "http" | "https";
  port: number;
  path: string;
}

/** What Spoolfree stores per printer about its scanner (printers.scanner). */
export interface ScannerInfo extends EsclEndpoint {
  version: string | null;
  makeAndModel: string | null;
  platen: ScanSourceCaps | null;
  feeder: ScanSourceCaps | null;
}

export interface ScannerStatusInfo {
  state: ScannerState;
  /** eSCL AdfState without the "ScannerAdf" prefix, e.g. "Empty", "Loaded", "Jam"; null when there is no feeder. */
  adfState: string | null;
}

const NS_SCAN = "http://schemas.hp.com/imaging/escl/2011/05/03";
const NS_PWG = "http://www.pwg.org/schemas/2010/12/sm";

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inner XML of every element named `tag`, whatever its namespace prefix (scan:, pwg:, none). */
export function elements(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function text(xml: string, tag: string): string | null {
  const v = elements(xml, tag)[0];
  return v === undefined ? null : unescapeXml(v.trim()) || null;
}

function texts(xml: string, tag: string): string[] {
  return elements(xml, tag)
    .map((v) => unescapeXml(v.trim()))
    .filter(Boolean);
}

const STATES: Record<string, ScannerState> = { idle: "idle", processing: "processing", testing: "testing", stopped: "stopped", down: "down" };

export function parseScannerStatus(xml: string): ScannerStatusInfo {
  if (!/ScannerStatus/.test(xml)) throw new Error("not an eSCL ScannerStatus document");
  const state = STATES[(text(xml, "State") ?? "").toLowerCase()] ?? "unknown";
  const adf = text(xml, "AdfState");
  return { state, adfState: adf ? adf.replace(/^ScannerAdf/, "") : null };
}

function sourceCaps(xml: string): ScanSourceCaps {
  const resolutions = new Set<number>();
  for (const r of elements(xml, "DiscreteResolution")) {
    const x = Number(text(r, "XResolution"));
    const y = Number(text(r, "YResolution") ?? x);
    if (Number.isFinite(x) && x > 0 && x === y) resolutions.add(x);
  }
  for (const r of elements(xml, "ResolutionRange")) {
    const min = Number(text(elements(r, "XResolutionRange")[0] ?? r, "Min"));
    const max = Number(text(elements(r, "XResolutionRange")[0] ?? r, "Max"));
    if (Number.isFinite(min) && Number.isFinite(max)) for (const d of [min, 150, 300, max]) if (d >= min && d <= max && d > 0) resolutions.add(d);
  }
  const formats = new Set([...texts(xml, "DocumentFormatExt"), ...texts(xml, "DocumentFormat")].map((f) => f.toLowerCase()));
  return {
    colorModes: [...new Set(texts(xml, "ColorMode"))],
    resolutions: [...resolutions].sort((a, b) => a - b),
    formats: [...formats],
    maxWidth: Number(text(xml, "MaxWidth")) || 0,
    maxHeight: Number(text(xml, "MaxHeight")) || 0,
  };
}

/** ScannerCapabilities: the flatbed (Platen) and the document feeder (Adf, simplex caps). */
export function parseCapabilities(xml: string): Omit<ScannerInfo, keyof EsclEndpoint> {
  if (!/ScannerCapabilities/.test(xml)) throw new Error("not an eSCL ScannerCapabilities document");
  const platen = elements(xml, "Platen")[0];
  const adf = elements(xml, "Adf")[0];
  const adfCaps = adf !== undefined ? (elements(adf, "AdfSimplexInputCaps")[0] ?? adf) : undefined;
  return {
    version: text(xml.replace(/<(?:[\w.-]+:)?(Platen|Adf)[\s>][\s\S]*?<\/(?:[\w.-]+:)?\1\s*>/g, ""), "Version"),
    makeAndModel: text(xml, "MakeAndModel"),
    platen: platen !== undefined ? sourceCaps(platen) : null,
    feeder: adfCaps !== undefined ? sourceCaps(adfCaps) : null,
  };
}

export interface ScanChoice {
  source: ScanSource;
  colorMode: string;
  dpi: number;
  format: string;
  /** In 1/300 inch: A4, clamped to what the source takes. */
  width: number;
  height: number;
}

/** Formats the browser can show or save, in order of preference. */
export const SCAN_FORMATS = ["image/jpeg", "image/png", "application/pdf"] as const;

/** 150 dpi when offered (a readable test image of modest size), else the nearest above up to 300, else the lowest. */
export function pickScanDpi(offered: number[]): number {
  if (!offered.length) return 150;
  if (offered.includes(150)) return 150;
  return offered.find((d) => d > 150 && d <= 300) ?? offered.filter((d) => d < 150).at(-1) ?? offered[0];
}

const A4_W = 2480;
const A4_H = 3508;

/** Settings for a test scan from `source`, or an error text when the scanner does not offer what is needed. */
export function chooseScan(info: Pick<ScannerInfo, "platen" | "feeder">, source: ScanSource, color: ScanColor): ScanChoice | string {
  const caps = source === "platen" ? info.platen : info.feeder;
  if (!caps) return source === "platen" ? "The scanner has no glass (platen)." : "The scanner has no document feeder.";
  const modes = caps.colorModes;
  const colorMode =
    color === "color"
      ? (modes.find((m) => m === "RGB24") ?? modes.find((m) => /^RGB/.test(m)))
      : (modes.find((m) => m === "Grayscale8") ?? modes.find((m) => /^Grayscale/.test(m)) ?? modes.find((m) => /^BlackAndWhite/.test(m)));
  if (!colorMode) return color === "color" ? "The scanner offers no colour mode." : "The scanner offers no greyscale or black-and-white mode.";
  const format = SCAN_FORMATS.find((f) => caps.formats.includes(f));
  if (!format) return `The scanner offers none of ${SCAN_FORMATS.join(", ")} (it lists ${caps.formats.join(", ") || "no formats"}).`;
  return {
    source,
    colorMode,
    dpi: pickScanDpi(caps.resolutions),
    format,
    width: caps.maxWidth > 0 ? Math.min(A4_W, caps.maxWidth) : A4_W,
    height: caps.maxHeight > 0 ? Math.min(A4_H, caps.maxHeight) : A4_H,
  };
}

export function scanSettingsXml(c: ScanChoice, version: string | null): string {
  const v = version && /^\d+(\.\d+)*$/.test(version) ? version : "2.0";
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${NS_SCAN}" xmlns:pwg="${NS_PWG}">
  <pwg:Version>${escapeXml(v)}</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${c.width}</pwg:Width>
      <pwg:Height>${c.height}</pwg:Height>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${c.source === "platen" ? "Platen" : "Feeder"}</pwg:InputSource>
  <scan:ColorMode>${escapeXml(c.colorMode)}</scan:ColorMode>
  <scan:XResolution>${c.dpi}</scan:XResolution>
  <scan:YResolution>${c.dpi}</scan:YResolution>
  <pwg:DocumentFormat>${escapeXml(c.format)}</pwg:DocumentFormat>
  <scan:DocumentFormatExt>${escapeXml(c.format)}</scan:DocumentFormatExt>
</scan:ScanSettings>
`;
}

export function describeScan(c: ScanChoice): string {
  const mode = /^RGB/.test(c.colorMode) ? "colour" : /^Grayscale/.test(c.colorMode) ? "greyscale" : "black and white";
  return `${c.source === "platen" ? "glass" : "feeder"}, ${mode}, ${c.dpi} dpi, ${c.format}`;
}

/** Base URL of the eSCL service on `host`. */
export function esclBase(host: string, e: EsclEndpoint): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${e.scheme}://${h}:${e.port}${e.path}`;
}

/**
 * Where to look for eSCL on a printer, most common first: HTTPS 443 and HTTP 80 (/eSCL on Brother, Canon, Epson,
 * Kyocera, Ricoh, Xerox), HTTP 8080 (HP), then the IPP port (some devices and the dev simulator serve it there).
 */
export function esclCandidates(p: { port?: number | null; useTls?: boolean | null }): EsclEndpoint[] {
  const out: EsclEndpoint[] = [
    { scheme: "https", port: 443, path: "/eSCL" },
    { scheme: "http", port: 80, path: "/eSCL" },
    { scheme: "http", port: 8080, path: "/eSCL" },
    { scheme: p.useTls ? "https" : "http", port: p.port ?? 631, path: "/eSCL" },
  ];
  return out.filter((e, i) => out.findIndex((o) => o.scheme === e.scheme && o.port === e.port) === i);
}

export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}
