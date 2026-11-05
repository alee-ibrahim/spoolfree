import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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

export const printers = pgTable(
  "printers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Logical queue name shown on PCs. Stable across replacements. */
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(631),
    ippPath: text("ipp_path").notNull().default("/ipp/print"),
    useTls: boolean("use_tls").notNull().default(false),
    location: text("location"),
    model: text("model"),
    notes: text("notes"),
    /** Incremented on "Replace" so agents re-create the queue. */
    revision: integer("revision").notNull().default(1),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTest: jsonb("last_test").$type<DriverlessCheck & { error?: string | null }>(),
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
  method?: string;
  durationMs?: number;
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
