/** AD stores objectGUID as 16 bytes with the first three fields little-endian. */
export function guidFromBuffer(buf: Buffer): string {
  if (buf.length !== 16) throw new Error("objectGUID must be 16 bytes");
  const h = buf.toString("hex");
  const le = (s: string) => s.match(/../g)!.reverse().join("");
  return [le(h.slice(0, 8)), le(h.slice(8, 12)), le(h.slice(12, 16)), h.slice(16, 20), h.slice(20)].join("-");
}

export function guidToBuffer(guid: string): Buffer {
  const hex = normalizeGuid(guid).replace(/-/g, "");
  const le = (s: string) => s.match(/../g)!.reverse().join("");
  return Buffer.from(le(hex.slice(0, 8)) + le(hex.slice(8, 12)) + le(hex.slice(12, 16)) + hex.slice(16), "hex");
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeGuid(guid: string): string {
  const g = guid.trim().replace(/^\{|\}$/g, "").toLowerCase();
  if (!GUID_RE.test(g)) throw new Error("Invalid GUID");
  return g;
}

export function isGuid(guid: string): boolean {
  try {
    normalizeGuid(guid);
    return true;
  } catch {
    return false;
  }
}

/** LDAP filter value for a binary objectGUID match (`\\xx` per byte). */
export function guidFilterValue(guid: string): string {
  return [...guidToBuffer(guid)].map((b) => "\\" + b.toString(16).padStart(2, "0")).join("");
}
