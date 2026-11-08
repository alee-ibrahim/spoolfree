"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { config } from "@/lib/config";
import type { SpeedSample } from "@/lib/db/schema";
import { deleteDriverPackage as deletePackage } from "@/lib/drivers/store";
import { db, schema } from "@/lib/db";
import { directory } from "@/lib/directory";
import { normalizeDn } from "@/lib/dn";
import { aliasList } from "@/lib/aliases";
import { getPrinterAttributes } from "@/lib/ipp/client";
import { detectIppPath, type DetectedPath } from "@/lib/ipp/detect";
import { requireAdmin } from "@/lib/session";
import { audit, loadPolicy } from "@/lib/service";
import { deletePrinterWithReferences, printerSnapshot } from "@/lib/printer-lifecycle";
import { runPrinterTest, type TestResult } from "@/lib/printer-test";
import {
  applyOuChanges,
  auditWith,
  loadPrinterOus,
  NEW_PRINTER_ID,
  planOuChanges,
  PrinterOusField,
  printerReach,
  type OuChangePlan,
  type PrinterOu,
} from "@/lib/printer-ous";
import {
  applyComputerChanges,
  computerSummary,
  loadPrinterComputers,
  planComputerChanges,
  PrinterComputersField,
  type ComputerChangePlan,
} from "@/lib/printer-computers";

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
  /** Absent: a new printer gets DEFAULT_LEGACY_TAKEOVER, an existing one keeps its value. */
  legacyTakeover: z.enum(["off", "dry-run", "on"]).optional(),
  defaultSides: z.enum(["auto", "one-sided", "two-sided-long-edge", "two-sided-short-edge"]).default("auto"),
  legacyShares: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => [...new Set((v ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(80).regex(/^[^\\/]+$/, "Share names only, without \\\\server\\"))),
  legacyAliases: aliasList,
  driverMode: z.enum(["auto", "driverless", "vendor"]).default("auto"),
  driverPackageId: z
    .string()
    .optional()
    .transform((v) => v || null)
    .pipe(z.string().uuid("Choose a driver package").nullable()),
  driverName: z.string().trim().max(200).optional().transform((v) => v || null),
  vendorProtocol: z.enum(["raw9100", "lpr", "ipp"]).default("raw9100"),
  lprQueue: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => v || null)
    .pipe(z.string().regex(/^[\x21-\x7e]+$/, "The LPR queue name must be printable ASCII without spaces").nullable()),
});

function formObject(fd: FormData) {
  return Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
}

function firstError(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Invalid input";
}

function revalidateAll() {
  for (const p of ["/", "/printers", "/drivers", "/assignments", "/preview", "/unassigned", "/agents", "/audit", "/analytics"]) revalidatePath(p);
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
  // OU assignments from the form. Absent field = leave assignments alone (older clients, the CLI).
  const ousRaw = fd.get("ous");
  let desiredOus: PrinterOu[] | null = null;
  if (typeof ousRaw === "string") {
    const ous = PrinterOusField.safeParse(ousRaw);
    if (!ous.success) return { ok: false, error: firstError(ous.error) };
    desiredOus = ous.data;
  }
  // Per-computer "add" overrides from the form. Absent field = leave them alone.
  const pcsRaw = fd.get("computers");
  let desiredPcs: string[] | null = null;
  if (typeof pcsRaw === "string") {
    const pcs = PrinterComputersField.safeParse(pcsRaw);
    if (!pcs.success) return { ok: false, error: firstError(pcs.error) };
    desiredPcs = pcs.data;
  }
  const d = db();
  let sidesWarning = "";
  let ippNote = "";
  let ouNote = "";
  let pcNote = "";
  try {
    const { ippPathOverride, legacyTakeover, ...input } = parsed.data;
    const before = id ? (await d.select().from(schema.printers).where(eq(schema.printers.id, id)))[0] : null;
    if (id && !before) return { ok: false, error: "Printer not found" };
    const rest = {
      ...input,
      legacyTakeover: legacyTakeover ?? before?.legacyTakeover ?? config().DEFAULT_LEGACY_TAKEOVER,
      // The form only shows the share list when the printer already has shares; absent = keep them.
      legacyShares: fd.has("legacyShares") ? input.legacyShares : (before?.legacyShares ?? []),
    };
    if (desiredOus) {
      const current = id ? await loadPrinterOus(d, id) : { assigned: [], defaults: [] };
      const unknown = await unknownOus(planOuChanges(current.assigned, current.defaults, desiredOus).added);
      if (unknown) return { ok: false, error: unknown };
    }
    let pcNames = new Map<string, string>();
    if (desiredPcs) {
      const plan = planComputerChanges(id ? await loadPrinterComputers(d, id) : [], desiredPcs);
      const checked = await checkComputers(plan);
      if ("error" in checked) return { ok: false, error: checked.error };
      pcNames = checked.names;
    }
    if (before) sidesWarning = sidesSupportWarning(rest.defaultSides, before.lastTest?.sidesSupported);
    const driverError = await checkVendorDriver(rest);
    if (driverError) return { ok: false, error: driverError };
    if (rest.driverMode !== "vendor") {
      // The package and driver only apply to vendor mode; auto mode matches its own.
      rest.driverPackageId = null;
      rest.driverName = null;
    }
    // IPP detection talks to the device, so it runs before the transaction opens.
    const ipp = await resolveIppPath({ ...rest, ippPathOverride }, before ?? null);
    ippNote = ipp.note;
    const values = { ...rest, ippPath: ipp.ippPath, ippPathAuto: ipp.ippPathAuto };

    await d.transaction(async (tx) => {
      let printerId: string;
      if (before) {
        printerId = before.id;
        const deviceChanged = before.host !== values.host || before.port !== values.port || before.useTls !== values.useTls;
        const endpointChanged = deviceChanged || before.ippPath !== values.ippPath;
        await tx
          .update(schema.printers)
          .set({
            ...values,
            updatedAt: new Date(),
            revision: endpointChanged ? before.revision + 1 : before.revision,
            ...(deviceChanged ? NO_IDENTITY : {}),
            // A new driver mode (or a new device) starts auto mode's decision over.
            ...(deviceChanged || before.driverMode !== values.driverMode ? NO_AUTO_DECISION : {}),
          })
          .where(eq(schema.printers.id, printerId));
        await auditWith(tx, admin.email, "printer.update", "printer", printerId, { before: pick(before), after: values });
      } else {
        const [row] = await tx.insert(schema.printers).values(values).returning({ id: schema.printers.id });
        printerId = row.id;
        await auditWith(tx, admin.email, "printer.create", "printer", printerId, values);
      }
      if (desiredOus) {
        const current = await loadPrinterOus(tx, printerId);
        const plan = planOuChanges(current.assigned, current.defaults, desiredOus);
        await applyOuChanges(tx, admin.email, { id: printerId, name: values.name }, plan);
        ouNote = ouSummary(plan);
      }
      if (desiredPcs) {
        const plan = planComputerChanges(await loadPrinterComputers(tx, printerId), desiredPcs);
        await applyComputerChanges(tx, admin.email, { id: printerId, name: values.name }, plan, pcNames);
        pcNote = computerSummary(plan);
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "A printer with that name already exists" };
    throw e;
  }
  revalidateAll();
  const changes = [ouNote.replace(/^\. /, ""), pcNote].filter(Boolean).join(", ");
  return { ok: true, message: (id ? "Printer updated" : "Printer added") + (changes ? `. ${changes}` : "") + ippNote + sidesWarning };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  return (
    String(err.message).includes("printers_name_unique") ||
    err.code === "23505" ||
    err.cause?.code === "23505" ||
    String(err.cause?.message).includes("printers_name_unique")
  );
}

/** Error text when an OU to add is not in the directory, else null. */
async function unknownOus(added: string[]): Promise<string | null> {
  if (!added.length) return null;
  let containers;
  try {
    containers = await directory().listContainers();
  } catch (e) {
    return `Cannot check the OUs against the directory: ${(e as Error).message}`;
  }
  const known = new Set(containers.map((c) => normalizeDn(c.dn)));
  const missing = added.filter((dn) => !known.has(normalizeDn(dn)));
  return missing.length ? `Not in the directory: ${missing.join("; ")}` : null;
}

/** Names of the computers to add, or an error when one is not in the directory or blocks this printer. */
async function checkComputers(plan: ComputerChangePlan): Promise<{ names: Map<string, string> } | { error: string }> {
  if (plan.blocked.length) {
    return { error: `Blocked for this printer on ${plan.blocked.map((b) => b.computerName).join(", ")}; remove the block on Preview first` };
  }
  if (!plan.added.length) return { names: new Map() };
  let computers;
  try {
    computers = await directory().listComputers();
  } catch (e) {
    return { error: `Cannot check the computers against the directory: ${(e as Error).message}` };
  }
  const byGuid = new Map(computers.map((c) => [c.objectGuid.toLowerCase(), c.name]));
  const missing = plan.added.filter((g) => !byGuid.has(g));
  if (missing.length) return { error: `Computer not in the directory: ${missing.join(", ")}` };
  return { names: new Map(plan.added.map((g) => [g, byGuid.get(g)!])) };
}

function ouSummary(p: OuChangePlan): string {
  const parts = [
    p.added.length ? `${p.added.length} OU${p.added.length === 1 ? "" : "s"} added` : "",
    p.removed.length ? `${p.removed.length} removed` : "",
    p.defaultSet.length || p.defaultCleared.length ? "defaults updated" : "",
  ].filter(Boolean);
  return parts.length ? `. ${parts.join(", ")}` : "";
}

/** Live "will reach N computers" hint for the OU picker in the printer form. */
export async function previewPrinterReach(
  printerId: string | null,
  ous: string[],
  pcs?: string[],
): Promise<{ ok: true; computers: number } | { ok: false; error: string }> {
  await requireAdmin();
  const list = z.array(z.string().max(2000)).max(5000).safeParse(ous);
  if (!list.success) return { ok: false, error: "Invalid OU list" };
  const pcList = z.array(z.string().max(64)).max(5000).optional().safeParse(pcs);
  if (!pcList.success) return { ok: false, error: "Invalid computer list" };
  try {
    const [policy, computers] = await Promise.all([loadPolicy(), directory().listComputers()]);
    const id = printerId && z.string().uuid().safeParse(printerId).success ? printerId : NEW_PRINTER_ID;
    return { ok: true, computers: printerReach(policy, computers, id, list.data, pcList.data?.map((g) => g.toLowerCase())).computers };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Vendor mode needs an existing package and one of its driver names. Error text, or null. */
async function checkVendorDriver(v: { driverMode: string; driverPackageId: string | null; driverName: string | null }): Promise<string | null> {
  if (v.driverMode !== "vendor") return null;
  if (!v.driverPackageId) return "Vendor driver mode needs a driver package (upload one on the Drivers page)";
  const [pkg] = await db().select().from(schema.driverPackages).where(eq(schema.driverPackages.id, v.driverPackageId));
  if (!pkg) return "Driver package not found";
  if (!v.driverName) return "Choose the driver to use from the package";
  if (!pkg.infs.some((i) => i.models.some((m) => m.name === v.driverName))) return `"${v.driverName}" is not a driver in ${pkg.name}`;
  return null;
}

/** Warns (but saves) when the printer's last IPP test did not list the chosen duplex mode. */
function sidesSupportWarning(sides: string, supported: string[] | undefined): string {
  if (sides === "auto") return "";
  if (!supported) return ". Run Test to check that the printer supports this duplex mode.";
  if (!supported.includes(sides)) return `. Warning: the printer does not advertise ${sides} (sides-supported: ${supported.join(", ") || "none"}).`;
  return "";
}

const pick = printerSnapshot;

/** Another device may answer at a new endpoint: forget its identity until Test or the poller reads it again. */
const NO_IDENTITY = { deviceUuid: null, macAddresses: [] as string[], identityCheckedAt: null, deviceId: null };

/** Auto driver mode starts over: no sticky vendor decision, no speed samples. */
const NO_AUTO_DECISION = { autoVendorReason: null, autoVendorAt: null, speedSamples: [] as SpeedSample[], speedCheckedAt: null };

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
    .set({ ...rest, revision: before.revision + 1, updatedAt: new Date(), lastTest: null, lastTestAt: null, ...NO_IDENTITY, ...NO_AUTO_DECISION })
    .where(eq(schema.printers.id, id));
  await d.delete(schema.printerStatus).where(eq(schema.printerStatus.printerId, id));
  await audit(admin.email, "printer.replace", "printer", id, { before: pick(before), after: rest, revision: before.revision + 1 });
  revalidateAll();
  return { ok: true, message: `${before.name} now points at ${rest.host}${ipp.note}. PCs update at their next sync.` };
}

export async function deletePrinter(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const removed = await deletePrinterWithReferences(db(), admin.email, id);
  if (!removed) return { ok: false, error: "Printer not found" };
  revalidateAll();
  return { ok: true, message: `Deleted ${removed.printer.name}` };
}

export type { TestDetection, TestResult } from "@/lib/printer-test";

/**
 * IPP Get-Printer-Attributes: confirms the device is reachable and driverless-capable. In auto mode the IPP path is
 * detected (/ipp/print, /ipp, /ipp/printer, /printers/lp1, /; IPP 2.0 then 1.1) and stored; a manual path is only
 * tested. Also reads what auto driver mode needs (printer-device-id, compression-supported).
 */
export async function testPrinter(id: string): Promise<TestResult> {
  const admin = await requireAdmin();
  const [p] = await db().select().from(schema.printers).where(eq(schema.printers.id, id));
  if (!p) return { ok: false, error: "Printer not found", uri: "", detection: null };
  const result = await runPrinterTest(admin.email, p);
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

/* ---------- driver packages ---------- */

export async function deleteDriverPackage(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Driver package not found" };
  const r = await deletePackage(db(), admin.email, id);
  if (!r.ok) return r;
  revalidateAll();
  return { ok: true, message: `Deleted ${r.name}` };
}

/** Clears auto mode's sticky vendor decision so it is evaluated again. */
export async function resetDriverDecision(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const [p] = await db().select().from(schema.printers).where(eq(schema.printers.id, id));
  if (!p) return { ok: false, error: "Printer not found" };
  await db().update(schema.printers).set(NO_AUTO_DECISION).where(eq(schema.printers.id, id));
  await audit(admin.email, "printer.driver_auto_reset", "printer", id, { previous: p.autoVendorReason });
  revalidateAll();
  return { ok: true, message: `${p.name}: auto mode decides again (run Test to re-read the device)` };
}

/* ---------- agents ---------- */

export async function revokeAgent(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  const [row] = await db().update(schema.agents).set({ revokedAt: new Date() }).where(eq(schema.agents.id, id)).returning();
  if (row) await audit(admin.email, "agent.revoke", "agent", row.objectGuid, { computer: row.computerName });
  revalidateAll();
  return { ok: true };
}
