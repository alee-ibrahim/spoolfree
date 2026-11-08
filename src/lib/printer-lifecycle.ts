import { eq, sql } from "drizzle-orm";
import type { db as dbFn } from "./db";
import * as schema from "./db/schema";
import { auditWith } from "./printer-ous";

/**
 * Deleting and renaming a printer. Shared by the admin UI (actions.ts) and the CLI (scripts/printers.ts), so both
 * remove the same references and write the same audit rows. Agents follow at their next sync: a deleted printer
 * drops out of every manifest and the agent removes its managed queue; a renamed printer keeps its id, so the agent
 * removes the old queue, adds it under the new name and carries the users' default over.
 */

type Db = ReturnType<typeof dbFn>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;
type PrinterRow = typeof schema.printers.$inferSelect;

/** Same rule as the printer form: 1-100 characters, no \ / , or !. */
export const PRINTER_NAME_RE = /^[^\\/,!]+$/;

/** Printer fields recorded in audit details (before/after of an update, the deleted printer). */
export function printerSnapshot(p: PrinterRow) {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    ippPath: p.ippPath,
    ippPathAuto: p.ippPathAuto,
    useTls: p.useTls,
    model: p.model,
    location: p.location,
    legacyTakeover: p.legacyTakeover,
    legacyShares: p.legacyShares,
    legacyAliases: p.legacyAliases,
    defaultSides: p.defaultSides,
  };
}

/** Printer by name, case-insensitive (names are unique on lower(name)). */
export async function findPrinterByName(d: Executor, name: string): Promise<PrinterRow | null> {
  const [row] = await d
    .select()
    .from(schema.printers)
    .where(sql`lower(${schema.printers.name}) = lower(${name.trim()})`);
  return row ?? null;
}

export interface DeletePlan {
  printer: { id: string; name: string };
  /** OUs the printer is assigned to. */
  assignments: string[];
  /** OUs whose default printer it is. */
  defaults: string[];
  /** OUs that block it. */
  blockedIn: string[];
  /** Per-computer overrides (add or block) that name it. */
  overrides: { computerGuid: string; computerName: string; action: string }[];
}

/** Everything a delete removes, read without changing anything. */
export async function planPrinterDelete(d: Executor, p: { id: string; name: string }): Promise<DeletePlan> {
  const [assignments, settings, overrides] = await Promise.all([
    d.select({ ouDn: schema.ouAssignments.ouDn }).from(schema.ouAssignments).where(eq(schema.ouAssignments.printerId, p.id)),
    d.select().from(schema.ouSettings),
    d
      .select({
        computerGuid: schema.computerOverrides.computerGuid,
        computerName: schema.computerOverrides.computerName,
        action: schema.computerOverrides.action,
      })
      .from(schema.computerOverrides)
      .where(eq(schema.computerOverrides.printerId, p.id)),
  ]);
  const byDn = (a: string, b: string) => a.localeCompare(b);
  return {
    printer: { id: p.id, name: p.name },
    assignments: assignments.map((a) => a.ouDn).sort(byDn),
    defaults: settings.filter((s) => s.defaultPrinterId === p.id).map((s) => s.ouDn).sort(byDn),
    blockedIn: settings.filter((s) => s.blockedPrinterIds.includes(p.id)).map((s) => s.ouDn).sort(byDn),
    overrides: overrides.sort((a, b) => a.computerName.localeCompare(b.computerName)),
  };
}

/**
 * Deletes the printer with its OU assignments, per-computer overrides and status (foreign keys cascade), clears it as
 * an OU default (set null) and from OU block lists (JSON), in one transaction with one "printer.delete" audit row.
 * Returns null when the printer does not exist.
 */
export async function deletePrinterWithReferences(d: Db, actor: string, id: string): Promise<DeletePlan | null> {
  return d.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.printers).where(eq(schema.printers.id, id));
    if (!before) return null;
    const removed = await planPrinterDelete(tx, before);
    await tx.delete(schema.computerOverrides).where(eq(schema.computerOverrides.printerId, id));
    await tx.delete(schema.ouAssignments).where(eq(schema.ouAssignments.printerId, id));
    await tx
      .update(schema.ouSettings)
      .set({ defaultPrinterId: null, updatedAt: new Date() })
      .where(eq(schema.ouSettings.defaultPrinterId, id));
    await tx.execute(
      sql`update ou_settings set blocked_printer_ids = blocked_printer_ids - ${id}::text where blocked_printer_ids ? ${id}::text`,
    );
    await tx.delete(schema.printers).where(eq(schema.printers.id, id));
    await auditWith(tx, actor, "printer.delete", "printer", id, {
      ...printerSnapshot(before),
      removed: {
        assignments: removed.assignments,
        defaults: removed.defaults,
        blockedIn: removed.blockedIn,
        overrides: removed.overrides.map((o) => ({ computer: o.computerName, computerGuid: o.computerGuid, action: o.action })),
      },
    });
    return removed;
  });
}

export type RenameResult =
  | { ok: true; id: string; from: string; to: string; unchanged: boolean }
  | { ok: false; error: string };

/** Validation for a new printer name; null when valid. */
export function printerNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (n.length > 100) return "Name is longer than 100 characters";
  if (!PRINTER_NAME_RE.test(n)) return "Name cannot contain \\ / , or !";
  return null;
}

/**
 * Checks a rename without writing: the printer exists, the new name is valid and no other printer has it
 * (case-insensitive). A change of case only is allowed.
 */
export async function checkPrinterRename(d: Executor, id: string, newName: string): Promise<RenameResult> {
  const to = newName.trim();
  const invalid = printerNameError(to);
  if (invalid) return { ok: false, error: invalid };
  const [before] = await d.select().from(schema.printers).where(eq(schema.printers.id, id));
  if (!before) return { ok: false, error: "Printer not found" };
  const clash = await findPrinterByName(d, to);
  if (clash && clash.id !== id) return { ok: false, error: `A printer named "${clash.name}" already exists` };
  return { ok: true, id, from: before.name, to, unchanged: before.name === to };
}

/**
 * Renames a printer in place, as the Edit form does when only the name changes: same id, so OU assignments, defaults,
 * overrides, status, print history and audit history stay attached; the revision is not bumped (agents notice the new
 * name). Writes one "printer.update" audit row with before/after.
 */
export async function renamePrinter(d: Db, actor: string, id: string, newName: string): Promise<RenameResult> {
  return d.transaction(async (tx) => {
    const check = await checkPrinterRename(tx, id, newName);
    if (!check.ok || check.unchanged) return check;
    const [before] = await tx.select().from(schema.printers).where(eq(schema.printers.id, id));
    await tx.update(schema.printers).set({ name: check.to, updatedAt: new Date() }).where(eq(schema.printers.id, id));
    await auditWith(tx, actor, "printer.update", "printer", id, {
      before: printerSnapshot(before),
      after: { ...printerSnapshot(before), name: check.to },
    });
    return check;
  });
}
