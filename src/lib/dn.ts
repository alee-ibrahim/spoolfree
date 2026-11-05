/**
 * Minimal RFC 4514 distinguished-name helpers. Enough for AD DNs:
 * handles escaped separators ("\,"), surrounding whitespace and case.
 */

/** Split a DN into its RDNs, honouring backslash escapes. */
export function splitDn(dn: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i];
    if (ch === "\\" && i + 1 < dn.length) {
      current += ch + dn[i + 1];
      i++;
      continue;
    }
    if (ch === "," || ch === ";") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function normalizeRdn(rdn: string): string {
  const eq = rdn.indexOf("=");
  if (eq < 0) return rdn.trim().toLowerCase();
  return `${rdn.slice(0, eq).trim().toLowerCase()}=${rdn.slice(eq + 1).trim().toLowerCase()}`;
}

/** Canonical form used as a map key: lower-case, no padding around separators. */
export function normalizeDn(dn: string): string {
  return splitDn(dn).map(normalizeRdn).join(",");
}

export function dnEquals(a: string, b: string): boolean {
  return normalizeDn(a) === normalizeDn(b);
}

/** Parent DN, or null for a top-level DN. */
export function parentDn(dn: string): string | null {
  const parts = splitDn(dn);
  if (parts.length <= 1) return null;
  return parts.slice(1).join(",");
}

/** Display name of the leaf RDN (`OU=Lab,DC=x` -> `Lab`). */
export function rdnValue(dn: string): string {
  const first = splitDn(dn)[0] ?? dn;
  const eq = first.indexOf("=");
  return (eq >= 0 ? first.slice(eq + 1) : first).replace(/\\(.)/g, "$1");
}

/** True if `dn` is `ancestor` or below it. */
export function isUnder(dn: string, ancestor: string): boolean {
  const d = normalizeDn(dn);
  const a = normalizeDn(ancestor);
  return d === a || d.endsWith("," + a);
}

/**
 * Containers a computer object inherits from, ordered from the base DN
 * (domain root) down to the computer's immediate parent.
 * Containers above `baseDn` are ignored.
 */
export function ancestorChain(computerDn: string, baseDn: string): string[] {
  const chain: string[] = [];
  let p = parentDn(computerDn);
  while (p) {
    if (!isUnder(p, baseDn)) break;
    chain.unshift(p);
    if (dnEquals(p, baseDn)) break;
    p = parentDn(p);
  }
  return chain;
}
