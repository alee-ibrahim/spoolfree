import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import { TEST_PRINT_FINAL, type Agent, type Printer, type TestPrint, type TestPrintEvent, type TestPrintMode, type TestPrintState } from "../db/schema";
import { canTransition, COMMAND_KIND, type AgentResultState, COMMAND_MIN_AGENT_VERSION, signCommand, versionAtLeast, type CommandPayload, type SignedCommand } from "./command";
import type { KeyObject } from "node:crypto";

/**
 * Test print lifecycle in the database (both modes): rate limit, state changes with a timeline, audit rows, and the
 * signed commands agents fetch for mode "pc".
 */

export class TestPrintError extends Error {
  constructor(
    message: string,
    public code: "rate-limited" | "not-allowed" | "not-found" = "not-allowed",
  ) {
    super(message);
  }
}

async function audit(actor: string, action: string, entityId: string, details: Record<string, unknown>) {
  await db().insert(schema.auditLog).values({ actor, action, entityType: "printer", entityId, details });
}

/**
 * Creates a test print row, at most one per printer per TEST_PRINT_MIN_INTERVAL_SECONDS (both modes count). The
 * printer row is locked so two admins clicking at once cannot both pass the check. Writes a "printer.test_print" audit row.
 */
export async function reserveTestPrint(args: {
  printer: Printer;
  mode: TestPrintMode;
  actor: string;
  agent?: Agent | null;
  now?: Date;
}): Promise<TestPrint> {
  const now = args.now ?? new Date();
  const c = config();
  const minGap = c.TEST_PRINT_MIN_INTERVAL_SECONDS * 1000;
  const row = await db().transaction(async (tx) => {
    const [locked] = await tx.select({ id: schema.printers.id }).from(schema.printers).where(eq(schema.printers.id, args.printer.id)).for("update");
    if (!locked) throw new TestPrintError("printer not found", "not-found");
    if (minGap > 0) {
      const [last] = await tx
        .select({ createdAt: schema.testPrints.createdAt })
        .from(schema.testPrints)
        .where(and(eq(schema.testPrints.printerId, args.printer.id), gt(schema.testPrints.createdAt, new Date(now.getTime() - minGap))))
        .orderBy(desc(schema.testPrints.createdAt))
        .limit(1);
      if (last) {
        const wait = Math.max(1, Math.ceil((last.createdAt.getTime() + minGap - now.getTime()) / 1000));
        throw new TestPrintError(`A test print was sent to this printer moments ago. Try again in ${wait} s.`, "rate-limited");
      }
    }
    const [r] = await tx
      .insert(schema.testPrints)
      .values({
        printerId: args.printer.id,
        printerName: args.printer.name,
        mode: args.mode,
        agentId: args.agent?.id ?? null,
        computerName: args.agent?.computerName ?? null,
        computerGuid: args.agent?.objectGuid ?? null,
        requestedBy: args.actor,
        // Both modes start as "queued"; a direct print is sent within the same request.
        state: "queued",
        events: [{ state: "queued", at: now.toISOString() }],
        createdAt: now,
        expiresAt: args.mode === "pc" ? new Date(now.getTime() + c.TEST_PRINT_COMMAND_TTL_MINUTES * 60_000) : null,
      })
      .returning();
    return r;
  });
  await audit(args.actor, "printer.test_print", args.printer.id, {
    testPrintId: row.id,
    mode: args.mode,
    printer: args.printer.name,
    computer: args.agent?.computerName ?? null,
    queue: args.mode === "pc" ? args.printer.name : null,
  });
  return row;
}

/**
 * Moves a test print to a new state (forward only, see canTransition) and appends it to the timeline. A final state
 * writes a "printer.test_print_result" audit row. Returns the updated row, or the unchanged row when not allowed.
 */
export async function transitionTestPrint(
  row: TestPrint,
  to: TestPrintState,
  patch: Partial<Pick<TestPrint, "format" | "jobId" | "jobUri" | "jobStatus" | "error" | "deliveredAt">> & { message?: string | null } = {},
  actor = "system",
  now = new Date(),
): Promise<TestPrint> {
  if (!canTransition(row.state, to, !!row.deliveredAt)) return row;
  const { message, ...cols } = patch;
  const event: TestPrintEvent = { state: to, at: now.toISOString(), ...(message ? { message: message.slice(0, 500) } : {}) };
  const final = TEST_PRINT_FINAL.includes(to);
  const [r] = await db()
    .update(schema.testPrints)
    .set({
      ...cols,
      state: to,
      events: sql`${schema.testPrints.events} || ${JSON.stringify([event])}::jsonb`,
      ...(final ? { completedAt: now } : {}),
    })
    .where(and(eq(schema.testPrints.id, row.id), eq(schema.testPrints.state, row.state)))
    .returning();
  if (!r) return (await getTestPrint(row.id)) ?? row;
  if (final) {
    await audit(actor, "printer.test_print_result", row.printerId, {
      testPrintId: row.id,
      mode: row.mode,
      state: to,
      printer: row.printerName,
      computer: row.computerName,
      jobId: r.jobId,
      jobStatus: r.jobStatus,
      error: r.error,
    });
  }
  return r;
}

export async function getTestPrint(id: string): Promise<TestPrint | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db().select().from(schema.testPrints).where(eq(schema.testPrints.id, id)).limit(1);
  return r ?? null;
}

/** Commands no agent picked up (or ran) before they expired end as "expired". */
export async function expireTestPrints(now = new Date()): Promise<number> {
  const stale = await db()
    .select()
    .from(schema.testPrints)
    .where(and(inArray(schema.testPrints.state, ["queued", "delivered"]), lt(schema.testPrints.expiresAt, now)));
  for (const r of stale) {
    await transitionTestPrint(r, "expired", { message: r.deliveredAt ? "the agent fetched the command but sent no result in time" : "no agent picked the command up in time" }, "system", now);
  }
  return stale.length;
}

// --- Mode "pc": which PCs, commands, results -------------------------------------------------------------------

export interface PcTarget {
  agentId: string;
  computerName: string;
  lastReportAt: string | null;
  agentVersion: string | null;
  /** false: the agent is older than 0.8.0 and cannot run commands. */
  supported: boolean;
}

/** PCs whose last agent report lists this printer's queue (newest check-in first). */
export function pcTargetsFor(printerName: string, agents: Agent[]): PcTarget[] {
  const key = printerName.toLowerCase();
  return agents
    .filter((a) => !a.revokedAt && (a.lastReport?.applied ?? []).some((n) => n.toLowerCase() === key))
    .sort((a, b) => (b.lastReportAt?.getTime() ?? 0) - (a.lastReportAt?.getTime() ?? 0))
    .map((a) => ({
      agentId: a.id,
      computerName: a.computerName,
      lastReportAt: a.lastReportAt?.toISOString() ?? null,
      agentVersion: a.lastReport?.agentVersion ?? null,
      supported: versionAtLeast(a.lastReport?.agentVersion, COMMAND_MIN_AGENT_VERSION),
    }));
}

/** Queues a test print command for one PC. Throws TestPrintError when the PC does not have the printer or is too old. */
export async function queuePcTestPrint(printer: Printer, agent: Agent, actor: string, now = new Date()): Promise<TestPrint> {
  if (agent.revokedAt) throw new TestPrintError(`${agent.computerName}'s agent token is revoked.`);
  const [t] = pcTargetsFor(printer.name, [agent]);
  if (!t) throw new TestPrintError(`${agent.computerName} has not reported a queue for ${printer.name}.`);
  if (!t.supported) throw new TestPrintError(`${agent.computerName} runs agent ${t.agentVersion ?? "unknown"}; test prints need ${COMMAND_MIN_AGENT_VERSION} or later.`);
  return reserveTestPrint({ printer, mode: "pc", actor, agent, now });
}

export function commandPayload(row: TestPrint): CommandPayload {
  return {
    kind: COMMAND_KIND,
    v: 1,
    id: row.id,
    type: "test-print",
    computer: { objectGuid: (row.computerGuid ?? "").toLowerCase(), name: row.computerName ?? "" },
    printer: { id: row.printerId, name: row.printerName },
    issuedAt: row.createdAt.toISOString(),
    expiresAt: (row.expiresAt ?? row.createdAt).toISOString(),
  };
}

/** Commands waiting for this agent (queued, or delivered without a result yet) that have not expired. */
export async function pendingCommandRows(agentId: string, now = new Date()): Promise<TestPrint[]> {
  return db()
    .select()
    .from(schema.testPrints)
    .where(
      and(
        eq(schema.testPrints.agentId, agentId),
        eq(schema.testPrints.mode, "pc"),
        inArray(schema.testPrints.state, ["queued", "delivered"]),
        gt(schema.testPrints.expiresAt, now),
      ),
    )
    .orderBy(schema.testPrints.createdAt)
    .limit(10);
}

/** Signs the pending commands for an agent and marks them delivered. The computer must match the agent's. */
export async function deliverCommands(agent: Agent, rows: TestPrint[], key: KeyObject, now = new Date()): Promise<SignedCommand[]> {
  const out: SignedCommand[] = [];
  for (const r of rows) {
    if ((r.computerGuid ?? "").toLowerCase() !== agent.objectGuid.toLowerCase()) continue;
    out.push(signCommand(commandPayload(r), key));
    if (r.state === "queued") await transitionTestPrint(r, "delivered", { deliveredAt: now }, `agent:${agent.computerName}`, now);
  }
  return out;
}

export interface AgentResult {
  state: AgentResultState;
  jobId?: number | null;
  jobStatus?: string | null;
  message?: string | null;
}

/** An agent's result for one of its commands. Results for other agents' commands are refused (not found). */
export async function recordAgentResult(agent: Agent, id: string, result: AgentResult, now = new Date()): Promise<TestPrint> {
  const row = await getTestPrint(id);
  if (!row || row.agentId !== agent.id || row.mode !== "pc") throw new TestPrintError("unknown command", "not-found");
  let r = row;
  // A result can skip states (an agent that printed at once reports "printed"); "delivered" is implied.
  if (r.state === "queued") r = await transitionTestPrint(r, "delivered", { deliveredAt: now }, `agent:${agent.computerName}`, now);
  const failed = result.state === "failed" || result.state === "rejected";
  return transitionTestPrint(
    r,
    result.state,
    {
      jobId: result.jobId ?? r.jobId,
      jobStatus: result.jobStatus ?? r.jobStatus,
      ...(failed ? { error: result.message ?? result.jobStatus ?? "failed" } : {}),
      message: result.message ?? result.jobStatus ?? null,
    },
    `agent:${agent.computerName}`,
    now,
  );
}

// --- Views ---------------------------------------------------------------------------------------------------------

export interface TestPrintView {
  id: string;
  printerId: string;
  printerName: string;
  mode: TestPrintMode;
  computerName: string | null;
  requestedBy: string;
  state: TestPrintState;
  final: boolean;
  events: TestPrintEvent[];
  createdAt: string;
  expiresAt: string | null;
  format: string | null;
  jobId: number | null;
  jobStatus: string | null;
  error: string | null;
}

export function testPrintView(r: TestPrint): TestPrintView {
  return {
    id: r.id,
    printerId: r.printerId,
    printerName: r.printerName,
    mode: r.mode,
    computerName: r.computerName,
    requestedBy: r.requestedBy,
    state: r.state,
    final: TEST_PRINT_FINAL.includes(r.state),
    events: r.events,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    format: r.format,
    jobId: r.jobId,
    jobStatus: r.jobStatus,
    error: r.error,
  };
}

export async function recentTestPrints(where: { printerId?: string; agentId?: string }, limit = 5): Promise<TestPrint[]> {
  const cond = where.printerId ? eq(schema.testPrints.printerId, where.printerId) : eq(schema.testPrints.agentId, where.agentId!);
  return db().select().from(schema.testPrints).where(cond).orderBy(desc(schema.testPrints.createdAt)).limit(limit);
}
