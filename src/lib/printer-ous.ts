import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { db as dbFn } from "./db";
import * as schema from "./db/schema";
import { normalizeDn, parentDn } from "./dn";
import { resolvePrinters, type Policy } from "./resolve";

/**
 * OU assignments edited from the Add/Edit printer form. The form sends the full desired list of OUs for one printer;
 * the server diffs it against the stored assignments and the per-OU default setting, then applies the difference in
 * the same transaction as the printer itself.
 */

export interface PrinterOu {
  ouDn: string;
  /** This printer is the OU's default (ou_settings.default_printer_id). */
  isDefault: boolean;
}

/** The `ous` form field: JSON list of `{ ouDn, isDefault }`. */
export const PrinterOusField = z
  .string()
  .max(200_000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid OU list" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(z.object({ ouDn: z.string().trim().min(1).max(2000), isDefault: z.boolean().default(false) }))
      .max(5000, "Too many OUs"),
  )
  .transform(dedupeOus);

/** One entry per OU (case-insensitive DN); a later duplicate's default flag wins. */
export function dedupeOus(list: PrinterOu[]): PrinterOu[] {
  const m = new Map<string, PrinterOu>();
  for (const o of list) m.set(normalizeDn(o.ouDn), { ouDn: o.ouDn.trim(), isDefault: o.isDefault });
  return [...m.values()];
}

export interface OuChangePlan {
  /** OUs that gain the assignment (DN as sent by the form). */
  added: string[];
  /** OUs that lose the assignment (DN as stored). */
  removed: string[];
  /** OUs whose default becomes this printer. */
  defaultSet: string[];
  /** OUs whose default was this printer and is cleared. */
  defaultCleared: string[];
}

/**
 * Diff the stored state of one printer against the desired list.
 * `current` = OUs this printer is assigned to; `currentDefaults` = OUs whose default is this printer.
 * Removing an OU also clears its default when that default is this printer.
 */
export function planOuChanges(current: string[], currentDefaults: string[], desired: PrinterOu[]): OuChangePlan {
  const cur = new Map(current.map((dn) => [normalizeDn(dn), dn]));
  const curDef = new Map(currentDefaults.map((dn) => [normalizeDn(dn), dn]));
  const want = new Map(desired.map((o) => [normalizeDn(o.ouDn), o]));
  const plan: OuChangePlan = { added: [], removed: [], defaultSet: [], defaultCleared: [] };
  for (const [k, o] of want) {
    if (!cur.has(k)) plan.added.push(o.ouDn);
    if (o.isDefault && !curDef.has(k)) plan.defaultSet.push(o.ouDn);
  }
  for (const [k, dn] of cur) if (!want.has(k)) plan.removed.push(dn);
  for (const [k, dn] of curDef) if (!want.get(k)?.isDefault) plan.defaultCleared.push(dn);
  return plan;
}

export function planIsEmpty(p: OuChangePlan): boolean {
  return !p.added.length && !p.removed.length && !p.defaultSet.length && !p.defaultCleared.length;
}

type Db = ReturnType<typeof dbFn>;
/** The database or an open transaction. */
export type Executor = Pick<Db, "select" | "insert" | "update" | "delete">;

export async function auditWith(
  ex: Executor,
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown>,
) {
  await ex.insert(schema.auditLog).values({ actor, action, entityType, entityId, details: details ?? null });
}

/** Current OU assignments of a printer with their default flag (for the edit form and the diff). */
export async function loadPrinterOus(ex: Executor, printerId: string): Promise<{ assigned: string[]; defaults: string[] }> {
  const [rows, defs] = await Promise.all([
    ex.select({ ouDn: schema.ouAssignments.ouDn }).from(schema.ouAssignments).where(eq(schema.ouAssignments.printerId, printerId)),
    ex.select({ ouDn: schema.ouSettings.ouDn }).from(schema.ouSettings).where(eq(schema.ouSettings.defaultPrinterId, printerId)),
  ]);
  return { assigned: rows.map((r) => r.ouDn), defaults: defs.map((r) => r.ouDn) };
}

/**
 * Applies a plan for one printer and writes one audit row per change:
 * assignment.add / assignment.remove (entity "ou", like the Assignments page) and ou.default.
 */
export async function applyOuChanges(ex: Executor, actor: string, printer: { id: string; name: string }, plan: OuChangePlan) {
  const via = "printer-form";
  if (plan.added.length) {
    await ex
      .insert(schema.ouAssignments)
      .values(plan.added.map((ouDn) => ({ ouDn, printerId: printer.id })))
      .onConflictDoNothing();
  }
  for (const ouDn of plan.added) await auditWith(ex, actor, "assignment.add", "ou", ouDn, { printerId: printer.id, printer: printer.name, via });

  if (plan.removed.length) {
    await ex
      .delete(schema.ouAssignments)
      .where(and(eq(schema.ouAssignments.printerId, printer.id), inArray(schema.ouAssignments.ouDn, plan.removed)));
  }
  for (const ouDn of plan.removed) await auditWith(ex, actor, "assignment.remove", "ou", ouDn, { printerId: printer.id, printer: printer.name, via });

  if (plan.defaultSet.length || plan.defaultCleared.length) {
    const settings = await ex.select().from(schema.ouSettings);
    const byKey = new Map(settings.map((s) => [normalizeDn(s.ouDn), s]));
    for (const ouDn of plan.defaultCleared) {
      const s = byKey.get(normalizeDn(ouDn));
      if (!s || s.defaultPrinterId !== printer.id) continue;
      await ex.update(schema.ouSettings).set({ defaultPrinterId: null, updatedAt: new Date() }).where(eq(schema.ouSettings.ouDn, s.ouDn));
      await auditWith(ex, actor, "ou.default", "ou", s.ouDn, { printerId: null, previous: printer.id, via });
    }
    for (const ouDn of plan.defaultSet) {
      const s = byKey.get(normalizeDn(ouDn));
      if (s) {
        await ex.update(schema.ouSettings).set({ defaultPrinterId: printer.id, updatedAt: new Date() }).where(eq(schema.ouSettings.ouDn, s.ouDn));
      } else {
        await ex.insert(schema.ouSettings).values({ ouDn, defaultPrinterId: printer.id });
      }
      await auditWith(ex, actor, "ou.default", "ou", s?.ouDn ?? ouDn, { printerId: printer.id, previous: s?.defaultPrinterId ?? null, via });
    }
  }
}

/** Placeholder id for a printer that is not saved yet. */
export const NEW_PRINTER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * How many enabled computers would receive `printerId` if it were assigned to exactly `ous` (child OUs inherit),
 * using the same resolution as Preview: inheritance blocks, blocked printers and computer overrides all apply.
 * `pcs` (computer GUIDs), when given, replaces the printer's stored per-computer `add` overrides, so the count covers
 * OUs plus specific PCs with every computer counted once. `block` overrides are kept.
 */
export function printerReach(
  policy: Policy,
  computers: { dn: string; objectGuid: string; disabled: boolean }[],
  printerId: string,
  ous: string[],
  pcs?: string[],
): { computers: number; ous: number } {
  const overrides = pcs
    ? [
        ...policy.overrides.filter((o) => !(o.printerId === printerId && o.action === "add")),
        ...pcs
          // A computer that blocks this printer stays blocked; the form does not change blocks.
          .filter((g) => !policy.overrides.some((o) => o.printerId === printerId && o.action === "block" && o.computerGuid.toLowerCase() === g.toLowerCase()))
          .map((computerGuid) => ({ computerGuid, printerId, action: "add" as const, makeDefault: false })),
      ]
    : policy.overrides;
  const hypothetical: Policy = {
    ...policy,
    assignments: [...policy.assignments.filter((a) => a.printerId !== printerId), ...ous.map((ouDn) => ({ ouDn, printerId }))],
    overrides,
  };
  if (!ous.length && !overrides.some((o) => o.printerId === printerId && o.action === "add")) return { computers: 0, ous: 0 };
  const reachedOus = new Set<string>();
  let n = 0;
  for (const c of computers) {
    if (c.disabled) continue;
    if (resolvePrinters(hypothetical, c).printers.some((p) => p.printerId === printerId)) {
      n++;
      reachedOus.add(normalizeDn(parentDn(c.dn) ?? ""));
    }
  }
  return { computers: n, ous: reachedOus.size };
}
