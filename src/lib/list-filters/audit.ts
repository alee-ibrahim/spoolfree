import { and, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { auditLog } from "../db/schema";
import { countActive, day, likeEscape, one, pageNumber, words, type SearchParams } from "./params";

export interface AuditFilters {
  q: string | null;
  actor: string | null;
  /** Exact action ("printer.update") or a family ("printer.*"). */
  action: string | null;
  /** Inclusive UTC days. */
  from: string | null;
  to: string | null;
  page: number;
}

export function parseAuditFilters(sp: SearchParams): AuditFilters {
  let from = day(sp, "from");
  let to = day(sp, "to");
  if (from && to && from > to) [from, to] = [to, from];
  return { q: one(sp, "q", 200), actor: one(sp, "actor", 256), action: one(sp, "action", 128), from, to, page: pageNumber(sp) };
}

export const activeAuditFilters = (f: AuditFilters) => countActive({ actor: f.actor, action: f.action, dates: f.from || f.to });

const nextDay = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x;
};

/**
 * WHERE for the audit log. Every search word must appear in the actor, action, target or details (case-insensitive).
 * Undefined when nothing is filtered.
 */
export function auditWhere(f: AuditFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  for (const w of words(f.q)) {
    const pat = `%${likeEscape(w)}%`;
    parts.push(
      or(
        ilike(auditLog.actor, pat),
        ilike(auditLog.action, pat),
        ilike(auditLog.entityType, pat),
        ilike(auditLog.entityId, pat),
        sql`${auditLog.details}::text ilike ${pat}`,
      ),
    );
  }
  if (f.actor) parts.push(eq(auditLog.actor, f.actor));
  if (f.action?.endsWith(".*")) parts.push(ilike(auditLog.action, `${likeEscape(f.action.slice(0, -1))}%`));
  else if (f.action) parts.push(eq(auditLog.action, f.action));
  if (f.from) parts.push(gte(auditLog.at, new Date(`${f.from}T00:00:00Z`)));
  if (f.to) parts.push(lt(auditLog.at, nextDay(f.to)));
  return parts.length ? and(...parts) : undefined;
}

/** Action filter choices: the families ("printer.*") followed by every action. */
export function auditActionOptions(actions: string[]): { value: string; label: string }[] {
  const families = [...new Set(actions.filter((a) => a.includes(".")).map((a) => a.slice(0, a.indexOf("."))))].sort();
  return [
    ...families.map((f) => ({ value: `${f}.*`, label: `${f}.* (all)` })),
    ...[...new Set(actions)].sort().map((a) => ({ value: a, label: a })),
  ];
}
