import { and, eq } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { db, schema } from "./db";
import { aliasList } from "./aliases";
import { normalizeDn } from "./dn";
import { PRINTER_NAME_RE } from "./printer-name";

/**
 * Bulk import/export of printers, OU assignments, OU default printers and per-computer overrides
 * (scripts/printers.ts). Idempotent: printers are matched by name (case-insensitive) and computers by name
 * or DN; running the same file twice changes nothing.
 */

export const HOST_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;
export const NAME_RE = PRINTER_NAME_RE;

const list = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : (v ?? "").split(/\s*[;\n|]\s*/))
      .map((s) => s.trim())
      .filter(Boolean),
  );
const dnList = list.pipe(z.array(z.string().max(2048).regex(/^[A-Za-z]+=.+/, "not a distinguished name")));
const optText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim()))
    .pipe(z.string().max(max).nullable());
const bool = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform((v) => v === true || v === 1 || (typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim())));

export const PrinterSpec = z
  .object({
    name: z.string().trim().min(1).max(100).regex(NAME_RE, 'name cannot contain \\ / , ! " or control characters'),
    host: z.string().trim().min(1).max(253).regex(HOST_RE, "not a valid hostname or IP").optional(),
    ip: z.string().trim().min(1).max(253).regex(HOST_RE, "not a valid hostname or IP").optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    /** Omitted, empty or "auto": detected by Test. A path: manual override. */
    ippPath: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((v) => (!v || v.toLowerCase() === "auto" ? undefined : v.startsWith("/") ? v : `/${v}`)),
    useTls: bool,
    location: optText(200),
    model: optText(200),
    notes: optText(2000),
    legacyTakeover: z
      .union([z.enum(["off", "dry-run", "on"]), z.boolean()])
      .optional()
      .transform((v) => (v === true ? "on" : v === false || v === undefined ? "off" : v)),
    defaultSides: z.enum(["auto", "one-sided", "two-sided-long-edge", "two-sided-short-edge"]).default("auto"),
    legacyShares: list.pipe(z.array(z.string().max(80).regex(/^[^\\/]+$/, "share names only, without \\\\server\\"))),
    legacyAliases: aliasList,
    /** auto (default), driverless or vendor (docs/drivers.md). */
    driverMode: z.enum(["auto", "driverless", "vendor"]).default("auto"),
    /** Driver package by name (vendor mode). */
    driverPackage: optText(100),
    driverName: optText(200),
    /** Port of vendor-driver queues. */
    protocol: z.enum(["raw9100", "lpr", "ipp"]).default("raw9100"),
    lprQueue: optText(64),
    assignments: dnList,
    defaultFor: dnList,
  })
  .refine((p) => p.host || p.ip, { message: "host (or ip) is required" })
  .refine((p) => p.driverMode !== "vendor" || (p.driverPackage && p.driverName), { message: "driverMode vendor needs driverPackage and driverName" })
  .transform(({ ip, protocol, ...p }) => ({
    ...p,
    host: (p.host ?? ip)!,
    port: p.port ?? 631,
    ippPathAuto: p.ippPath === undefined,
    vendorProtocol: protocol,
  }));
export type PrinterSpec = z.output<typeof PrinterSpec>;

const printerNames = list.pipe(z.array(z.string().min(1).max(100)));

/**
 * Per-computer overrides (YAML only): `add` adds printers to this computer, `block` removes inherited ones,
 * `default` makes one of them the computer's default (it is added if not listed in `add`).
 */
export const ComputerSpec = z
  .object({
    name: z.string().trim().min(1).max(64).regex(/^[^\\/,=]+$/, "a computer name, without domain or DN").optional(),
    dn: z.string().trim().max(2048).regex(/^CN=.+/i, "not a computer distinguished name (CN=...)").optional(),
    add: printerNames,
    block: printerNames,
    default: optText(100),
  })
  .strict()
  .refine((c) => c.name || c.dn, { message: "name or dn is required" })
  .superRefine((c, ctx) => {
    const add = new Set(c.add.map((n) => n.toLowerCase()));
    if (c.default) add.add(c.default.toLowerCase());
    const both = c.block.filter((n) => add.has(n.toLowerCase()));
    if (both.length) ctx.addIssue({ code: "custom", message: `printer both added and blocked: ${both.join(", ")}` });
    const seen = new Set<string>();
    for (const n of [...c.add, ...c.block]) {
      if (seen.has(n.toLowerCase())) ctx.addIssue({ code: "custom", message: `printer listed twice: ${n}` });
      seen.add(n.toLowerCase());
    }
  });
export type ComputerSpec = z.output<typeof ComputerSpec>;

export interface ImportDocument {
  printers: PrinterSpec[];
  computers: ComputerSpec[];
}

// --- Parsing ------------------------------------------------------------------------------------------

/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const CSV_COLUMNS: Record<string, string> = {
  name: "name",
  host: "host",
  ip: "ip",
  port: "port",
  ipp_path: "ippPath",
  ipppath: "ippPath",
  tls: "useTls",
  use_tls: "useTls",
  location: "location",
  model: "model",
  notes: "notes",
  takeover: "legacyTakeover",
  legacy_takeover: "legacyTakeover",
  shares: "legacyShares",
  legacy_shares: "legacyShares",
  aliases: "legacyAliases",
  legacy_aliases: "legacyAliases",
  legacy_hostnames: "legacyAliases",
  driver_mode: "driverMode",
  driver_package: "driverPackage",
  driver_name: "driverName",
  protocol: "protocol",
  lpr_queue: "lprQueue",
  duplex: "defaultSides",
  sides: "defaultSides",
  default_sides: "defaultSides",
  assignments: "assignments",
  ous: "assignments",
  default_for: "defaultFor",
};

export function parseInput(text: string, format: "yaml" | "csv"): PrinterSpec[] {
  return parseDocument(text, format).printers;
}

/** Printers and (YAML only) a `computers:` list of per-computer overrides. */
export function parseDocument(text: string, format: "yaml" | "csv"): ImportDocument {
  let raw: unknown[];
  let rawComputers: unknown = [];
  if (format === "csv") {
    const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
    if (!header) return { printers: [], computers: [] };
    const keys = header.map((h) => {
      const k = CSV_COLUMNS[h.trim().toLowerCase().replace(/[\s-]+/g, "_")];
      if (!k) throw new Error(`unknown CSV column "${h}"`);
      return k;
    });
    raw = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]).filter(([, v]) => v !== "")));
  } else {
    const doc = parseYaml(text) as unknown;
    raw = Array.isArray(doc) ? doc : ((doc as { printers?: unknown[] } | null)?.printers ?? []);
    if (!Array.isArray(raw)) throw new Error("YAML must be a list of printers or { printers: [...], computers: [...] }");
    rawComputers = Array.isArray(doc) ? [] : ((doc as { computers?: unknown } | null)?.computers ?? []);
  }
  if (!Array.isArray(rawComputers)) throw new Error("computers: must be a list");
  const out: PrinterSpec[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const p = PrinterSpec.safeParse(r);
    if (!p.success) {
      const name = (r as { name?: unknown })?.name;
      throw new Error(`entry ${i + 1}${name ? ` (${String(name)})` : ""}: ${p.error.issues.map((x) => `${x.path.join(".") || "entry"}: ${x.message}`).join("; ")}`);
    }
    const key = p.data.name.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate printer name: ${p.data.name}`);
    seen.add(key);
    out.push(p.data);
  });
  const computers: ComputerSpec[] = [];
  const seenComputers = new Set<string>();
  rawComputers.forEach((r: unknown, i: number) => {
    const c = ComputerSpec.safeParse(r);
    if (!c.success) {
      const label = (r as { name?: unknown } | null)?.name ?? (r as { dn?: unknown } | null)?.dn;
      throw new Error(`computers entry ${i + 1}${label ? ` (${String(label)})` : ""}: ${c.error.issues.map((x) => `${x.path.join(".") || "entry"}: ${x.message}`).join("; ")}`);
    }
    const key = c.data.dn ? `dn:${normalizeDn(c.data.dn)}` : `name:${c.data.name!.toLowerCase()}`;
    if (seenComputers.has(key)) throw new Error(`duplicate computer: ${c.data.dn ?? c.data.name}`);
    seenComputers.add(key);
    computers.push(c.data);
  });
  return { printers: out, computers };
}

// --- Planning (pure) -----------------------------------------------------------------------------------

export interface CurrentState {
  printers: (typeof schema.printers.$inferSelect)[];
  assignments: { ouDn: string; printerId: string }[];
  ouSettings: { ouDn: string; defaultPrinterId: string | null }[];
  /** Per-computer overrides (absent: treated as none). */
  overrides?: OverrideRow[];
  /** Driver packages (absent: none), for driverPackage names. */
  driverPackages?: { id: string; name: string; infs: schema.DriverInf[] }[];
}

export interface OverrideRow {
  computerGuid: string;
  computerName: string;
  printerId: string;
  action: "add" | "block";
  makeDefault: boolean;
}

/** A computer as the directory knows it (name/DN lookup for `computers:` entries). */
export interface DirectoryComputer {
  objectGuid: string;
  dn: string;
  name: string;
}

/** A printer spec with driverPackage resolved to the package id (the shape that is written). */
export type ResolvedSpec = Omit<PrinterSpec, "driverPackage"> & { driverPackageId: string | null };

export type Step =
  | { kind: "create"; name: string; spec: ResolvedSpec }
  | { kind: "update"; name: string; id: string; changes: Record<string, unknown>; bumpRevision: boolean }
  | { kind: "unchanged"; name: string }
  | { kind: "assign"; name: string; ouDn: string }
  | { kind: "unassign"; name: string; id: string; ouDn: string }
  | { kind: "default"; name: string; ouDn: string; previous: string | null }
  | { kind: "override"; name: string; computer: string; computerGuid: string; action: "add" | "block"; makeDefault: boolean; previous: string | null }
  | { kind: "unoverride"; name: string; computer: string; computerGuid: string; printerId: string };

const FIELDS = [
  "host",
  "port",
  "ippPathAuto",
  "ippPath",
  "useTls",
  "location",
  "model",
  "notes",
  "legacyTakeover",
  "legacyShares",
  "legacyAliases",
  "defaultSides",
  "driverMode",
  "driverPackageId",
  "driverName",
  "vendorProtocol",
  "lprQueue",
] as const;

/** driverPackage name -> id; checks that driverName is a driver of that package. */
export function resolveSpec(spec: PrinterSpec, cur: CurrentState): ResolvedSpec {
  const { driverPackage, ...rest } = spec;
  if (!driverPackage) return { ...rest, driverPackageId: null };
  const pkg = (cur.driverPackages ?? []).find((p) => p.name.toLowerCase() === driverPackage.toLowerCase());
  if (!pkg) throw new Error(`${spec.name}: unknown driver package "${driverPackage}" (upload it with drivers upload first)`);
  if (rest.driverName && !pkg.infs.some((i) => i.models.some((m) => m.name.toLowerCase() === rest.driverName!.toLowerCase())))
    throw new Error(`${spec.name}: "${rest.driverName}" is not a driver in package "${pkg.name}"`);
  const exact = rest.driverName ? pkg.infs.flatMap((i) => i.models).find((m) => m.name.toLowerCase() === rest.driverName!.toLowerCase())!.name : null;
  return { ...rest, driverName: exact, driverPackageId: pkg.id };
}
const ENDPOINT = new Set(["host", "port", "ippPath", "useTls"]);

export function plan(specs: PrinterSpec[], cur: CurrentState, opts: { pruneAssignments?: boolean } = {}): Step[] {
  const steps: Step[] = [];
  const byName = new Map(cur.printers.map((p) => [p.name.toLowerCase(), p]));
  const nameById = new Map(cur.printers.map((p) => [p.id, p.name]));
  const assigned = new Set(cur.assignments.map((a) => `${a.printerId}|${normalizeDn(a.ouDn)}`));
  const defaults = new Map(cur.ouSettings.map((s) => [normalizeDn(s.ouDn), s.defaultPrinterId]));

  for (const raw of specs) {
    const spec = resolveSpec(raw, cur);
    const existing = byName.get(spec.name.toLowerCase());
    if (!existing) steps.push({ kind: "create", name: spec.name, spec });
    else {
      const changes: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const want = spec[f];
        // Auto mode: the stored (detected) path is kept.
        if (f === "ippPath" && want === undefined) continue;
        const have = existing[f];
        if (JSON.stringify(want) !== JSON.stringify(have)) changes[f] = want;
      }
      if (existing.name !== spec.name) changes.name = spec.name;
      if (Object.keys(changes).length === 0) steps.push({ kind: "unchanged", name: spec.name });
      else
        steps.push({
          kind: "update",
          name: spec.name,
          id: existing.id,
          changes,
          bumpRevision: Object.keys(changes).some((k) => ENDPOINT.has(k)),
        });
    }
    const id = existing?.id;
    const wanted = new Set(spec.assignments.map(normalizeDn));
    for (const dn of spec.assignments) {
      if (!id || !assigned.has(`${id}|${normalizeDn(dn)}`)) steps.push({ kind: "assign", name: spec.name, ouDn: dn });
    }
    if (opts.pruneAssignments && id) {
      for (const a of cur.assignments) {
        if (a.printerId === id && !wanted.has(normalizeDn(a.ouDn))) steps.push({ kind: "unassign", name: spec.name, id, ouDn: a.ouDn });
      }
    }
    for (const dn of spec.defaultFor) {
      const prev = defaults.get(normalizeDn(dn)) ?? null;
      if (!id || prev !== id) steps.push({ kind: "default", name: spec.name, ouDn: dn, previous: prev ? (nameById.get(prev) ?? prev) : null });
    }
  }
  return steps;
}

/**
 * Per-computer overrides. Computers are found in the directory by DN or by name (case-insensitive; an
 * ambiguous name is an error). Printer names must exist or be created by the same file (newPrinters). With
 * pruneOverrides, overrides of the listed computers that the file does not mention are removed.
 */
export function planComputers(
  computers: ComputerSpec[],
  cur: CurrentState,
  directoryComputers: DirectoryComputer[],
  opts: { pruneOverrides?: boolean; newPrinters?: string[] } = {},
): Step[] {
  const steps: Step[] = [];
  const byName = new Map(cur.printers.map((p) => [p.name.toLowerCase(), p]));
  const nameById = new Map(cur.printers.map((p) => [p.id, p.name]));
  const created = new Set((opts.newPrinters ?? []).map((n) => n.toLowerCase()));
  const overrides = cur.overrides ?? [];
  const printerRef = (n: string, label: string): { name: string; id: string | null } => {
    const p = byName.get(n.toLowerCase());
    if (p) return { name: p.name, id: p.id };
    if (created.has(n.toLowerCase())) return { name: n, id: null };
    throw new Error(`computer ${label}: unknown printer "${n}"`);
  };
  const seenGuids = new Set<string>();

  for (const c of computers) {
    const label = c.dn ?? c.name!;
    let matches = directoryComputers.filter((d) =>
      c.dn ? normalizeDn(d.dn) === normalizeDn(c.dn) : d.name.toLowerCase() === c.name!.toLowerCase(),
    );
    if (c.dn && c.name) matches = matches.filter((d) => d.name.toLowerCase() === c.name!.toLowerCase());
    if (matches.length === 0) throw new Error(`computer ${label}: not found in the directory${c.dn && c.name ? " (or its name does not match the DN)" : ""}`);
    if (matches.length > 1) throw new Error(`computer ${label}: ${matches.length} computers have this name; use dn instead`);
    const comp = matches[0];
    const guid = comp.objectGuid.toLowerCase();
    if (seenGuids.has(guid)) throw new Error(`computer ${label}: listed twice`);
    seenGuids.add(guid);

    const want = new Map<string, { name: string; id: string | null; action: "add" | "block"; makeDefault: boolean }>();
    for (const n of c.add) {
      const p = printerRef(n, label);
      want.set(p.name.toLowerCase(), { ...p, action: "add", makeDefault: false });
    }
    if (c.default) {
      const p = printerRef(c.default, label);
      want.set(p.name.toLowerCase(), { ...p, action: "add", makeDefault: true });
    }
    for (const n of c.block) {
      const p = printerRef(n, label);
      want.set(p.name.toLowerCase(), { ...p, action: "block", makeDefault: false });
    }
    const mine = overrides.filter((o) => o.computerGuid.toLowerCase() === guid);
    const before = steps.length;
    for (const w of want.values()) {
      const have = w.id ? mine.find((o) => o.printerId === w.id) : undefined;
      if (have && have.action === w.action && have.makeDefault === w.makeDefault) continue;
      steps.push({
        kind: "override",
        name: w.name,
        computer: comp.name,
        computerGuid: guid,
        action: w.action,
        makeDefault: w.makeDefault,
        previous: have ? `${have.action}${have.makeDefault ? " (default)" : ""}` : null,
      });
    }
    if (opts.pruneOverrides) {
      const wantedIds = new Set([...want.values()].map((w) => w.id).filter((id): id is string => id !== null));
      for (const o of mine) {
        if (!wantedIds.has(o.printerId))
          steps.push({ kind: "unoverride", name: nameById.get(o.printerId) ?? o.printerId, computer: comp.name, computerGuid: guid, printerId: o.printerId });
      }
    }
    if (steps.length === before) steps.push({ kind: "unchanged", name: `computer ${comp.name}` });
  }
  return steps;
}

export function describe(s: Step): string {
  switch (s.kind) {
    case "create":
      return `create   ${s.name} (${s.spec.host})`;
    case "update":
      return `update   ${s.name}: ${Object.keys(s.changes).join(", ")}${s.bumpRevision ? " (endpoint changed: PCs re-create the queue)" : ""}`;
    case "unchanged":
      return `ok       ${s.name}`;
    case "assign":
      return `assign   ${s.name} -> ${s.ouDn}`;
    case "unassign":
      return `unassign ${s.name} -x ${s.ouDn}`;
    case "default":
      return `default  ${s.ouDn}: ${s.previous ?? "(none)"} -> ${s.name}`;
    case "override":
      return `${s.action === "add" ? "add     " : "block   "} ${s.computer}: ${s.name}${s.makeDefault ? " (default)" : ""}${s.previous ? ` (was: ${s.previous})` : ""}`;
    case "unoverride":
      return `unset    ${s.computer}: ${s.name}`;
  }
}

// --- Database ------------------------------------------------------------------------------------------

export async function loadState(): Promise<CurrentState> {
  const d = db();
  const [printers, assignments, ouSettings, overrides, driverPackages] = await Promise.all([
    d.select().from(schema.printers),
    d.select({ ouDn: schema.ouAssignments.ouDn, printerId: schema.ouAssignments.printerId }).from(schema.ouAssignments),
    d.select({ ouDn: schema.ouSettings.ouDn, defaultPrinterId: schema.ouSettings.defaultPrinterId }).from(schema.ouSettings),
    d
      .select({
        computerGuid: schema.computerOverrides.computerGuid,
        computerName: schema.computerOverrides.computerName,
        printerId: schema.computerOverrides.printerId,
        action: schema.computerOverrides.action,
        makeDefault: schema.computerOverrides.makeDefault,
      })
      .from(schema.computerOverrides),
    d.select({ id: schema.driverPackages.id, name: schema.driverPackages.name, infs: schema.driverPackages.infs }).from(schema.driverPackages),
  ]);
  return { printers, assignments, ouSettings, overrides, driverPackages };
}

/** Applies a plan in one transaction; every change gets an audit entry with actor "cli". */
export async function apply(steps: Step[], actor = "cli"): Promise<void> {
  await db().transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const p of await tx.select({ id: schema.printers.id, name: schema.printers.name }).from(schema.printers)) ids.set(p.name.toLowerCase(), p.id);
    const audit = (action: string, entityType: string, entityId: string | null, details?: Record<string, unknown>) =>
      tx.insert(schema.auditLog).values({ actor, action, entityType, entityId, details: details ?? null });

    for (const s of steps) {
      const key = s.name.toLowerCase();
      if (s.kind === "create") {
        const { assignments, defaultFor, ...values } = s.spec;
        void assignments;
        void defaultFor;
        const [row] = await tx.insert(schema.printers).values(values).returning({ id: schema.printers.id });
        ids.set(key, row.id);
        await audit("printer.create", "printer", row.id, { ...values, source: "bulk import" });
      } else if (s.kind === "update") {
        const [before] = await tx.select({ revision: schema.printers.revision }).from(schema.printers).where(eqId(s.id));
        await tx
          .update(schema.printers)
          .set({
            ...s.changes,
            updatedAt: new Date(),
            // A new driver mode starts auto mode's decision over (no sticky vendor decision).
            ...("driverMode" in s.changes ? { autoVendorReason: null, autoVendorAt: null } : {}),
            // A new endpoint may be another device: its printer-uuid/MACs are read again by Test or the poller.
            ...(s.bumpRevision ? { revision: before.revision + 1, deviceUuid: null, macAddresses: [], identityCheckedAt: null } : {}),
          })
          .where(eqId(s.id));
        await audit("printer.update", "printer", s.id, { changes: s.changes, source: "bulk import" });
      } else if (s.kind === "assign") {
        const id = ids.get(key)!;
        await tx.insert(schema.ouAssignments).values({ ouDn: s.ouDn, printerId: id }).onConflictDoNothing();
        await audit("assignment.add", "ou", s.ouDn, { printerId: id, printer: s.name, source: "bulk import" });
      } else if (s.kind === "unassign") {
        await tx.delete(schema.ouAssignments).where(andAssignment(s.ouDn, s.id));
        await audit("assignment.remove", "ou", s.ouDn, { printerId: s.id, printer: s.name, source: "bulk import" });
      } else if (s.kind === "default") {
        const id = ids.get(key)!;
        await tx
          .insert(schema.ouSettings)
          .values({ ouDn: s.ouDn, defaultPrinterId: id })
          .onConflictDoUpdate({ target: schema.ouSettings.ouDn, set: { defaultPrinterId: id, updatedAt: new Date() } });
        await audit("ou.default", "ou", s.ouDn, { printerId: id, printer: s.name, source: "bulk import" });
      } else if (s.kind === "override") {
        const id = ids.get(key)!;
        const values = { computerGuid: s.computerGuid, computerName: s.computer, printerId: id, action: s.action, makeDefault: s.makeDefault };
        await tx
          .insert(schema.computerOverrides)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.computerOverrides.computerGuid, schema.computerOverrides.printerId],
            set: { action: s.action, makeDefault: s.makeDefault, computerName: s.computer },
          });
        await audit(`override.${s.action}`, "computer", s.computerGuid, { computer: s.computer, printerId: id, printer: s.name, makeDefault: s.makeDefault, source: "bulk import" });
      } else if (s.kind === "unoverride") {
        await tx
          .delete(schema.computerOverrides)
          .where(and(eq(schema.computerOverrides.computerGuid, s.computerGuid), eq(schema.computerOverrides.printerId, s.printerId)));
        await audit("override.remove", "computer", s.computerGuid, { computer: s.computer, printerId: s.printerId, printer: s.name, source: "bulk import" });
      }
    }
  });
}

const eqId = (id: string) => eq(schema.printers.id, id);
const andAssignment = (ouDn: string, printerId: string) => and(eq(schema.ouAssignments.ouDn, ouDn), eq(schema.ouAssignments.printerId, printerId));

// --- Export --------------------------------------------------------------------------------------------

export function toSpecs(cur: CurrentState): Record<string, unknown>[] {
  const out = [];
  const pkgName = new Map((cur.driverPackages ?? []).map((p) => [p.id, p.name]));
  for (const p of [...cur.printers].sort((a, b) => a.name.localeCompare(b.name))) {
    const assignments = cur.assignments.filter((a) => a.printerId === p.id).map((a) => a.ouDn).sort();
    const defaultFor = cur.ouSettings.filter((s) => s.defaultPrinterId === p.id).map((s) => s.ouDn).sort();
    out.push({
      name: p.name,
      host: p.host,
      ...(p.port !== 631 ? { port: p.port } : {}),
      ...(!p.ippPathAuto ? { ippPath: p.ippPath } : {}),
      ...(p.useTls ? { useTls: true } : {}),
      ...(p.location ? { location: p.location } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.defaultSides !== "auto" ? { defaultSides: p.defaultSides } : {}),
      ...(p.legacyTakeover !== "off" ? { legacyTakeover: p.legacyTakeover } : {}),
      ...(p.legacyShares.length ? { legacyShares: p.legacyShares } : {}),
      ...(p.legacyAliases?.length ? { legacyAliases: p.legacyAliases } : {}),
      ...(p.driverMode && p.driverMode !== "auto" ? { driverMode: p.driverMode } : {}),
      ...(p.driverPackageId ? { driverPackage: pkgName.get(p.driverPackageId) ?? p.driverPackageId } : {}),
      ...(p.driverName ? { driverName: p.driverName } : {}),
      ...(p.vendorProtocol && p.vendorProtocol !== "raw9100" ? { protocol: p.vendorProtocol } : {}),
      ...(p.lprQueue ? { lprQueue: p.lprQueue } : {}),
      ...(assignments.length ? { assignments } : {}),
      ...(defaultFor.length ? { defaultFor } : {}),
    });
  }
  return out;
}

/** Per-computer overrides as `computers:` entries (by computer name), sorted by name. */
export function toComputerSpecs(cur: CurrentState): Record<string, unknown>[] {
  const nameById = new Map(cur.printers.map((p) => [p.id, p.name]));
  const byGuid = new Map<string, OverrideRow[]>();
  for (const o of cur.overrides ?? []) {
    const k = o.computerGuid.toLowerCase();
    byGuid.set(k, [...(byGuid.get(k) ?? []), o]);
  }
  const out: Record<string, unknown>[] = [];
  for (const rows of byGuid.values()) {
    const names = (pred: (o: OverrideRow) => boolean) =>
      rows
        .filter(pred)
        .map((o) => nameById.get(o.printerId))
        .filter((n): n is string => !!n)
        .sort();
    const add = names((o) => o.action === "add" && !o.makeDefault);
    const block = names((o) => o.action === "block");
    const def = names((o) => o.action === "add" && o.makeDefault)[0];
    out.push({ name: rows[0].computerName, ...(add.length ? { add } : {}), ...(block.length ? { block } : {}), ...(def ? { default: def } : {}) });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function exportYaml(cur: CurrentState): string {
  const computers = toComputerSpecs(cur);
  return stringifyYaml({ printers: toSpecs(cur), ...(computers.length ? { computers } : {}) }, { lineWidth: 0 });
}

const csvField = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(";") : v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(cur: CurrentState): string {
  const cols = ["name", "host", "port", "ipp_path", "tls", "location", "model", "notes", "duplex", "takeover", "shares", "aliases", "driver_mode", "driver_package", "driver_name", "protocol", "lpr_queue", "assignments", "default_for"];
  const lines = [cols.join(",")];
  for (const p of toSpecs(cur)) {
    lines.push(
      [p.name, p.host, p.port ?? 631, p.ippPath ?? "auto", p.useTls ? "true" : "false", p.location, p.model, p.notes, p.defaultSides ?? "auto", p.legacyTakeover ?? "off", p.legacyShares, p.legacyAliases, p.driverMode ?? "auto", p.driverPackage, p.driverName, p.protocol ?? "raw9100", p.lprQueue, p.assignments, p.defaultFor]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
