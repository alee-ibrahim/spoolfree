import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AdminAccessMode, AdminAccessPolicy } from "./admin-claims";

/**
 * All runtime configuration comes from environment variables.
 * `.env.example` documents every variable read here.
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://spoolfree:spoolfree@localhost:5432/spoolfree"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  // Entra ID / Auth.js
  AUTH_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().optional(),
  /** "group" (default): ADMIN_GROUP_IDS decides. "entra-assignment": everyone the single-tenant Entra app lets in. */
  ADMIN_ACCESS_MODE: z.string().trim().toLowerCase().default("group"),
  ADMIN_GROUP_IDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),

  // Active Directory (read-only)
  /** "ldap" (default): live LDAP(S) simple bind. "snapshot": served from snapshots pushed by the adsync sidecar. */
  DIRECTORY_MODE: z.enum(["ldap", "snapshot"]).default("ldap"),
  /** Bearer token the adsync sidecar sends to /api/internal/directory-snapshot (snapshot mode). */
  DIRECTORY_SYNC_TOKEN: z.string().optional(),
  DIRECTORY_SYNC_TOKEN_FILE: z.string().optional(),
  /** The UI warns when the last snapshot is older than this. */
  DIRECTORY_STALE_MINUTES: z.coerce.number().positive().default(30),
  /** Agents are refused (fail closed) when the last snapshot is older than this; 0 disables the check. */
  DIRECTORY_MAX_AGE_HOURS: z.coerce.number().min(0).default(24),
  LDAP_URL: z.string().default("ldaps://dc1.example.org:636"),
  LDAP_BIND_DN: z.string().default(""),
  LDAP_BIND_PASSWORD: z.string().default(""),
  LDAP_BASE_DN: z.string().default("DC=example,DC=org"),
  LDAP_CA_CERT_FILE: z.string().optional(),
  LDAP_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v?.toLowerCase() !== "false"),
  LDAP_CACHE_SECONDS: z.coerce.number().int().positive().default(300),

  // Agent
  AGENT_ENROLLMENT_TOKEN: z.string().optional(),
  AGENT_ENROLLMENT_TOKEN_FILE: z.string().optional(),
  MANIFEST_SIGNING_KEY: z.string().optional(),
  MANIFEST_SIGNING_KEY_FILE: z.string().optional(),
  MANIFEST_TTL_HOURS: z.coerce.number().positive().default(24),
  AGENT_STALE_HOURS: z.coerce.number().positive().default(26),

  // Poller
  POLLER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v?.toLowerCase() !== "false"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),
  POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  POLL_CONCURRENCY: z.coerce.number().int().positive().default(8),
  SNMP_COMMUNITY: z.string().default("public"),
  LOW_TONER_PERCENT: z.coerce.number().int().min(0).max(100).default(15),
  ALERT_WEBHOOK_URL: z.string().optional(),

  METRICS_TOKEN: z.string().optional(),

  // Development only
  DEV_FAKE_AD: bool,
  /** Optional JSON file that replaces the sample directory (see directory/fake.ts). */
  DEV_FAKE_AD_FILE: z.string().optional(),
  DEV_LOGIN: bool,
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

/** Admin access policy from the environment (see lib/admin-claims.ts). */
export function adminAccessPolicy(): AdminAccessPolicy {
  const c = config();
  return {
    mode: c.ADMIN_ACCESS_MODE as AdminAccessMode,
    adminGroupIds: c.ADMIN_GROUP_IDS,
    issuer: c.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
  };
}

/** Dev conveniences are compiled out of production builds (`next build` sets NODE_ENV=production). */
export const isProductionBuild = process.env.NODE_ENV === "production";

export function devLoginEnabled(): boolean {
  return !isProductionBuild && config().DEV_LOGIN;
}

export function fakeAdEnabled(): boolean {
  return !isProductionBuild && config().DEV_FAKE_AD;
}

/** Where directory data comes from. DEV_FAKE_AD wins in development builds. */
export function directoryMode(): "fake" | "ldap" | "snapshot" {
  return fakeAdEnabled() ? "fake" : config().DIRECTORY_MODE;
}

/** Reads a value from `NAME` or from the file named by `NAME_FILE` (Docker/K8s secrets). */
export function secretValue(value: string | undefined, file: string | undefined): string | undefined {
  if (value) return value.trim();
  if (file) {
    return readFileSync(file, "utf8").trim();
  }
  return undefined;
}

/** Agents that have not reported since this instant are "stale". */
export function agentStaleCutoff(): number {
  return Date.now() - config().AGENT_STALE_HOURS * 3600_000;
}
