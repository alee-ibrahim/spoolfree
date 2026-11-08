import { isUnder, normalizeDn, parentDn } from "../dn";
import { countActive, flag, matchesWords, one, words, type SearchParams } from "./params";

// --- Assignments (OU tree) ---------------------------------------------------------------------------------

export interface OuTreeFilters {
  /** Text filter on OU names. */
  q: string | null;
  /** Only OUs with printers assigned directly. */
  withPrinters: boolean;
  /** Only OUs whose computers get this printer (directly or inherited). */
  printer: string | null;
}

export function parseOuTreeFilters(sp: SearchParams): OuTreeFilters {
  return { q: one(sp, "q", 200), withPrinters: flag(sp, "assigned"), printer: one(sp, "printer", 64) };
}

export const activeOuTreeFilters = (f: OuTreeFilters) => countActive({ withPrinters: f.withPrinters, printer: f.printer });

export interface OuTreeFilterItem {
  key: string;
  label: string;
  parentKey: string | null;
  /** Printers assigned directly. */
  count: number;
}

/**
 * The OUs that match (null: no filter, everything matches). `gets(key)` tells whether an OU's computers get the
 * filtered printer.
 */
export function matchOuTree(items: OuTreeFilterItem[], f: OuTreeFilters, gets?: (key: string) => boolean): Set<string> | null {
  const terms = words(f.q);
  if (!terms.length && !f.withPrinters && !f.printer) return null;
  return new Set(
    items
      .filter((i) => matchesWords(terms, [i.label]) && (!f.withPrinters || i.count > 0) && (!f.printer || (gets?.(i.key) ?? false)))
      .map((i) => i.key),
  );
}

/** The matching OUs plus their ancestors (so the tree keeps its shape), or every item when nothing is filtered. */
export function visibleOuTree<T extends OuTreeFilterItem>(items: T[], matched: Set<string> | null): T[] {
  if (!matched) return items;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const keep = new Set<string>();
  for (const k of matched) {
    let p: string | null = k;
    while (p && !keep.has(p)) {
      keep.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
  }
  return items.filter((i) => keep.has(i.key));
}

// --- Unassigned PCs ----------------------------------------------------------------------------------------

export interface UnassignedFilters {
  q: string | null;
  /** An OU; computers in it and below match. */
  ou: string | null;
}

export function parseUnassignedFilters(sp: SearchParams): UnassignedFilters {
  return { q: one(sp, "q", 200), ou: one(sp, "ou", 2048) };
}

export const activeUnassignedFilters = (f: UnassignedFilters) => countActive({ ou: f.ou });

export function filterComputers<T extends { name: string; dn: string; operatingSystem?: string | null }>(rows: T[], f: UnassignedFilters): T[] {
  const terms = words(f.q);
  return rows.filter((c) => matchesWords(terms, [c.name, c.operatingSystem]) && (!f.ou || isUnder(parentDn(c.dn) ?? "", f.ou)));
}

/** Distinct parent containers of the computers, and their parent OUs, sorted top-down. */
export function containerOptions(rows: { dn: string }[]): string[] {
  const out = new Map<string, string>();
  for (const r of rows) {
    let ou = parentDn(r.dn);
    while (ou && /^(OU|CN)=/i.test(ou)) {
      const k = normalizeDn(ou);
      if (out.has(k)) break;
      out.set(k, ou);
      ou = parentDn(ou);
    }
  }
  const path = (dn: string) => dn.split(/,(?=(?:OU|CN|DC)=)/i).reverse().join("/").toLowerCase();
  return [...out.values()].sort((a, b) => path(a).localeCompare(path(b)));
}
