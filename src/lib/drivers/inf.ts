/**
 * Just enough of the Windows INF format to read a printer driver package at upload: [Version] (Class, Provider,
 * CatalogFile, DriverVer), [Manufacturer] and its NTamd64 models sections (driver names and hardware IDs), with
 * %token% strings resolved from [Strings].
 */

export const PRINTER_CLASS_GUID = "{4d36e979-e325-11ce-bfc1-08002be10318}";

export interface ParsedInf {
  className: string | null;
  isPrinterClass: boolean;
  provider: string | null;
  driverVer: string | null;
  /** CatalogFile.NTamd64 if present, else CatalogFile. */
  catalogFile: string | null;
  manufacturers: string[];
  /** Models from NTamd64-decorated models sections, de-duplicated by name. */
  models: { name: string; hardwareIds: string[] }[];
}

/** INF text: UTF-16LE (BOM or zero bytes), UTF-8 (BOM) or Windows-1252-ish. */
export function decodeInf(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let zeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
  if (sample.length > 8 && zeros > sample.length / 4) return buf.toString("utf16le");
  return buf.toString("latin1");
}

/** Strips a ; comment that is not inside double quotes. */
function stripComment(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ";" && !q) return line.slice(0, i);
  }
  return line;
}

/** Splits on commas outside quotes; trims and unquotes ("" inside quotes is a literal quote). */
export function splitValues(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"') {
      if (q && v[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

/** Section name (lower-case) -> lines (comments stripped, continuations joined, blank lines dropped). */
export function sections(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string[] | null = null;
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < raw.length; i++) {
    let line = stripComment(raw[i]).trim();
    while (line.endsWith("\\") && i + 1 < raw.length) line = line.slice(0, -1) + stripComment(raw[++i]).trim();
    if (!line) continue;
    const m = /^\[([^\]]+)\]$/.exec(line);
    if (m) {
      const name = m[1].trim().toLowerCase();
      current = map.get(name) ?? [];
      map.set(name, current);
      continue;
    }
    current?.push(line);
  }
  return map;
}

function keyValue(line: string): [string, string] | null {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "=" && !q) return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }
  return null;
}

export function parseInf(text: string): ParsedInf {
  const secs = sections(text);
  const strings = new Map<string, string>();
  const stringSections = [...secs.keys()].filter((k) => k === "strings" || k.startsWith("strings."));
  // Localised [Strings.xxxx] first, then [Strings] wins.
  for (const k of stringSections.sort((a, b) => (a === "strings" ? 1 : b === "strings" ? -1 : 0))) {
    for (const line of secs.get(k) ?? []) {
      const kv = keyValue(line);
      if (kv) strings.set(kv[0].toLowerCase(), unquote(kv[1]));
    }
  }
  const resolve = (s: string): string =>
    unquote(s).replace(/%([^%]+)%/g, (all, key: string) => strings.get(key.toLowerCase()) ?? all);

  const version = new Map<string, string>();
  for (const line of secs.get("version") ?? []) {
    const kv = keyValue(line);
    if (kv) version.set(kv[0].toLowerCase(), kv[1]);
  }
  const className = version.has("class") ? resolve(version.get("class")!) : null;
  const classGuid = (version.get("classguid") ?? "").trim().toLowerCase();
  const catalog = version.get("catalogfile.ntamd64") ?? version.get("catalogfile");

  const manufacturers: string[] = [];
  const models: { name: string; hardwareIds: string[] }[] = [];
  const seen = new Set<string>();
  for (const line of secs.get("manufacturer") ?? []) {
    const kv = keyValue(line);
    // "%Mfg% = Section, NTamd64, NTamd64.10.0" or just "Section, NTamd64" (no name).
    const [mfgRaw, rest] = kv ?? ["", line];
    const [section, ...decorations] = splitValues(rest);
    if (!section) continue;
    if (mfgRaw) {
      const mfg = resolve(mfgRaw);
      if (mfg && !manufacturers.includes(mfg)) manufacturers.push(mfg);
    }
    for (const dec of decorations.filter((d) => /^ntamd64(\.|$)/i.test(d))) {
      for (const mline of secs.get(`${section}.${dec}`.toLowerCase()) ?? []) {
        const mkv = keyValue(mline);
        if (!mkv) continue;
        const name = resolve(mkv[0]).trim();
        const [, ...ids] = splitValues(mkv[1]);
        const hardwareIds = ids.map((x) => x.trim()).filter(Boolean);
        if (!name) continue;
        const existing = models.find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          for (const id of hardwareIds) if (!existing.hardwareIds.includes(id)) existing.hardwareIds.push(id);
        } else if (!seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          models.push({ name, hardwareIds });
        }
      }
    }
  }
  return {
    className,
    isPrinterClass: className?.toLowerCase() === "printer" || classGuid === PRINTER_CLASS_GUID,
    provider: version.has("provider") ? resolve(version.get("provider")!) : null,
    driverVer: version.has("driverver") ? unquote(version.get("driverver")!) : null,
    catalogFile: catalog ? unquote(catalog) : null,
    manufacturers,
    models,
  };
}
