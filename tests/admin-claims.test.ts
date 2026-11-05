import { describe, expect, it } from "vitest";
import { adminAccessConfigErrors, adminFromClaims, tenantFromIssuer, type AdminAccessPolicy } from "@/lib/admin-claims";

const TENANT = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER = "9b2c7e1a-0d4f-4c6b-8a1e-5f3d2b7c9e01";
const issuer = (t: string) => `https://login.microsoftonline.com/${t}/v2.0`;

describe("admin access: group mode", () => {
  const policy: AdminAccessPolicy = { mode: "group", adminGroupIds: ["11111111-1111-1111-1111-111111111111"], issuer: issuer(TENANT) };
  it("grants access to members of the admin group (case-insensitive)", () => {
    expect(adminFromClaims({ groups: ["11111111-1111-1111-1111-111111111111".toUpperCase()] }, policy).isAdmin).toBe(true);
  });
  it("denies others and explains group overage", () => {
    expect(adminFromClaims({ groups: ["22222222-2222-2222-2222-222222222222"] }, policy)).toMatchObject({ isAdmin: false });
    expect(adminFromClaims({ _claim_names: { groups: "src1" } }, policy).error).toMatch(/overage/);
    expect(adminFromClaims({ groups: policy.adminGroupIds }, { ...policy, adminGroupIds: [] }).isAdmin).toBe(false);
  });
  it("does not let a token without groups in, even from the right tenant", () => {
    expect(adminFromClaims({ tid: TENANT, iss: issuer(TENANT) }, policy).isAdmin).toBe(false);
  });
});

describe("admin access: entra-assignment mode", () => {
  const policy: AdminAccessPolicy = { mode: "entra-assignment", adminGroupIds: [], issuer: issuer(TENANT) };
  it("admits any user of the configured tenant, with no groups claim", () => {
    expect(adminFromClaims({ tid: TENANT, iss: issuer(TENANT) }, policy)).toEqual({ isAdmin: true });
    expect(adminFromClaims({ tid: TENANT.toUpperCase(), iss: issuer(TENANT) }, policy).isAdmin).toBe(true);
  });
  it("refuses another tenant, a mismatched issuer or missing claims", () => {
    expect(adminFromClaims({ tid: OTHER, iss: issuer(OTHER) }, policy).isAdmin).toBe(false);
    expect(adminFromClaims({ tid: TENANT, iss: issuer(OTHER) }, policy).isAdmin).toBe(false);
    expect(adminFromClaims({ tid: OTHER, iss: issuer(TENANT) }, policy).isAdmin).toBe(false);
    expect(adminFromClaims({ iss: issuer(TENANT) }, policy).isAdmin).toBe(false);
    expect(adminFromClaims({ tid: TENANT }, policy).isAdmin).toBe(false);
    expect(adminFromClaims({ tid: TENANT, iss: `https://sts.windows.net/${TENANT}/` }, policy).isAdmin).toBe(false);
  });
  it("refuses everyone when the configured issuer is multi-tenant or missing", () => {
    for (const bad of [issuer("common"), issuer("organizations"), issuer("consumers"), undefined, "https://example.org/v2.0"]) {
      expect(adminFromClaims({ tid: TENANT, iss: issuer(TENANT) }, { ...policy, issuer: bad }).isAdmin).toBe(false);
    }
  });
});

describe("admin access: startup configuration check", () => {
  it("refuses group mode with no admin group", () => {
    expect(adminAccessConfigErrors({ mode: "group", adminGroupIds: [], issuer: issuer(TENANT) })[0]).toMatch(/ADMIN_GROUP_IDS is empty/);
  });
  it("accepts group mode with a group, and assignment mode with a single-tenant issuer", () => {
    expect(adminAccessConfigErrors({ mode: "group", adminGroupIds: ["11111111-1111-1111-1111-111111111111"] })).toEqual([]);
    expect(adminAccessConfigErrors({ mode: "entra-assignment", adminGroupIds: [], issuer: issuer(TENANT) })).toEqual([]);
  });
  it("refuses assignment mode with a multi-tenant or missing issuer", () => {
    expect(adminAccessConfigErrors({ mode: "entra-assignment", adminGroupIds: [], issuer: issuer("common") })).toHaveLength(1);
    expect(adminAccessConfigErrors({ mode: "entra-assignment", adminGroupIds: [] })).toHaveLength(1);
  });
  it("refuses an unknown mode", () => {
    expect(adminAccessConfigErrors({ mode: "everyone" as never, adminGroupIds: [] })[0]).toMatch(/must be one of/);
  });
});

describe("tenantFromIssuer", () => {
  it("extracts a GUID tenant and rejects the shared endpoints", () => {
    expect(tenantFromIssuer(issuer(TENANT.toUpperCase()))).toBe(TENANT);
    expect(tenantFromIssuer(issuer("common"))).toBeUndefined();
    expect(tenantFromIssuer("http://login.microsoftonline.com/" + TENANT + "/v2.0")).toBeUndefined();
  });
});
