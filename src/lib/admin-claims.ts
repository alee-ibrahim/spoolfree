/**
 * Admin access decisions. Pure functions, exported for tests.
 *
 * Two modes (ADMIN_ACCESS_MODE):
 * - "group" (default): the ID token's `groups` claim must contain one of ADMIN_GROUP_IDS.
 * - "entra-assignment": every user who signs in through the single-tenant Entra app is an admin.
 *   Access is controlled by assigning users to the enterprise application, which MUST have
 *   "Assignment required" switched on. The token's tenant and issuer are still checked strictly.
 */
export type AdminAccessMode = "group" | "entra-assignment";

export const ADMIN_ACCESS_MODES: readonly AdminAccessMode[] = ["group", "entra-assignment"];

export interface AdminAccessPolicy {
  mode: AdminAccessMode;
  adminGroupIds: string[];
  /** AUTH_MICROSOFT_ENTRA_ID_ISSUER, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i;

/** Tenant ID from a single-tenant Entra v2.0 issuer URL, or undefined (also for common/organizations/consumers). */
export function tenantFromIssuer(issuer: string | undefined): string | undefined {
  const m = issuer?.trim().match(ISSUER);
  if (!m || !GUID.test(m[1])) return undefined;
  return m[1].toLowerCase();
}

/**
 * Configuration errors that must stop the server from starting (empty list = OK).
 * Called at startup in production builds, so a missing admin group can never leave the UI
 * open by accident, and the assignment mode can never be used with a multi-tenant issuer.
 */
export function adminAccessConfigErrors(policy: AdminAccessPolicy): string[] {
  const errors: string[] = [];
  if (!ADMIN_ACCESS_MODES.includes(policy.mode)) {
    errors.push(`ADMIN_ACCESS_MODE must be one of: ${ADMIN_ACCESS_MODES.join(", ")}.`);
    return errors;
  }
  if (policy.mode === "group" && policy.adminGroupIds.length === 0) {
    errors.push(
      'ADMIN_GROUP_IDS is empty. Set the admin group object ID(s), or set ADMIN_ACCESS_MODE=entra-assignment if access is controlled by assigning users to the Entra enterprise app ("Assignment required").',
    );
  }
  if (policy.mode === "entra-assignment" && !tenantFromIssuer(policy.issuer)) {
    errors.push(
      "ADMIN_ACCESS_MODE=entra-assignment needs AUTH_MICROSOFT_ENTRA_ID_ISSUER set to a single-tenant issuer: https://login.microsoftonline.com/<tenant-id>/v2.0 (not common, organizations or consumers).",
    );
  }
  return errors;
}

function tenantMatches(claims: Record<string, unknown>, issuer: string | undefined): boolean {
  const tenant = tenantFromIssuer(issuer);
  if (!tenant) return false;
  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : undefined;
  const iss = typeof claims.iss === "string" ? tenantFromIssuer(claims.iss) : undefined;
  return tid === tenant && iss === tenant;
}

/** Decides admin access from ID-token claims. */
export function adminFromClaims(
  claims: Record<string, unknown>,
  policy: AdminAccessPolicy,
): { isAdmin: boolean; error?: string } {
  if (policy.mode === "entra-assignment") {
    if (!tenantFromIssuer(policy.issuer)) {
      return { isAdmin: false, error: "AUTH_MICROSOFT_ENTRA_ID_ISSUER is not a single-tenant issuer." };
    }
    if (!tenantMatches(claims, policy.issuer)) {
      return { isAdmin: false, error: "Your account is not from the organisation's Entra tenant." };
    }
    return { isAdmin: true };
  }

  if (policy.mode !== "group") return { isAdmin: false, error: "ADMIN_ACCESS_MODE is not valid." };
  const adminGroupIds = policy.adminGroupIds;
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
