"use server";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { driverDecision, loadPackagesForMatch } from "@/lib/service";
import { COMMAND_MIN_AGENT_VERSION, versionAtLeast } from "@/lib/test-print/command";
import { directCapability, refreshDirectTestPrint, sendDirectTestPrint, type DirectCapability } from "@/lib/test-print/direct";
import {
  expireTestPrints,
  getTestPrint,
  pcTargetsFor,
  queuePcTestPrint,
  recentTestPrints,
  TestPrintError,
  testPrintView,
  type PcTarget,
  type TestPrintView,
} from "@/lib/test-print/service";

/** Test print (0.8): admin-only server actions behind the Test print dialog (printers and agents pages). */

export interface TestPrintOptions {
  printerId: string;
  printerName: string;
  direct: DirectCapability;
  pcs: PcTarget[];
  /** Fast path poll interval (0 = commands wait for the next sync) and the sync interval, for the delay hint. */
  pollMinutes: number;
  syncMinutes: number;
  ttlMinutes: number;
  minIntervalSeconds: number;
  recent: TestPrintView[];
}

export type StartResult = { ok: true; testPrint: TestPrintView } | { ok: false; error: string };

async function loadPrinter(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [p] = await db().select().from(schema.printers).where(eq(schema.printers.id, id));
  return p ?? null;
}

export async function testPrintOptions(printerId: string): Promise<TestPrintOptions | null> {
  await requireAdmin();
  const p = await loadPrinter(printerId);
  if (!p) return null;
  await expireTestPrints();
  const agents = await db().select().from(schema.agents).orderBy(desc(schema.agents.lastReportAt));
  const c = config();
  return {
    printerId: p.id,
    printerName: p.name,
    direct: directCapability(p),
    pcs: pcTargetsFor(p.name, agents),
    pollMinutes: c.AGENT_COMMAND_POLL_MINUTES,
    syncMinutes: c.AGENT_SYNC_INTERVAL_MINUTES,
    ttlMinutes: c.TEST_PRINT_COMMAND_TTL_MINUTES,
    minIntervalSeconds: c.TEST_PRINT_MIN_INTERVAL_SECONDS,
    recent: (await recentTestPrints({ printerId: p.id })).map(testPrintView),
  };
}

export interface AgentTestPrintOptions {
  agentId: string;
  computerName: string;
  supported: boolean;
  agentVersion: string | null;
  /** Spoolfree printers whose queue this PC reported. */
  printers: { id: string; name: string }[];
  pollMinutes: number;
  syncMinutes: number;
  ttlMinutes: number;
  recent: TestPrintView[];
}

export async function agentTestPrintOptions(agentId: string): Promise<AgentTestPrintOptions | null> {
  await requireAdmin();
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!a) return null;
  await expireTestPrints();
  const applied = new Set((a.lastReport?.applied ?? []).map((n) => n.toLowerCase()));
  const printers = (await db().select({ id: schema.printers.id, name: schema.printers.name }).from(schema.printers).orderBy(schema.printers.name)).filter((p) =>
    applied.has(p.name.toLowerCase()),
  );
  const c = config();
  return {
    agentId: a.id,
    computerName: a.computerName,
    supported: !a.revokedAt && versionAtLeast(a.lastReport?.agentVersion, COMMAND_MIN_AGENT_VERSION),
    agentVersion: a.lastReport?.agentVersion ?? null,
    printers,
    pollMinutes: c.AGENT_COMMAND_POLL_MINUTES,
    syncMinutes: c.AGENT_SYNC_INTERVAL_MINUTES,
    ttlMinutes: c.TEST_PRINT_COMMAND_TTL_MINUTES,
    recent: (await recentTestPrints({ agentId: a.id })).map(testPrintView),
  };
}

const StartInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct"), printerId: z.string().uuid() }),
  z.object({ mode: z.literal("pc"), printerId: z.string().uuid(), agentId: z.string().uuid() }),
]);

/** Starts a test print. Admin only; rate limited per printer; audit-logged (printer.test_print). */
export async function startTestPrint(input: z.input<typeof StartInput>): Promise<StartResult> {
  const admin = await requireAdmin();
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const p = await loadPrinter(parsed.data.printerId);
  if (!p) return { ok: false, error: "Printer not found" };
  try {
    if (parsed.data.mode === "direct") {
      const dec = driverDecision(p, await loadPackagesForMatch());
      const driverMode = `${p.driverMode}${p.driverMode === "auto" ? ` (PCs get ${dec.mode === "vendor" ? `vendor driver ${dec.driverName ?? ""}`.trim() : "driverless IPP"})` : ""}`;
      return { ok: true, testPrint: testPrintView(await sendDirectTestPrint(p, admin.email, driverMode)) };
    }
    const agentId = parsed.data.agentId;
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!agent) return { ok: false, error: "PC not found" };
    return { ok: true, testPrint: testPrintView(await queuePcTestPrint(p, agent, admin.email)) };
  } catch (e) {
    if (e instanceof TestPrintError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Current state of a test print; follows a direct job on the printer (Get-Job-Attributes) and expires old commands. */
export async function testPrintStatus(id: string): Promise<TestPrintView | null> {
  await requireAdmin();
  let row = await getTestPrint(id);
  if (!row) return null;
  if (row.mode === "direct") {
    const p = await loadPrinter(row.printerId);
    if (p) row = await refreshDirectTestPrint(row, p);
  } else if (row.expiresAt && row.expiresAt.getTime() < Date.now() && (row.state === "queued" || row.state === "delivered")) {
    await expireTestPrints();
    row = (await getTestPrint(id)) ?? row;
  }
  return testPrintView(row);
}
