import { and, eq } from "drizzle-orm";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { db, schema } from "./db";
import { normalizeDn } from "./dn";

/**
 * Bulk import/export of printers, OU assignments and OU default printers (scripts/printers.ts).
 * Idempotent: printers are matched by name (case-insensitive); running the same file twice changes nothing.
 */

export const HOST_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;
export const NAME_RE = /^[^\\/,!]+$/;

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
    name: z.string().trim().min(1).max(100).regex(NAME_RE, "name cannot contain \\ / , or !"),
    host: z.string().trim().min(1).max(253).regex(HOST_RE, "not a valid hostname or IP").optional(),
    ip: z.string().trim().min(1).max(253).regex(HOST_RE, "not a valid hostname or IP").optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    ippPath: z.string().trim().min(1).max(200).optional(),
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
    assignments: dnList,
    defaultFor: dnList,
  })
  .refine((p) => p.host || p.ip, { message: "host (or ip) is required" })
  .transform(({ ip, ...p }) => ({
    ...p,
    host: (p.host ?? ip)!,
    port: p.port ?? 631,
    ippPath: p.ippPath ?? "/ipp/print",
  }));
export type PrinterSpec = z.output<typeof PrinterSpec>;

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
  duplex: "defaultSides",
  sides: "defaultSides",
  default_sides: "defaultSides",
  assignments: "assignments",
  ous: "assignments",
  default_for: "defaultFor",
};

export function parseInput(text: string, format: "yaml" | "csv"): PrinterSpec[] {
  let raw: unknown[];
  if (format === "csv") {
    const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
    if (!header) return [];
    const keys = header.map((h) => {
      const k = CSV_COLUMNS[h.trim().toLowerCase().replace(/[\s-]+/g, "_")];
      if (!k) throw new Error(`unknown CSV column "${h}"`);
      return k;
    });
    raw = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]).filter(([, v]) => v !== "")));
  } else {
    const doc = parseYaml(text) as unknown;
    raw = Array.isArray(doc) ? doc : ((doc as { printers?: unknown[] } | null)?.printers ?? []);
    if (!Array.isArray(raw)) throw new Error("YAML must be a list of printers or { printers: [...] }");
  }
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
  return out;
}

// --- Planning (pure) -----------------------------------------------------------------------------------

export interface CurrentState {
  printers: (typeof schema.printers.$inferSelect)[];
  assignments: { ouDn: string; printerId: string }[];
  ouSettings: { ouDn: string; defaultPrinterId: string | null }[];
}

export type Step =
  | { kind: "create"; name: string; spec: PrinterSpec }
  | { kind: "update"; name: string; id: string; changes: Record<string, unknown>; bumpRevision: boolean }
  | { kind: "unchanged"; name: string }
  | { kind: "assign"; name: string; ouDn: string }
  | { kind: "unassign"; name: string; id: string; ouDn: string }
  | { kind: "default"; name: string; ouDn: string; previous: string | null };

const FIELDS = ["host", "port", "ippPath", "useTls", "location", "model", "notes", "legacyTakeover", "legacyShares", "defaultSides"] as const;
const ENDPOINT = new Set(["host", "port", "ippPath", "useTls"]);

export function plan(specs: PrinterSpec[], cur: CurrentState, opts: { pruneAssignments?: boolean } = {}): Step[] {
  const steps: Step[] = [];
  const byName = new Map(cur.printers.map((p) => [p.name.toLowerCase(), p]));
  const nameById = new Map(cur.printers.map((p) => [p.id, p.name]));
  const assigned = new Set(cur.assignments.map((a) => `${a.printerId}|${normalizeDn(a.ouDn)}`));
  const defaults = new Map(cur.ouSettings.map((s) => [normalizeDn(s.ouDn), s.defaultPrinterId]));

  for (const spec of specs) {
    const existing = byName.get(spec.name.toLowerCase());
    if (!existing) steps.push({ kind: "create", name: spec.name, spec });
    else {
      const changes: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const want = spec[f];
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
  }
}

// --- Database ------------------------------------------------------------------------------------------

export async function loadState(): Promise<CurrentState> {
  const d = db();
  const [printers, assignments, ouSettings] = await Promise.all([
    d.select().from(schema.printers),
    d.select({ ouDn: schema.ouAssignments.ouDn, printerId: schema.ouAssignments.printerId }).from(schema.ouAssignments),
    d.select({ ouDn: schema.ouSettings.ouDn, defaultPrinterId: schema.ouSettings.defaultPrinterId }).from(schema.ouSettings),
  ]);
  return { printers, assignments, ouSettings };
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
          .set({ ...s.changes, updatedAt: new Date(), ...(s.bumpRevision ? { revision: before.revision + 1 } : {}) })
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
      }
    }
  });
}

const eqId = (id: string) => eq(schema.printers.id, id);
const andAssignment = (ouDn: string, printerId: string) => and(eq(schema.ouAssignments.ouDn, ouDn), eq(schema.ouAssignments.printerId, printerId));

// --- Export --------------------------------------------------------------------------------------------

export function toSpecs(cur: CurrentState): Record<string, unknown>[] {
  const out = [];
  for (const p of [...cur.printers].sort((a, b) => a.name.localeCompare(b.name))) {
    const assignments = cur.assignments.filter((a) => a.printerId === p.id).map((a) => a.ouDn).sort();
    const defaultFor = cur.ouSettings.filter((s) => s.defaultPrinterId === p.id).map((s) => s.ouDn).sort();
    out.push({
      name: p.name,
      host: p.host,
      ...(p.port !== 631 ? { port: p.port } : {}),
      ...(p.ippPath !== "/ipp/print" ? { ippPath: p.ippPath } : {}),
      ...(p.useTls ? { useTls: true } : {}),
      ...(p.location ? { location: p.location } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.defaultSides !== "auto" ? { defaultSides: p.defaultSides } : {}),
      ...(p.legacyTakeover !== "off" ? { legacyTakeover: p.legacyTakeover } : {}),
      ...(p.legacyShares.length ? { legacyShares: p.legacyShares } : {}),
      ...(assignments.length ? { assignments } : {}),
      ...(defaultFor.length ? { defaultFor } : {}),
    });
  }
  return out;
}

export function exportYaml(cur: CurrentState): string {
  return stringifyYaml({ printers: toSpecs(cur) }, { lineWidth: 0 });
}

const csvField = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(";") : v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(cur: CurrentState): string {
  const cols = ["name", "host", "port", "ipp_path", "tls", "location", "model", "notes", "duplex", "takeover", "shares", "assignments", "default_for"];
  const lines = [cols.join(",")];
  for (const p of toSpecs(cur)) {
    lines.push(
      [p.name, p.host, p.port ?? 631, p.ippPath ?? "/ipp/print", p.useTls ? "true" : "false", p.location, p.model, p.notes, p.defaultSides ?? "auto", p.legacyTakeover ?? "off", p.legacyShares, p.assignments, p.defaultFor]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
