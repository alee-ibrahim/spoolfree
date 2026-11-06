import { z } from "zod";

/**
 * Legacy host names / aliases of a printer: names old TCP/IP ports may still point at (NetBIOS-style names such as
 * OLD-PRN-OFFICE2 that are no longer in DNS, retired DNS names). Agents match a port host equal to any alias,
 * case-insensitive, with an optional ".local" suffix.
 */
export const ALIAS_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;

/** Splits a comma/semicolon/space separated list (or an array), trims, drops empties and case-insensitive duplicates. */
export function splitAliases(v: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(v) ? v : (v ?? "").split(/[,;\s|]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const a = raw.trim().replace(/\.$/, "");
    if (!a) continue;
    const k = aliasKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Comparison key: lower-case, no trailing dot, no ".local" suffix. Agents use the same rule. */
export function aliasKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
}

export const aliasList = z
  .union([z.string().max(4000), z.array(z.string())])
  .optional()
  .transform((v) => splitAliases(v ?? ""))
  .pipe(z.array(z.string().max(253).regex(ALIAS_RE, "Aliases are host names only (letters, digits, - . _), without \\\\ or ports")).max(50));

/** The form the manifest carries: lower-case, trailing dot removed (agents also strip ".local" on both sides). */
export function manifestAliases(aliases: string[] | null | undefined): string[] {
  return [...new Set((aliases ?? []).map((a) => a.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))].sort();
}
