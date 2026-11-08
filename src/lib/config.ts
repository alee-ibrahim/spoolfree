import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AdminAccessMode, AdminAccessPolicy } from "./admin-claims";
import { autoSignInEnabled } from "./auth-flow";

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
  /** Go straight to Entra from /login (default: on when Entra is configured and dev login is off). */
  AUTH_AUTO_SIGNIN: z.string().optional(),
  /** Break-glass local admin users (scripts/local-user.ts), shown only at /login?local=1. */
  LOCAL_LOGIN_ENABLED: bool,
  LOCAL_LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOCAL_LOGIN_LOCKOUT_MINUTES: z.coerce.number().positive().default(15),
  LOCAL_LOGIN_IP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(20),
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
  /** How often agents sync (sent in the manifest; agents update their own scheduled task). 5-240. */
  AGENT_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(240).default(15),
  AGENT_STALE_HOURS: z.coerce.number().positive().default(26),
  /** Agent self-update (0.4.3+): offer the bundled agent scripts in the manifest. On unless "0"/"false". */
  AGENT_SELF_UPDATE: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v?.toLowerCase() !== "false"),
  /** Let agents install an older bundled version than they run (rolling back a release). Off unless "1"/"true". */
  AGENT_ALLOW_DOWNGRADE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /** Directory with the agent scripts served as the self-update bundle. Default: ./agent (in the image: /app/agent). */
  AGENT_BUNDLE_DIR: z.string().optional(),

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

  /** Old print servers whose \\server\share connections agents may replace (legacy queue takeover). */
  LEGACY_PRINT_SERVERS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(/[\s,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),

  // Print analytics (agents 0.5+ read PrintService event 307 on PCs). Off unless "1"/"true".
  ANALYTICS_ENABLED: bool,
  /** Also collect document names (titles can be personal or confidential). Off unless "1"/"true". */
  ANALYTICS_COLLECT_DOCUMENT_NAMES: bool,
  /** Print jobs and daily printer counters older than this are deleted (hourly purge). */
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  /** IANA time zone for day buckets (charts, daily counters). */
  ANALYTICS_TIME_ZONE: z
    .string()
    .default("UTC")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "ANALYTICS_TIME_ZONE must be an IANA time zone"),

  // Vendor drivers (driver mode "vendor" / "auto"; see docs/drivers.md)
  /** Largest driver package (zip) accepted, in MB. Packages are stored in Postgres. */
  DRIVER_PACKAGE_MAX_MB: z.coerce.number().int().min(1).max(1000).default(200),
  /** Auto mode: median seconds per page above this (over DRIVER_AUTO_SLOW_MIN_JOBS jobs) means "slow". */
  DRIVER_AUTO_SLOW_SECONDS_PER_PAGE: z.coerce.number().positive().default(20),
  DRIVER_AUTO_SLOW_MIN_JOBS: z.coerce.number().int().min(1).max(20).default(3),
  /** Jobs with fewer pages are not measured (warm-up dominates a 1-page job). */
  DRIVER_AUTO_SLOW_MIN_PAGES: z.coerce.number().int().min(1).default(2),
  /** How often the poller reads completed jobs (IPP Get-Jobs) of auto-mode printers; 0 turns speed measuring off. */
  DRIVER_AUTO_SPEED_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(30),

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

export function entraConfigured(): boolean {
  const c = config();
  return Boolean(c.AUTH_MICROSOFT_ENTRA_ID_ID && c.AUTH_MICROSOFT_ENTRA_ID_ISSUER);
}

export function autoSignIn(): boolean {
  return autoSignInEnabled({ setting: config().AUTH_AUTO_SIGNIN, entraConfigured: entraConfigured(), devLogin: devLoginEnabled() });
}

export function localLoginEnabled(): boolean {
  return config().LOCAL_LOGIN_ENABLED;
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

/** Auto driver mode thresholds from the environment. */
export function autoSettings() {
  const c = config();
  return { slowSecondsPerPage: c.DRIVER_AUTO_SLOW_SECONDS_PER_PAGE, slowMinJobs: c.DRIVER_AUTO_SLOW_MIN_JOBS, slowMinPages: c.DRIVER_AUTO_SLOW_MIN_PAGES };
}
