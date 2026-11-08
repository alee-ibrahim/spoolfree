import type { DriverInf } from "../db/schema";
import { decodeInf, parseInf } from "./inf";
import { listEntries, readEntry, unsafeEntryName, ZipError, type ZipSource } from "./zip";

/** Largest total uncompressed size accepted (zip bomb guard; agents extract the whole package). */
export const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;

export interface PackageInspection {
  infs: DriverInf[];
  /** Manufacturer of the package: the first manufacturer named by its INFs (else the INF provider). */
  manufacturer: string | null;
  /** Printer INFs that were skipped and why (no x64 models, no catalog...). */
  notes: string[];
}

export class DriverPackageError extends Error {}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

/**
 * Validates a driver package zip and reads its printer INFs. Throws DriverPackageError when the zip is unsafe or has
 * no usable printer driver: every usable INF is printer class, has NTamd64 models and names a CatalogFile that is in
 * the zip next to it (only signed packages can be installed on x64 Windows; agents check the catalog's Authenticode
 * signature before installing).
 */
export async function inspectDriverPackage(src: ZipSource): Promise<PackageInspection> {
  let entries;
  try {
    entries = await listEntries(src);
  } catch (e) {
    throw new DriverPackageError(e instanceof ZipError ? e.message : `not a readable zip: ${(e as Error).message}`);
  }
  const bad = entries.find((e) => unsafeEntryName(e.name));
  if (bad) throw new DriverPackageError(`unsafe path in zip: ${bad.name}`);
  if (entries.some((e) => e.encrypted)) throw new DriverPackageError("encrypted zip entries are not supported");
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > MAX_UNCOMPRESSED_BYTES) throw new DriverPackageError("the package expands to more than 2 GiB");
  const files = new Map(entries.filter((e) => !e.directory).map((e) => [e.name.toLowerCase(), e]));

  const infs: DriverInf[] = [];
  const notes: string[] = [];
  const manufacturers: string[] = [];
  let provider: string | null = null;
  for (const e of entries.filter((x) => !x.directory && /\.inf$/i.test(x.name))) {
    let parsed;
    try {
      parsed = parseInf(decodeInf(await readEntry(src, e)));
    } catch (err) {
      notes.push(`${e.name}: unreadable (${(err as Error).message})`);
      continue;
    }
    if (!parsed.isPrinterClass) continue;
    if (!parsed.models.length) {
      notes.push(`${e.name}: no NTamd64 (x64) printer models`);
      continue;
    }
    if (!parsed.catalogFile) {
      notes.push(`${e.name}: no CatalogFile in [Version] (unsigned)`);
      continue;
    }
    const catPath = dirOf(e.name) + parsed.catalogFile.replace(/\\/g, "/");
    const cat = files.get(catPath.toLowerCase());
    if (!cat) {
      notes.push(`${e.name}: catalog ${parsed.catalogFile} is not in the zip`);
      continue;
    }
    infs.push({
      path: e.name,
      catalog: cat.name,
      driverVer: parsed.driverVer,
      provider: parsed.provider,
      manufacturers: parsed.manufacturers,
      models: parsed.models,
    });
    for (const m of parsed.manufacturers) if (!manufacturers.includes(m)) manufacturers.push(m);
    provider ??= parsed.provider;
  }
  if (!infs.length) {
    throw new DriverPackageError(
      `no signed x64 printer driver INF in the zip${notes.length ? `: ${notes.join("; ")}` : " (no printer-class .inf found)"}`,
    );
  }
  return { infs, manufacturer: manufacturers[0] ?? provider, notes };
}

/** The INF that defines driverName (case-insensitive), or null. */
export function infForDriver(infs: DriverInf[], driverName: string): DriverInf | null {
  const n = driverName.trim().toLowerCase();
  return infs.find((i) => i.models.some((m) => m.name.toLowerCase() === n)) ?? null;
}

/** Every driver name in a package, in INF order, de-duplicated. */
export function driverNames(infs: DriverInf[]): string[] {
  const out: string[] = [];
  for (const i of infs) for (const m of i.models) if (!out.some((x) => x.toLowerCase() === m.name.toLowerCase())) out.push(m.name);
  return out;
}
