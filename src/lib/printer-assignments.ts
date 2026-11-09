import { sql } from "drizzle-orm";
import { db } from "./db";
import { normalizeDn } from "./dn";

export { ouShortName } from "./format";

/**
 * Per printer: its OU assignments (with "is the OU's default") and its per-PC overrides, for the printers list. One
 * query: correlated json_agg subqueries over ou_assignments, ou_settings and computer_overrides (no N+1).
 */

export interface PrinterOuRef {
  ouDn: string;
  isDefault: boolean;
}

export interface PrinterPcRef {
  computerGuid: string;
  computerName: string;
  action: "add" | "block";
  makeDefault: boolean;
}

export interface PrinterAssignments {
  ous: PrinterOuRef[];
  pcs: PrinterPcRef[];
}

export async function loadPrinterAssignments(): Promise<Map<string, PrinterAssignments>> {
  const rows = await db().execute<{ id: string; ous: PrinterOuRef[] | string; pcs: PrinterPcRef[] | string }>(sql`
    select p.id,
      coalesce((
        select json_agg(json_build_object(
          'ouDn', a.ou_dn,
          'isDefault', exists (select 1 from ou_settings s where lower(s.ou_dn) = lower(a.ou_dn) and s.default_printer_id = p.id)
        ) order by a.ou_dn)
        from ou_assignments a where a.printer_id = p.id
      ), '[]'::json) as ous,
      coalesce((
        select json_agg(json_build_object(
          'computerGuid', o.computer_guid, 'computerName', o.computer_name, 'action', o.action, 'makeDefault', o.make_default
        ) order by o.action, lower(o.computer_name))
        from computer_overrides o where o.printer_id = p.id
      ), '[]'::json) as pcs
    from printers p
  `);
  const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: typeof rows }).rows;
  const parse = <T>(v: T[] | string): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : (v ?? []));
  return new Map(list.map((r) => [r.id, { ous: parse(r.ous), pcs: parse(r.pcs) }]));
}

/** Same OU (case and spacing of the DN ignored). */
export function sameOu(a: string, b: string): boolean {
  return normalizeDn(a) === normalizeDn(b);
}
