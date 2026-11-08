/**
 * Shared helpers for list filters kept in URL query params (shareable, survive a refresh, the back button works).
 * Pure functions: used by the server pages and the client filter bar, and unit-tested.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a param, trimmed and capped; null when empty. */
export function one(sp: SearchParams, key: string, max = 256): string | null {
  const v = sp[key];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s.slice(0, max) : null;
}

/** The param when it is one of the allowed values, else null. */
export function oneOf<T extends string>(sp: SearchParams, key: string, allowed: readonly T[]): T | null {
  const v = one(sp, key, 64);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** "1" / "true" / "on" turn a toggle on. */
export function flag(sp: SearchParams, key: string): boolean {
  const v = one(sp, key, 8)?.toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD day, else null. */
export function day(sp: SearchParams, key: string): string | null {
  const v = one(sp, key, 10);
  if (!v || !DAY_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** 1-based page number (1 when missing or invalid). */
export function pageNumber(sp: SearchParams, key = "page"): number {
  const n = Number.parseInt(one(sp, key, 9) ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Lower-cased search words ("finance  laser" -> ["finance", "laser"]). */
export function words(q: string | null | undefined): string[] {
  return (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every search word is found in at least one of the fields (case-insensitive substring). */
export function matchesWords(terms: string[], fields: (string | null | undefined)[]): boolean {
  if (terms.length === 0) return true;
  const hay = fields.filter((f): f is string => !!f).map((f) => f.toLowerCase());
  return terms.every((t) => hay.some((h) => h.includes(t)));
}

/** Escapes LIKE / ILIKE wildcards. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Query string for a link: the given values (unset ones dropped), in a stable order. */
export function toQuery(values: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined || v === false || v === "") continue;
    p.set(k, v === true ? "1" : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * Number of set filters, for the "Filters" badge. Search text and sort order are not filters; pass them in `ignore`.
 */
export function countActive(values: Record<string, unknown>, ignore: string[] = ["q", "sort", "page"]): number {
  return Object.entries(values).filter(([k, v]) => !ignore.includes(k) && v !== null && v !== undefined && v !== false && v !== "").length;
}
