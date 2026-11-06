"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { directory } from "@/lib/directory";
import { normalizeDn } from "@/lib/dn";
import { aliasList } from "@/lib/aliases";
import { getPrinterAttributes } from "@/lib/ipp/client";
import { detectIppPath, IppDetectError, type DetectedPath } from "@/lib/ipp/detect";
import { checkDriverless, printerUri, TEST_ATTRIBUTES, type DriverlessCheck } from "@/lib/ipp/interpret";
import { requireAdmin } from "@/lib/session";
import { refreshIdentity } from "@/lib/status/identity";
import { audit } from "@/lib/service";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const hostRe = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;

const PrinterInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100)
    .regex(/^[^\\/,!]+$/, "Name cannot contain \\ / , or !"),
  host: z.string().trim().min(1, "Host is required").max(253).regex(hostRe, "Not a valid hostname or IP"),
  port: z.coerce.number().int().min(1).max(65535).default(631),
  /** Manual IPP path; empty = auto-detect. */
  ippPathOverride: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? (v.startsWith("/") ? v : `/${v}`) : null))
    .pipe(z.string().regex(/^\/[\x21-\x7e]*$/, "The IPP path must be a URL path such as /ipp/print").nullable()),
  useTls: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  location: z.string().trim().max(200).optional().transform((v) => v || null),
  model: z.string().trim().max(200).optional().transform((v) => v || null),
  notes: z.string().trim().max(2000).optional().transform((v) => v || null),
  legacyTakeover: z.enum(["off", "dry-run", "on"]).default("off"),
  defaultSides: z.enum(["auto", "one-sided", "two-sided-long-edge", "two-sided-short-edge"]).default("auto"),
  legacyShares: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => [...new Set((v ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(80).regex(/^[^\\/]+$/, "Share names only, without \\\\server\\"))),
  legacyAliases: aliasList,
});

function formObject(fd: FormData) {
  return Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
}

function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Invalid input";
}

function revalidateAll() {
  for (const p of ["/", "/printers", "/assignments", "/preview", "/unassigned", "/agents", "/audit", "/analytics"]) revalidatePath(p);
}

/** Short timeout for detection while saving: an unreachable host fails fast and the path stays as it was. */
const SAVE_DETECT_TIMEOUT_MS = 4000;

/** Best-effort IPP path detection for a new endpoint; null when the device does not answer. */
async function detectOnSave(endpoint: { host: string; port: number; useTls: boolean }): Promise<DetectedPath | null> {
  try {
    return await detectIppPath(endpoint, ["printer-uri-supported"], Math.min(config().POLL_TIMEOUT_MS, SAVE_DETECT_TIMEOUT_MS), getPrinterAttributes);
  } catch {
    return null;
  }
}

/**
 * The IPP path to store: a manual override as given; in auto mode the detected path when the endpoint is new or
 * changed (or the printer just switched to auto), otherwise the stored one.
 */
async function resolveIppPath(
  input: { host: string; port: number; useTls: boolean; ippPathOverride: string | null },
  before: { host: string; port: number; useTls: boolean; ippPath: string; ippPathAuto: boolean } | null,
): Promise<{ ippPath: string; ippPathAuto: boolean; note: string }> {
  if (input.ippPathOverride) return { ippPath: input.ippPathOverride, ippPathAuto: false, note: "" };
  const endpointSame = !!before && before.host === input.host && before.port === input.port && before.useTls === input.useTls;
  if (before && endpointSame && before.ippPathAuto) return { ippPath: before.ippPath, ippPathAuto: true, note: "" };
  const found = await detectOnSave(input);
  if (found) return { ippPath: found.path, ippPathAuto: true, note: `. IPP address detected: ${found.uri} (IPP ${found.version})` };
  return {
    ippPath: before && endpointSame ? before.ippPath : "/ipp/print",
    ippPathAuto: true,
    note: ". The printer did not answer, so the IPP path is not detected yet; run Test when it is online.",
  };
}

export async function savePrinter(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = PrinterInput.safeParse(formObject(fd));
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const id = fd.get("id")?.toString() || null;
  const d = db();
  let sidesWarning = "";
  let ippNote = "";
  try {
    const { ippPathOverride, ...rest } = parsed.data;
    if (id) {
      const [before] = await d.select().from(schema.printers).where(eq(schema.printers.id, id));
      if (!before) return { ok: false, error: "Printer not found" };
      sidesWarning = sidesSupportWarning(rest.defaultSides, before.lastTest?.sidesSupported);
      const ipp = await resolveIppPath({ ...rest, ippPathOverride }, before);
      ippNote = ipp.note;
      const values = { ...rest, ippPath: ipp.ippPath, ippPathAuto: ipp.ippPathAuto };
      const deviceChanged = before.host !== values.host || before.port !== values.port || before.useTls !== values.useTls;
      const endpointChanged = deviceChanged || before.ippPath !== values.ippPath;
      await d
        .update(schema.printers)
        .set({
          ...values,
          updatedAt: new Date(),
          revision: endpointChanged ? before.revision + 1 : before.revision,
          ...(deviceChanged ? NO_IDENTITY : {}),
        })
        .where(eq(schema.printers.id, id));
      await audit(admin.email, "printer.update", "printer", id, { before: pick(before), after: values });
    } else {
      const ipp = await resolveIppPath({ ...rest, ippPathOverride }, null);
      ippNote = ipp.note;
      const values = { ...rest, ippPath: ipp.ippPath, ippPathAuto: ipp.ippPathAuto };
      const [row] = await d.insert(schema.printers).values(values).returning({ id: schema.printers.id });
      await audit(admin.email, "printer.create", "printer", row.id, values);
    }
  } catch (e) {
    if (String((e as Error).message).includes("printers_name_unique") || (e as { code?: string }).code === "23505")
      return { ok: false, error: "A printer with that name already exists" };
    throw e;
  }
  revalidateAll();
  return { ok: true, message: (id ? "Printer updated" : "Printer added") + ippNote + sidesWarning };
}

/** Warns (but saves) when the printer's last IPP test did not list the chosen duplex mode. */
function sidesSupportWarning(sides: string, supported: string[] | undefined): string {
  if (sides === "auto") return "";
  if (!supported) return ". Run Test to check that the printer supports this duplex mode.";
  if (!supported.includes(sides)) return `. Warning: the printer does not advertise ${sides} (sides-supported: ${supported.join(", ") || "none"}).`;
  return "";
}

function pick(p: typeof schema.printers.$inferSelect) {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    ippPath: p.ippPath,
    ippPathAuto: p.ippPathAuto,
    useTls: p.useTls,
    model: p.model,
    location: p.location,
    legacyTakeover: p.legacyTakeover,
    legacyShares: p.legacyShares,
    legacyAliases: p.legacyAliases,
    defaultSides: p.defaultSides,
  };
}

/** Another device may answer at a new endpoint: forget its identity until Test or the poller reads it again. */
const NO_IDENTITY = { deviceUuid: null, macAddresses: [] as string[], identityCheckedAt: null };

const ReplaceInput = z.object({
  id: z.string().uuid(),
  host: PrinterInput.shape.host,
  model: z.string().trim().max(200).optional().transform((v) => v || null),
  port: PrinterInput.shape.port,
  ippPathOverride: PrinterInput.shape.ippPathOverride,
  useTls: PrinterInput.shape.useTls,
});

/** Swap the device behind a logical printer. The queue name stays; agents re-create the queue. */
export async function replacePrinter(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = ReplaceInput.safeParse(formObject(fd));
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const d = db();
  const [before] = await d.select().from(schema.printers).where(eq(schema.printers.id, parsed.data.id));
  if (!before) return { ok: false, error: "Printer not found" };
  const { id, ippPathOverride, ...endpoint } = parsed.data;
  const ipp = await resolveIppPath({ ...endpoint, ippPathOverride }, null);
  const rest = { ...endpoint, ippPath: ipp.ippPath, ippPathAuto: ipp.ippPathAuto };
  await d
    .update(schema.printers)
    .set({ ...rest, revision: before.revision + 1, updatedAt: new Date(), lastTest: null, lastTestAt: null, ...NO_IDENTITY })
    .where(eq(schema.printers.id, id));
  await d.delete(schema.printerStatus).where(eq(schema.printerStatus.printerId, id));
  await audit(admin.email, "printer.replace", "printer", id, { before: pick(before), after: rest, revision: before.revision + 1 });
  revalidateAll();
  return { ok: true, message: `${before.name} now points at ${rest.host}${ipp.note}. PCs update at their next sync.` };
}

export async function deletePrinter(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const d = db();
  const [before] = await d.select().from(schema.printers).where(eq(schema.printers.id, id));
  if (!before) return { ok: false, error: "Printer not found" };
  await d.delete(schema.printers).where(eq(schema.printers.id, id));
  // Remove dangling references held in JSON.
  await d.execute(
    sql`update ou_settings set blocked_printer_ids = blocked_printer_ids - ${id}::text where blocked_printer_ids ? ${id}::text`,
  );
  await audit(admin.email, "printer.delete", "printer", id, pick(before));
  revalidateAll();
  return { ok: true, message: `Deleted ${before.name}` };
}

export interface TestDetection {
  /** true: the path was auto-detected; false: manual override. */
  auto: boolean;
  path: string | null;
  /** IPP request version the device answered ("2.0" or "1.1"). */
  version: string | null;
  /** Auto mode only: the stored path changed (revision bumped; PCs re-create the queue). */
  changed: boolean;
  tried: DetectedPath["tried"];
}

export type TestResult =
  | { ok: true; check: DriverlessCheck; uri: string; detection: TestDetection }
  | { ok: false; error: string; uri: string; detection: TestDetection | null };

/**
 * IPP Get-Printer-Attributes: confirms the device is reachable and driverless-capable. In auto mode the IPP path is
 * detected (/ipp/print, /ipp, /ipp/printer, /printers/lp1, /; IPP 2.0 then 1.1) and stored; a manual path is only
 * tested.
 */
export async function testPrinter(id: string): Promise<TestResult> {
  const admin = await requireAdmin();
  const d = db();
  const [p] = await d.select().from(schema.printers).where(eq(schema.printers.id, id));
  if (!p) return { ok: false, error: "Printer not found", uri: "", detection: null };
  let result: TestResult;
  const timeout = Math.max(config().POLL_TIMEOUT_MS, 8000);
  try {
    const found = await detectIppPath(p, TEST_ATTRIBUTES, timeout, getPrinterAttributes, p.ippPathAuto ? undefined : [p.ippPath]);
    const changed = p.ippPathAuto && found.path !== p.ippPath;
    const check = checkDriverless(found.attrs);
    result = { ok: true, check, uri: found.uri, detection: { auto: p.ippPathAuto, path: found.path, version: found.version, changed, tried: found.tried } };
    await d
      .update(schema.printers)
      .set({
        lastTest: { ...check, ippPath: found.path, ippRequestVersion: found.version },
        lastTestAt: new Date(),
        ...(changed ? { ippPath: found.path, revision: p.revision + 1, updatedAt: new Date() } : {}),
      })
      .where(eq(schema.printers.id, id));
    if (changed) await audit(admin.email, "printer.ipp_path_detected", "printer", id, { before: p.ippPath, after: found.path, version: found.version });
    // printer-uuid and MAC addresses go into the manifest for legacy queue matching on PCs.
    await refreshIdentity({ ...p, ippPath: found.path }, { uuid: check.uuid, model: check.model }).catch(() => undefined);
  } catch (e) {
    const tried = e instanceof IppDetectError ? e.tried : [];
    result = {
      ok: false,
      error: (e as Error).message,
      uri: printerUri(p),
      detection: { auto: p.ippPathAuto, path: null, version: null, changed: false, tried },
    };
  }
  await audit(admin.email, "printer.test", "printer", id, { uri: result.uri, ok: result.ok && result.check.ok });
  revalidateAll();
  return result;
}

/* ---------- OU assignments ---------- */

export async function assignPrinter(ouDn: string, printerId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  await db().insert(schema.ouAssignments).values({ ouDn: normalizeDnKeepCase(ouDn), printerId }).onConflictDoNothing();
  await audit(admin.email, "assignment.add", "ou", ouDn, { printerId });
  revalidateAll();
  return { ok: true };
}

export async function unassignPrinter(ouDn: string, printerId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const d = db();
  const rows = await d.select().from(schema.ouAssignments).where(eq(schema.ouAssignments.printerId, printerId));
  for (const r of rows.filter((r) => normalizeDn(r.ouDn) === normalizeDn(ouDn))) {
    await d.delete(schema.ouAssignments).where(and(eq(schema.ouAssignments.ouDn, r.ouDn), eq(schema.ouAssignments.printerId, printerId)));
  }
  await audit(admin.email, "assignment.remove", "ou", ouDn, { printerId });
  revalidateAll();
  return { ok: true };
}

/** DNs are stored as given by AD; matching is done on the normalized form. */
function normalizeDnKeepCase(dn: string) {
  return dn.trim();
}

async function getSettings(ouDn: string) {
  const all = await db().select().from(schema.ouSettings);
  return all.find((s) => normalizeDn(s.ouDn) === normalizeDn(ouDn)) ?? null;
}

async function upsertSettings(
  ouDn: string,
  patch: Partial<Pick<typeof schema.ouSettings.$inferInsert, "blockInheritance" | "blockedPrinterIds" | "defaultPrinterId">>,
) {
  const existing = await getSettings(ouDn);
  if (existing) {
    await db()
      .update(schema.ouSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.ouSettings.ouDn, existing.ouDn));
  } else {
    await db().insert(schema.ouSettings).values({ ouDn: ouDn.trim(), ...patch });
  }
}

export async function setBlockInheritance(ouDn: string, value: boolean): Promise<ActionResult> {
  const admin = await requireAdmin();
  await upsertSettings(ouDn, { blockInheritance: value });
  await audit(admin.email, value ? "ou.block_inheritance" : "ou.allow_inheritance", "ou", ouDn);
  revalidateAll();
  return { ok: true };
}

export async function setPrinterBlocked(ouDn: string, printerId: string, blocked: boolean): Promise<ActionResult> {
  const admin = await requireAdmin();
  const s = await getSettings(ouDn);
  const set = new Set(s?.blockedPrinterIds ?? []);
  if (blocked) set.add(printerId);
  else set.delete(printerId);
  await upsertSettings(ouDn, { blockedPrinterIds: [...set] });
  await audit(admin.email, blocked ? "ou.block_printer" : "ou.unblock_printer", "ou", ouDn, { printerId });
  revalidateAll();
  return { ok: true };
}

export async function setOuDefault(ouDn: string, printerId: string | null): Promise<ActionResult> {
  const admin = await requireAdmin();
  await upsertSettings(ouDn, { defaultPrinterId: printerId });
  await audit(admin.email, "ou.default", "ou", ouDn, { printerId });
  revalidateAll();
  return { ok: true };
}

/* ---------- per-computer overrides ---------- */

const OverrideInput = z.object({
  computerGuid: z.string().min(1),
  printerId: z.string().uuid(),
  action: z.enum(["add", "block"]),
  makeDefault: z.boolean().default(false),
});

export async function addOverride(input: z.input<typeof OverrideInput>): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = OverrideInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const computer = (await directory().listComputers()).find((c) => c.objectGuid === parsed.data.computerGuid.toLowerCase());
  if (!computer) return { ok: false, error: "Computer not found in directory" };
  const values = { ...parsed.data, computerGuid: computer.objectGuid, computerName: computer.name };
  await db()
    .insert(schema.computerOverrides)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.computerOverrides.computerGuid, schema.computerOverrides.printerId],
      set: { action: values.action, makeDefault: values.makeDefault },
    });
  await audit(admin.email, `override.${values.action}`, "computer", computer.objectGuid, {
    computer: computer.name,
    printerId: values.printerId,
    makeDefault: values.makeDefault,
  });
  revalidateAll();
  return { ok: true };
}

export async function removeOverride(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const [row] = await db().delete(schema.computerOverrides).where(eq(schema.computerOverrides.id, id)).returning();
  if (row) await audit(admin.email, "override.remove", "computer", row.computerGuid, { computer: row.computerName, printerId: row.printerId });
  revalidateAll();
  return { ok: true };
}

/* ---------- agents ---------- */

export async function revokeAgent(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const [row] = await db().update(schema.agents).set({ revokedAt: new Date() }).where(eq(schema.agents.id, id)).returning();
  if (row) await audit(admin.email, "agent.revoke", "agent", row.objectGuid, { computer: row.computerName });
  revalidateAll();
  return { ok: true };
}
