import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import { auditWith, type Executor } from "./printer-ous";

/**
 * Per-computer "add" overrides edited from the Add/Edit printer form ("Assign to specific PCs"). The form sends the
 * full desired list of computer GUIDs for one printer; the server diffs it against the stored `add` overrides and
 * applies the difference in the same transaction as the printer and its OUs. `block` overrides are never changed
 * here (they are managed on the Preview page).
 */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `computers` form field: JSON list of computer objectGUIDs. Lower-cased and de-duplicated. */
export const PrinterComputersField = z
  .string()
  .max(200_000)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid computer list" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string().trim().toLowerCase().regex(GUID_RE, "Invalid computer id")).max(5000, "Too many computers"))
  .transform((list) => [...new Set(list)]);

export interface PrinterComputerOverride {
  computerGuid: string;
  computerName: string;
  action: "add" | "block";
  makeDefault: boolean;
}

export interface ComputerChangePlan {
  /** GUIDs that gain an `add` override. */
  added: string[];
  /** Stored `add` overrides that are removed. */
  removed: { computerGuid: string; computerName: string }[];
  /** GUIDs the form wants to add but that have a `block` override for this printer. */
  blocked: { computerGuid: string; computerName: string }[];
}

/** Diff the stored overrides of one printer against the desired list of computers. */
export function planComputerChanges(current: PrinterComputerOverride[], desired: string[]): ComputerChangePlan {
  const cur = new Map(current.map((o) => [o.computerGuid.toLowerCase(), o]));
  const want = new Set(desired.map((g) => g.toLowerCase()));
  const plan: ComputerChangePlan = { added: [], removed: [], blocked: [] };
  for (const g of want) {
    const o = cur.get(g);
    if (!o) plan.added.push(g);
    else if (o.action === "block") plan.blocked.push({ computerGuid: o.computerGuid, computerName: o.computerName });
  }
  for (const [g, o] of cur) if (o.action === "add" && !want.has(g)) plan.removed.push({ computerGuid: o.computerGuid, computerName: o.computerName });
  return plan;
}

export function computerPlanIsEmpty(p: ComputerChangePlan): boolean {
  return !p.added.length && !p.removed.length;
}

/** All overrides of one printer (add and block). */
export async function loadPrinterComputers(ex: Executor, printerId: string): Promise<PrinterComputerOverride[]> {
  return ex
    .select({
      computerGuid: schema.computerOverrides.computerGuid,
      computerName: schema.computerOverrides.computerName,
      action: schema.computerOverrides.action,
      makeDefault: schema.computerOverrides.makeDefault,
    })
    .from(schema.computerOverrides)
    .where(eq(schema.computerOverrides.printerId, printerId));
}

/**
 * Applies a plan for one printer and writes one audit row per change, the same rows as the Preview page:
 * override.add / override.remove (entity "computer", id = objectGUID), with `via: "printer-form"`.
 * `names` maps the GUIDs to add to their directory names.
 */
export async function applyComputerChanges(
  ex: Executor,
  actor: string,
  printer: { id: string; name: string },
  plan: ComputerChangePlan,
  names: Map<string, string>,
) {
  const via = "printer-form";
  if (plan.added.length) {
    await ex
      .insert(schema.computerOverrides)
      .values(plan.added.map((g) => ({ computerGuid: g, computerName: names.get(g) ?? g, printerId: printer.id, action: "add" as const, makeDefault: false })))
      .onConflictDoNothing();
  }
  for (const g of plan.added) {
    await auditWith(ex, actor, "override.add", "computer", g, { computer: names.get(g) ?? g, printerId: printer.id, printer: printer.name, makeDefault: false, via });
  }
  if (plan.removed.length) {
    await ex.delete(schema.computerOverrides).where(
      and(
        eq(schema.computerOverrides.printerId, printer.id),
        eq(schema.computerOverrides.action, "add"),
        inArray(
          schema.computerOverrides.computerGuid,
          plan.removed.map((r) => r.computerGuid),
        ),
      ),
    );
  }
  for (const r of plan.removed) {
    await auditWith(ex, actor, "override.remove", "computer", r.computerGuid, { computer: r.computerName, printerId: printer.id, printer: printer.name, via });
  }
}

export function computerSummary(p: ComputerChangePlan): string {
  const parts = [
    p.added.length ? `${p.added.length} PC${p.added.length === 1 ? "" : "s"} added` : "",
    p.removed.length ? `${p.removed.length} PC${p.removed.length === 1 ? "" : "s"} removed` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
