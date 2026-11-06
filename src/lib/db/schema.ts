import { sql } from "drizzle-orm";
import {
  bigint,
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
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTest: jsonb("last_test").$type<DriverlessCheck & { error?: string | null; ippPath?: string; ippRequestVersion?: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("printers_name_unique").on(sql`lower(${t.name})`)],
);

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
  /** Print analytics collection state (agents 0.5+). */
  analytics?: { enabled: boolean; logEnabled?: boolean | null; sent?: number; error?: string | null };
}

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
