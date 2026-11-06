/** A daily page-counter reading (printer_counter_daily). */
export interface CounterDay {
  printerId: string;
  /** YYYY-MM-DD in ANALYTICS_TIME_ZONE. */
  day: string;
  revision: number;
  firstCount: number;
  lastCount: number;
}

/**
 * Pages each printer's own counter advanced during [fromDay, toDay] (inclusive). Pass the readings of the range and,
 * when available, the last reading before it (the baseline). A counter that goes backwards or a new revision (the
 * device was replaced) restarts from that day's first reading, so a swap never produces a negative or huge delta.
 */
export function counterTotals(rows: CounterDay[], fromDay: string, toDay: string): Map<string, { pages: number; days: number }> {
  const byPrinter = new Map<string, CounterDay[]>();
  for (const r of rows) byPrinter.set(r.printerId, [...(byPrinter.get(r.printerId) ?? []), r]);
  const out = new Map<string, { pages: number; days: number }>();
  for (const [id, list] of byPrinter) {
    list.sort((a, b) => a.day.localeCompare(b.day));
    let base: CounterDay | null = null;
    let pages = 0;
    let days = 0;
    for (const r of list) {
      if (r.day > toDay) break;
      if (r.day < fromDay) {
        base = r;
        continue;
      }
      days++;
      const continuous = base && base.revision === r.revision && r.firstCount >= base.lastCount;
      const delta = continuous ? r.lastCount - base!.lastCount : r.lastCount - r.firstCount;
      pages += Math.max(0, delta);
      base = r;
    }
    if (days > 0) out.set(id, { pages, days });
  }
  return out;
}

/** Pages printed at the device that no PC reported (copies, scans to print, direct/USB/mobile printing). */
export function pagesNotFromPcs(counterPages: number | null, pcPages: number): number | null {
  if (counterPages === null) return null;
  return Math.max(0, counterPages - pcPages);
}

/** YYYY-MM-DD of an instant in an IANA time zone. */
export function dayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Adds days to a YYYY-MM-DD date (calendar arithmetic, no time zone). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day from..to inclusive (max 3660). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 3660; d = addDays(d, 1)) out.push(d);
  return out;
}
