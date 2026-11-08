import { addDays } from "./counters";

export interface AnalyticsFilters {
  /** Inclusive YYYY-MM-DD range in ANALYTICS_TIME_ZONE. */
  from: string;
  to: string;
  user: string | null;
  /** A Spoolfree printer id, or "queue:<name>" for an unmanaged queue. */
  printer: string | null;
  ou: string | null;
  computer: string | null;
  /** Free text: every word must appear in the job's user or document name. */
  q: string | null;
}

export const RANGE_PRESETS = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "365d", label: "Last 12 months", days: 365 },
] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3660;

function validDay(v: string | undefined | null): string | null {
  if (!v || !DAY_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

const text = (v: string | string[] | undefined, max = 512) => {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Filters from the page's search params. Defaults to the last 30 days ending today; a reversed range is swapped and
 * ranges are capped at ten years.
 */
export function parseFilters(sp: Record<string, string | string[] | undefined>, today: string): AnalyticsFilters {
  let to = validDay(text(sp.to)) ?? today;
  let from = validDay(text(sp.from)) ?? addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  if (addDays(from, MAX_DAYS) < to) from = addDays(to, -MAX_DAYS);
  return { from, to, user: text(sp.user, 256), printer: text(sp.printer), ou: text(sp.ou, 2048), computer: text(sp.computer, 256), q: text(sp.q, 200) };
}

/** Search params for links (only the set filters). */
export function filterParams(f: AnalyticsFilters, extra: Record<string, string | null> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ from: f.from, to: f.to, user: f.user, printer: f.printer, ou: f.ou, computer: f.computer, q: f.q, ...extra })) {
    if (v) p.set(k, v);
  }
  return p.toString();
}

/** Escapes LIKE wildcards. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** CSV cell: quoted when needed; formula-looking values are prefixed so spreadsheets do not execute them. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
