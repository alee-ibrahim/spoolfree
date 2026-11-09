import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DriverlessCheck, Marker } from "../ipp/interpret";

export type LegacyTakeover = "off" | "dry-run" | "on";
/** Default duplex set on the PC queue. "auto" leaves the driver default alone. */
export type DefaultSides = "auto" | "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
export const DEFAULT_SIDES: DefaultSides[] = ["auto", "one-sided", "two-sided-long-edge", "two-sided-short-edge"];
export const LEGACY_TAKEOVER_MODES: LegacyTakeover[] = ["off", "dry-run", "on"];

/**
 * How PCs create the queue. "auto" (default): the server decides per printer (src/lib/drivers/auto.ts) and puts the
 * resolved mode in the manifest. "driverless": always the IPP Class Driver. "vendor": always the chosen vendor driver.
 */
export type DriverMode = "auto" | "driverless" | "vendor";
export const DRIVER_MODES: DriverMode[] = ["auto", "driverless", "vendor"];
/** Port of a vendor-driver queue: Standard TCP/IP RAW 9100 (default), Standard TCP/IP LPR, or an IPP (Internet Port) URL. */
export type VendorProtocol = "raw9100" | "lpr" | "ipp";
export const VENDOR_PROTOCOLS: VendorProtocol[] = ["raw9100", "lpr", "ipp"];

/** One printer driver INF in a driver package (read from the zip at upload). */
export interface DriverInf {
  /** Path of the INF inside the zip ("/" separators). */
  path: string;
  /** Path of its catalog (.cat) inside the zip. */
  catalog: string;
  /** [Version] DriverVer ("06/21/2006,10.0.19041.1"), Provider and Class. */
  driverVer: string | null;
  provider: string | null;
  /** Manufacturer names from [Manufacturer] (resolved strings), e.g. "Brother". */
  manufacturers: string[];
  /** Printer drivers in the INF's NTamd64 models sections: the name (Add-PrinterDriver -Name) and its hardware IDs. */
  models: { name: string; hardwareIds: string[] }[];
}

/** One completed IPP job measured by the poller (Get-Jobs): seconds per page. */
export interface SpeedSample {
  jobId: number;
  pages: number;
  seconds: number;
  /** When the poller saw it (ISO). */
  at: string;
}

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array)),
});

export interface LegacyQueueResult {
  /** Spoolfree queue name. */
  printer: string;
  /** The legacy queue that matched. */
  queue: string;
  reason: string;
  action: "removed" | "would-remove" | "failed";
  /** "machine" or "user:DOMAIN\\name" (per-user print-server connections, handled at logon). */
  scope: string;
  error?: string;
}

export const printers = pgTable(
  "printers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Logical queue name shown on PCs. Stable across replacements. */
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(631),
    ippPath: text("ipp_path").notNull().default("/ipp/print"),
    /**
     * true: Test (and saving a new endpoint) detects the IPP path (/ipp/print, /ipp, /ipp/printer, /printers/lp1, /)
     * and stores it in ippPath. false: ippPath is a manual override and is never changed by detection.
     */
    ippPathAuto: boolean("ipp_path_auto").notNull().default(true),
    useTls: boolean("use_tls").notNull().default(false),
    location: text("location"),
    model: text("model"),
    notes: text("notes"),
    /** Incremented on "Replace" so agents re-create the queue. */
    revision: integer("revision").notNull().default(1),
    /**
     * Legacy queue takeover: "off", "dry-run" (agents only report what they would remove) or "on"
     * (agents remove non-Spoolfree queues for the same device before creating this one).
     */
    legacyTakeover: text("legacy_takeover").$type<LegacyTakeover>().notNull().default("off"),
    /** Share names of this device on the LEGACY_PRINT_SERVERS (\\server\<share> connections). */
    legacyShares: jsonb("legacy_shares").$type<string[]>().notNull().default([]),
    /**
     * Old host names of this device (NetBIOS-style names, retired DNS names) that legacy TCP/IP ports may still
     * point at. Takeover matches a port host equal to any of them (case-insensitive, ".local" optional).
     */
    legacyAliases: jsonb("legacy_aliases").$type<string[]>().notNull().default([]),
    /** Default duplex for the PC queue (agents run Set-PrintConfiguration -DuplexingMode). */
    defaultSides: text("default_sides").$type<DefaultSides>().notNull().default("auto"),
    /**
     * Device identity used by agents to recognise legacy queues for this printer: the IPP printer-uuid
     * (WSD/IPP ports carry it) and MAC addresses (SNMP ifPhysAddress; Brother: the printer-uuid node), which
     * Brother-style default host names embed (BRN/BRW + MAC). Filled by Test and the poller; reset on an
     * endpoint change.
     */
    deviceUuid: text("device_uuid"),
    macAddresses: jsonb("mac_addresses").$type<string[]>().notNull().default([]),
    identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
    /**
     * "auto" (default, decided by the server), "driverless" (Add-Printer -IppURL with the IPP Class Driver) or
     * "vendor": agents install driverPackageId (signed catalog checked) and create a queue with driverName on a
     * vendorProtocol port.
     */
    driverMode: text("driver_mode").$type<DriverMode>().notNull().default("auto"),
    driverPackageId: uuid("driver_package_id").references(() => driverPackages.id, { onDelete: "restrict" }),
    /** Add-PrinterDriver -Name: one of the package's INF model names. */
    driverName: text("driver_name"),
    vendorProtocol: text("vendor_protocol").$type<VendorProtocol>().notNull().default("raw9100"),
    /** LPR queue name for vendorProtocol "lpr" (null: "lp"). */
    lprQueue: text("lpr_queue"),
    /**
     * Auto mode stickiness: set when auto mode first decided this printer needs a vendor driver (and why). Kept until
     * an admin changes driverMode or replaces the device, so the decision never flaps back.
     */
    autoVendorReason: text("auto_vendor_reason"),
    autoVendorAt: timestamp("auto_vendor_at", { withTimezone: true }),
    /** IEEE 1284 device ID (IPP printer-device-id, or SNMP), used to match driver packages. */
    deviceId: text("device_id"),
    /** Recent completed IPP jobs measured by the poller (newest last, at most 20). */
    speedSamples: jsonb("speed_samples").$type<SpeedSample[]>().notNull().default([]),
    speedCheckedAt: timestamp("speed_checked_at", { withTimezone: true }),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTest: jsonb("last_test").$type<DriverlessCheck & { error?: string | null; ippPath?: string; ippRequestVersion?: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("printers_name_unique").on(sql`lower(${t.name})`)],
);

/**
 * Vendor driver packages (driver mode "vendor"): a zip of an INF/CAT/files tree uploaded by an admin. The bytes are
 * stored in Postgres in driver_package_chunks (DRIVER_PACKAGE_MAX_MB, default 200), so they are backed up with the
 * database and need no volume. Agents download them from /api/agent/drivers/<id> and check sha256 (from the signed
 * manifest) and the catalog's Authenticode signature before installing.
 */
export const driverPackages = pgTable(
  "driver_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Admin-chosen name, unique (case-insensitive). */
    name: text("name").notNull(),
    fileName: text("file_name"),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Lower-case hex SHA-256 of the zip. */
    sha256: text("sha256").notNull(),
    /** Only "x64" is supported. */
    architecture: text("architecture").notNull().default("x64"),
    /**
     * A brand's universal driver (Brother Universal, HP UPD): auto mode uses it for any printer of that manufacturer
     * when no package names the exact model. universalDriver is the driver name used then.
     */
    universal: boolean("universal").notNull().default(false),
    universalDriver: text("universal_driver"),
    /** Manufacturer the package is for (from the INF; used for universal matching). */
    manufacturer: text("manufacturer"),
    infs: jsonb("infs").$type<DriverInf[]>().notNull().default([]),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("driver_packages_name_unique").on(sql`lower(${t.name})`)],
);

/** The zip bytes of a driver package, in chunks of up to 4 MiB (seq 0, 1, ...). */
export const driverPackageChunks = pgTable(
  "driver_package_chunks",
  {
    packageId: uuid("package_id")
      .notNull()
      .references(() => driverPackages.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.seq] })],
);

export type DriverPackage = typeof driverPackages.$inferSelect;

export const printerStatus = pgTable("printer_status", {
  printerId: uuid("printer_id")
    .primaryKey()
    .references(() => printers.id, { onDelete: "cascade" }),
  online: boolean("online").notNull().default(false),
  state: text("state").notNull().default("unknown"),
  stateReasons: jsonb("state_reasons").$type<string[]>().notNull().default([]),
  stateMessage: text("state_message"),
  markers: jsonb("markers").$type<Marker[]>().notNull().default([]),
  pageCount: integer("page_count"),
  source: text("source").notNull().default("none"),
  error: text("error"),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  /** Alert state, used to send webhooks only on transitions. */
  alertKey: text("alert_key"),
});

export const ouAssignments = pgTable(
  "ou_assignments",
  {
    ouDn: text("ou_dn").notNull(),
    printerId: uuid("printer_id")
      .notNull()
      .references(() => printers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ouDn, t.printerId] })],
);

export const ouSettings = pgTable("ou_settings", {
  ouDn: text("ou_dn").primaryKey(),
  blockInheritance: boolean("block_inheritance").notNull().default(false),
  blockedPrinterIds: jsonb("blocked_printer_ids").$type<string[]>().notNull().default([]),
  defaultPrinterId: uuid("default_printer_id").references(() => printers.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const computerOverrides = pgTable(
  "computer_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    computerGuid: text("computer_guid").notNull(),
    computerName: text("computer_name").notNull(),
    printerId: uuid("printer_id")
      .notNull()
      .references(() => printers.id, { onDelete: "cascade" }),
    action: text("action").$type<"add" | "block">().notNull(),
    makeDefault: boolean("make_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("computer_overrides_unique").on(t.computerGuid, t.printerId)],
);

export interface AgentReport {
  agentVersion?: string;
  osVersion?: string;
  manifestSerial?: string;
  applied?: string[];
  added?: string[];
  removed?: string[];
  defaultPrinter?: string | null;
  errors?: string[];
  legacy?: LegacyQueueResult[];
  /** Printer name -> duplex default the agent applied ("auto" = left alone). */
  sides?: Record<string, string>;
  method?: string;
  durationMs?: number;
  /** Self-update state (agents 0.4.3+). */
  update?: AgentUpdateStatus;
  /** High-severity problems (agents 0.4.6+), e.g. "PC left without printer X" after a takeover. */
  critical?: string[];
  /** Queues created with the TCP/IP port fallback because Add-Printer -IppURL failed (agents 0.4.6+). */
  fallbacks?: { printer: string; method: string; reason?: string }[];
  /** The agent's queues with their driver and port (agents 0.7+). */
  queues?: { name: string; driver?: string | null; port?: string | null; method?: string | null; vendorFallback?: string | null }[];
  /** Vendor driver results (agents 0.7+), see AGENT_DRIVER_STATES. */
  drivers?: { printer: string; status: (typeof AGENT_DRIVER_STATES)[number]; driverName?: string | null; message?: string | null }[];
  /** Agents 0.8+: the command poll task (minutes; 0 = off), commands run in this sync, and a task error. */
  commands?: { pollMinutes: number; ran?: number; deferred?: number; error?: string | null };
  /** Print analytics collection state (agents 0.5+). */
  analytics?: { enabled: boolean; logEnabled?: boolean | null; sent?: number; error?: string | null };
}

/**
 * Vendor driver results in agent reports: installed / present (already installed), wpp-blocked (Windows Protected
 * Print Mode: driverless used instead), failed, fallback (driverless queue kept or created instead), vendor-fallback
 * (0.8.1: a driverless printer whose -IppURL failed on this PC got its vendor-driver queue instead).
 */
export const AGENT_DRIVER_STATES = ["installed", "present", "wpp-blocked", "failed", "fallback", "vendor-fallback"] as const;

export const AGENT_UPDATE_STATES = ["current", "pending", "updated", "rolled-back", "failed", "skipped"] as const;

export interface AgentUpdateStatus {
  /** current: nothing happened; pending: installed, not run yet; updated: ran after an update; rolled-back; failed; skipped (e.g. downgrade refused). */
  state: (typeof AGENT_UPDATE_STATES)[number];
  /** The version the state is about (installed, rolled back, refused). */
  target?: string;
  error?: string;
  at?: string;
}

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectGuid: text("object_guid").notNull(),
    dn: text("dn").notNull(),
    computerName: text("computer_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    lastManifestAt: timestamp("last_manifest_at", { withTimezone: true }),
    lastReportAt: timestamp("last_report_at", { withTimezone: true }),
    lastReport: jsonb("last_report").$type<AgentReport>(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("agents_guid_unique").on(t.objectGuid), uniqueIndex("agents_token_unique").on(t.tokenHash)],
);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  details: jsonb("details").$type<Record<string, unknown>>(),
});

export type Printer = typeof printers.$inferSelect;
export type PrinterStatusRow = typeof printerStatus.$inferSelect;
export type Agent = typeof agents.$inferSelect;

// --- Directory snapshot (DIRECTORY_MODE=snapshot, pushed by the adsync sidecar) ---------------------------

export const directoryOus = pgTable("directory_ous", {
  dn: text("dn").primaryKey(),
  objectGuid: text("object_guid"),
  name: text("name").notNull(),
  description: text("description"),
});

export const directoryComputers = pgTable(
  "directory_computers",
  {
    objectGuid: text("object_guid").primaryKey(),
    dn: text("dn").notNull(),
    name: text("name").notNull(),
    dnsHostName: text("dns_host_name"),
    operatingSystem: text("operating_system"),
    userAccountControl: integer("user_account_control").notNull(),
    disabled: boolean("disabled").notNull(),
  },
  (t) => [uniqueIndex("directory_computers_dn_unique").on(sql`lower(${t.dn})`)],
);

/** One row (id = 1): the state of the last snapshot and of the last failed sync. */
export const directorySync = pgTable("directory_sync", {
  id: integer("id").primaryKey(),
  baseDn: text("base_dn"),
  defaultContainer: text("default_container"),
  /** Server time of the last snapshot that was stored. */
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  source: text("source"),
  ouCount: integer("ou_count").notNull().default(0),
  computerCount: integer("computer_count").notNull().default(0),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export type DirectorySyncRow = typeof directorySync.$inferSelect;

// --- Break-glass local admin users (LOCAL_LOGIN_ENABLED, scripts/local-user.ts) ---------------------------

export const localUsers = pgTable(
  "local_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lower-case [a-z0-9._-]. */
    username: text("username").notNull(),
    /** argon2id PHC string. */
    passwordHash: text("password_hash").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("local_users_username_unique").on(t.username)],
);

// --- Print analytics (ANALYTICS_ENABLED; agents 0.5+ send PrintService event 307) --------------------------

/** One printed document, as a PC's PrintService/Operational log recorded it (event 307). */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The reporting PC (objectGUID, name and DN at the time the event was received). */
    computerGuid: text("computer_guid").notNull(),
    computerName: text("computer_name").notNull(),
    /** Parent OU of the PC when the event was received (pages by OU / department). */
    ouDn: text("ou_dn"),
    /** EventRecordID in the PC's log. Unique per PC together with the event time (a cleared log restarts ids). */
    recordId: bigint("record_id", { mode: "number" }).notNull(),
    printedAt: timestamp("printed_at", { withTimezone: true }).notNull(),
    userName: text("user_name"),
    userSid: text("user_sid"),
    /** Client machine in the event (differs from the reporting PC for shared queues). */
    clientComputer: text("client_computer"),
    queueName: text("queue_name").notNull(),
    /** The Spoolfree printer when the queue is managed; null for queues Spoolfree does not manage. */
    printerId: uuid("printer_id").references(() => printers.id, { onDelete: "set null" }),
    port: text("port"),
    /** Host behind the queue's port (helps find hand-installed printers). */
    portHost: text("port_host"),
    pages: integer("pages"),
    bytes: bigint("bytes", { mode: "number" }),
    /** Only stored when ANALYTICS_COLLECT_DOCUMENT_NAMES is on. */
    documentName: text("document_name"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("print_jobs_event_unique").on(t.computerGuid, t.recordId, t.printedAt),
    index("print_jobs_printed_at_idx").on(t.printedAt),
    index("print_jobs_printer_idx").on(t.printerId, t.printedAt),
  ],
);

/**
 * Daily page-counter readings from the poller (IPP printer-impressions-completed / SNMP prtMarkerLifeCount).
 * first/last are the first and last readings of the day (ANALYTICS_TIME_ZONE); deltas give total pages.
 */
export const printerCounterDaily = pgTable(
  "printer_counter_daily",
  {
    printerId: uuid("printer_id")
      .notNull()
      .references(() => printers.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    /** Printer revision at the time: a replaced device has its own counter. */
    revision: integer("revision").notNull(),
    firstCount: bigint("first_count", { mode: "number" }).notNull(),
    lastCount: bigint("last_count", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.printerId, t.day] })],
);

export type PrintJob = typeof printJobs.$inferSelect;

// --- Test print (0.8) ---------------------------------------------------------------------------------------

/**
 * "direct": the server sent the page to the printer over IPP Print-Job. "pc": a signed command asked one PC's agent to
 * print through its Spoolfree queue (tests the PC's driver and queue).
 */
export type TestPrintMode = "direct" | "pc";
/**
 * queued (pc: waiting for the agent) -> delivered (the agent fetched the command) -> sent (job accepted by the
 * queue or the printer) -> printing -> printed | failed. A command that no agent ran in time ends as expired; one the
 * agent refused (bad signature, not its queue, ...) ends as rejected.
 */
/** unknown (0.8.1): the job was submitted but nothing confirmed it printed or failed (final, never shown as printed). */
export const TEST_PRINT_STATES = ["queued", "delivered", "sent", "printing", "printed", "failed", "expired", "rejected", "unknown"] as const;
export type TestPrintState = (typeof TEST_PRINT_STATES)[number];
export const TEST_PRINT_FINAL: TestPrintState[] = ["printed", "failed", "expired", "rejected", "unknown"];

export interface TestPrintEvent {
  state: TestPrintState;
  at: string;
  message?: string | null;
}

export const testPrints = pgTable(
  "test_prints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printerId: uuid("printer_id")
      .notNull()
      .references(() => printers.id, { onDelete: "cascade" }),
    /** Printer name at the time (the PC queue name for mode "pc"). */
    printerName: text("printer_name").notNull(),
    mode: text("mode").$type<TestPrintMode>().notNull(),
    /** Mode "pc": the agent that runs it. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    computerName: text("computer_name"),
    computerGuid: text("computer_guid"),
    requestedBy: text("requested_by").notNull(),
    state: text("state").$type<TestPrintState>().notNull(),
    /** Every state change with its time (the UI's timeline). */
    events: jsonb("events").$type<TestPrintEvent[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Mode "direct": the document format sent and the printer's job URI / id. Mode "pc": the spooler job id. */
    format: text("format"),
    jobId: integer("job_id"),
    jobUri: text("job_uri"),
    /** Last job state text (IPP job-state + reasons, or the Windows spooler JobStatus). */
    jobStatus: text("job_status"),
    error: text("error"),
  },
  (t) => [index("test_prints_printer_idx").on(t.printerId, t.createdAt), index("test_prints_agent_idx").on(t.agentId, t.state)],
);

export type TestPrint = typeof testPrints.$inferSelect;
