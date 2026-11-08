import type { DriverInf, DriverMode, SpeedSample, VendorProtocol } from "../db/schema";
import type { DriverlessCheck } from "../ipp/interpret";
import { infForDriver } from "./package";

/**
 * Driver mode decisions (pure). A printer in driver mode "auto" gets the vendor driver when the server sees that it
 * needs one, and the IPP Class Driver otherwise:
 *   - vendor: the last Test found no driverless format (PWG raster, URF, PDF), or IPP 1.x only;
 *   - vendor: measured slow (median seconds per page of recent completed IPP jobs above a threshold);
 *   - vendor: static hint: raster only (no PDF), no raster compression, 600-dpi colour (old Brother colour lasers);
 *   - driverless otherwise.
 * Once auto mode wants a vendor driver the decision is stored (printers.auto_vendor_reason) and sticks until an admin
 * changes the driver mode or replaces the device. The vendor driver comes from a matching package: the exact model
 * (IEEE 1284 device ID or make and model) first, then the brand's universal package. Without one the printer stays
 * driverless and the UI says which driver to upload.
 */

export interface AutoSettings {
  slowSecondsPerPage: number;
  slowMinJobs: number;
  slowMinPages: number;
}

export const DEFAULT_AUTO_SETTINGS: AutoSettings = { slowSecondsPerPage: 20, slowMinJobs: 3, slowMinPages: 2 };

export interface PackageForMatch {
  id: string;
  name: string;
  sha256: string;
  size: number;
  universal: boolean;
  universalDriver: string | null;
  manufacturer: string | null;
  infs: DriverInf[];
  uploadedAt?: Date | string;
}

export interface PrinterForDecision {
  driverMode: DriverMode;
  driverPackageId: string | null;
  driverName: string | null;
  vendorProtocol: VendorProtocol;
  lprQueue: string | null;
  model: string | null;
  deviceId: string | null;
  autoVendorReason: string | null;
  speedSamples: SpeedSample[];
  lastTest: (Partial<DriverlessCheck> & { ok?: boolean }) | null;
}

export interface DriverDecision {
  /** What PCs get. */
  mode: "driverless" | "vendor";
  /** manual: driverMode driverless/vendor; auto: decided here. */
  source: "manual" | "auto";
  /** Auto: a vendor driver is wanted (also when no package matches). */
  wantVendor: boolean;
  /** Why, in a few words. */
  reason: string;
  /** Auto wants a vendor driver but no package matches: what to upload. */
  needed: string | null;
  package: PackageForMatch | null;
  driverName: string | null;
  inf: DriverInf | null;
  match: "manual" | "exact" | "universal" | null;
  protocol: VendorProtocol;
  lprQueue: string | null;
}

/** Lower-case letters and digits only. */
export const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const stripSeries = (s: string) => s.replace(/series$/, "");

/** MFG and MDL of an IEEE 1284 device ID ("MFG:Brother;CMD:PJL;MDL:HL-3150CDN series;..."). */
export function parseDeviceId(id: string | null | undefined): { mfg: string | null; mdl: string | null } {
  const out: { mfg: string | null; mdl: string | null } = { mfg: null, mdl: null };
  for (const part of (id ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toUpperCase();
    const v = part.slice(i + 1).trim();
    if ((k === "MFG" || k === "MANUFACTURER") && v) out.mfg = v;
    if ((k === "MDL" || k === "MODEL") && v) out.mdl = v;
  }
  return out;
}

const BRAND_ALIASES: Record<string, string> = { hewlettpackard: "hp", hpinc: "hp", hpe: "hp", kyoceramita: "kyocera", konica: "konicaminolta" };
export function brandKey(s: string | null | undefined): string | null {
  const first = norm((s ?? "").trim().split(/\s+/)[0]);
  if (!first) return null;
  const whole = norm(s);
  for (const [k, v] of Object.entries(BRAND_ALIASES)) if (whole.startsWith(k)) return v;
  return BRAND_ALIASES[first] ?? first;
}

/**
 * Does an INF hardware ID name this device? 1284 IDs are MFG+MDL without spaces, truncated, plus a 4-hex checksum
 * ("BrotherHL-3150CDN_seri8E9A", "USBPRINT\BrotherHL-3150CDN_seri8E9A", "WSDPRINT\..."). Compared letters and
 * digits only, as a prefix of MFG+MDL (the ID is truncated), at least 8 characters long.
 */
export function hardwareIdMatches(hardwareId: string, mfg: string | null, mdl: string | null): boolean {
  if (!mdl) return false;
  const core = hardwareId.slice(hardwareId.lastIndexOf("\\") + 1);
  const target = norm(`${mfg ?? ""}${mdl}`);
  const candidates = [norm(core)];
  if (/[0-9a-fA-F]{4}$/.test(core) && core.length > 12) candidates.push(norm(core.slice(0, -4)));
  return candidates.some((c) => c.length >= 8 && (target === c || target.startsWith(c)));
}

/** The device's make and model as a driver name would say it: printer-make-and-model or the admin's model field. */
function modelNames(p: Pick<PrinterForDecision, "model" | "deviceId" | "lastTest">): string[] {
  const { mfg, mdl } = parseDeviceId(p.deviceId ?? p.lastTest?.deviceId ?? null);
  const names = [p.lastTest?.model ?? null, p.model, mdl && mfg ? `${mfg} ${mdl}` : null, mdl].filter((x): x is string => !!x);
  return [...new Set(names)];
}

export interface PackageMatch {
  package: PackageForMatch;
  driverName: string;
  inf: DriverInf;
  match: "exact" | "universal";
}

/** Best package for a device: exact model (hardware ID, then name), newest upload first; then the brand's universal package. */
export function matchPackage(p: Pick<PrinterForDecision, "model" | "deviceId" | "lastTest">, packages: PackageForMatch[]): PackageMatch | null {
  const { mfg, mdl } = parseDeviceId(p.deviceId ?? p.lastTest?.deviceId ?? null);
  const names = modelNames(p).map((n) => stripSeries(norm(n))).filter((n) => n.length >= 4);
  const newest = [...packages].sort((a, b) => new Date(b.uploadedAt ?? 0).getTime() - new Date(a.uploadedAt ?? 0).getTime());
  for (const pass of ["hwid", "name"] as const) {
    for (const pkg of newest.filter((x) => !x.universal)) {
      for (const inf of pkg.infs) {
        for (const m of inf.models) {
          const ok =
            pass === "hwid"
              ? m.hardwareIds.some((h) => hardwareIdMatches(h, mfg, mdl))
              : names.includes(stripSeries(norm(m.name)));
          if (ok) return { package: pkg, driverName: m.name, inf, match: "exact" };
        }
      }
    }
  }
  const brand = brandKey(mfg) ?? brandKey(p.lastTest?.model ?? p.model);
  if (!brand) return null;
  for (const pkg of newest.filter((x) => x.universal)) {
    if (brandKey(pkg.manufacturer) !== brand) continue;
    const name = pkg.universalDriver ?? pkg.infs[0]?.models[0]?.name;
    const inf = name ? infForDriver(pkg.infs, name) : null;
    if (name && inf) return { package: pkg, driverName: inf.models.find((m) => m.name.toLowerCase() === name.toLowerCase())!.name, inf, match: "universal" };
  }
  return null;
}

/** Median seconds per page of the samples with at least minPages pages; null with fewer than minJobs such jobs. */
export function medianSecondsPerPage(samples: SpeedSample[], s: Pick<AutoSettings, "slowMinJobs" | "slowMinPages">): { median: number; jobs: number } | null {
  const v = samples.filter((x) => x.pages >= s.slowMinPages && x.seconds > 0).map((x) => x.seconds / x.pages);
  if (v.length < s.slowMinJobs) return null;
  v.sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return { median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, jobs: v.length };
}

/** Auto mode's evaluation of the device, ignoring stickiness: a reason to use a vendor driver, or null. */
export function vendorReason(p: Pick<PrinterForDecision, "lastTest" | "speedSamples">, s: AutoSettings = DEFAULT_AUTO_SETTINGS): string | null {
  const t = p.lastTest;
  if (t && t.ok === false && t.formats !== undefined) return "no driverless format (PWG raster, URF or PDF)";
  if (t && t.ippVersions && t.ippVersions.length > 0 && !t.ippVersions.some((v) => v.startsWith("2."))) return `IPP ${t.ippVersions.join("/")} only`;
  const speed = medianSecondsPerPage(p.speedSamples ?? [], s);
  if (speed && speed.median > s.slowSecondsPerPage) return `slow: median ${Math.round(speed.median)} s/page over ${speed.jobs} jobs`;
  if (t && t.formats && t.compression && t.compression.length > 0) {
    const raster = t.formats.includes("image/pwg-raster") || t.formats.includes("image/urf");
    const noPdf = !t.formats.includes("application/pdf");
    const noCompression = t.compression.every((c) => c === "none");
    if (raster && noPdf && noCompression && t.color === true && (t.maxRasterDpi ?? 600) <= 600)
      return "raster only, no compression (600-dpi colour raster is slow)";
  }
  return null;
}

/** The driver PCs get for a printer, and why. */
export function decideDriver(p: PrinterForDecision, packages: PackageForMatch[], s: AutoSettings = DEFAULT_AUTO_SETTINGS): DriverDecision {
  const base = { protocol: p.vendorProtocol ?? "raw9100", lprQueue: p.lprQueue ?? null };
  const driverless = (source: "manual" | "auto", reason: string, wantVendor = false, needed: string | null = null): DriverDecision => ({
    ...base,
    mode: "driverless",
    source,
    wantVendor,
    reason,
    needed,
    package: null,
    driverName: null,
    inf: null,
    match: null,
  });
  if (p.driverMode === "driverless") return driverless("manual", "set to driverless");
  if (p.driverMode === "vendor") {
    const pkg = packages.find((x) => x.id === p.driverPackageId) ?? null;
    const inf = pkg && p.driverName ? infForDriver(pkg.infs, p.driverName) : null;
    if (!pkg || !inf || !p.driverName) return driverless("manual", "vendor driver not set (package or driver missing)", true, "choose a driver package");
    return { ...base, mode: "vendor", source: "manual", wantVendor: true, reason: "set to vendor driver", needed: null, package: pkg, driverName: p.driverName, inf, match: "manual" };
  }
  const reason = p.autoVendorReason ?? vendorReason(p, s);
  if (!reason) {
    const t = p.lastTest;
    if (!t) return driverless("auto", "not tested yet");
    const v2 = (t.ippVersions ?? []).filter((v) => v.startsWith("2.")).sort().at(-1);
    const formats = (t.driverlessFormats ?? []).map((f) => f.split("/")[1]).join(", ");
    return driverless("auto", `driverless-capable (${v2 ? `IPP ${v2}` : "IPP"}${formats ? `, ${formats}` : ""})`);
  }
  const m = matchPackage(p, packages);
  if (!m) {
    const model = modelNames(p)[0] ?? "this model";
    return driverless("auto", reason, true, `vendor driver needed: upload one for ${model}`);
  }
  return { ...base, mode: "vendor", source: "auto", wantVendor: true, reason, needed: null, package: m.package, driverName: m.driverName, inf: m.inf, match: m.match };
}

/** Auto mode's new sticky reason to store, or null when nothing changes. */
export function newStickyReason(p: PrinterForDecision, s: AutoSettings = DEFAULT_AUTO_SETTINGS): string | null {
  if (p.driverMode !== "auto" || p.autoVendorReason) return null;
  return vendorReason(p, s);
}

/**
 * Speed samples from Get-Jobs job records: jobs with time-at-processing, time-at-completed and pages, merged into the
 * stored list by job id (newest last, at most `max`).
 */
export function mergeSpeedSamples(stored: SpeedSample[], jobs: Record<string, unknown[]>[], now: Date, max = 20): SpeedSample[] {
  const byId = new Map(stored.map((s) => [s.jobId, s]));
  for (const j of jobs) {
    const id = Number(j["job-id"]?.[0]);
    const start = Number(j["time-at-processing"]?.[0]);
    const end = Number(j["time-at-completed"]?.[0]);
    const pages = Number(j["job-impressions-completed"]?.[0] ?? j["job-media-sheets-completed"]?.[0]);
    const state = Number(j["job-state"]?.[0] ?? 9);
    if (!Number.isInteger(id) || id <= 0 || byId.has(id)) continue;
    if (state !== 9 || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start || !(pages >= 1)) continue;
    byId.set(id, { jobId: id, pages, seconds: end - start, at: now.toISOString() });
  }
  return [...byId.values()].slice(-max);
}
