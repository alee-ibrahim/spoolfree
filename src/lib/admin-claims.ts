/** Pure: decides admin access from ID-token claims. Exported for tests. */
export function adminFromClaims(
  claims: Record<string, unknown>,
  adminGroupIds: string[],
): { isAdmin: boolean; error?: string } {
  if (adminGroupIds.length === 0) return { isAdmin: false, error: "ADMIN_GROUP_IDS is not configured." };
  const groups = Array.isArray(claims.groups) ? (claims.groups as unknown[]).map((g) => String(g).toLowerCase()) : [];
  if (groups.some((g) => adminGroupIds.includes(g))) return { isAdmin: true };
  const names = claims._claim_names as Record<string, unknown> | undefined;
  if (claims.hasgroups === true || (names && "groups" in names)) {
    return {
      isAdmin: false,
      error:
        "Your account is in too many groups for the token to list them (group overage). Configure the app registration to emit only groups assigned to the application.",
    };
  }
  return { isAdmin: false, error: "Your account is not in the Spoolfree admin group." };
}
