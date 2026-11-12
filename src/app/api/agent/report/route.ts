import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { db, schema } from "@/lib/db";
import { AGENT_DRIVER_STATES, AGENT_UPDATE_STATES, REMOVE_UNMANAGED_MODES, UNMANAGED_ACTIONS, UNMANAGED_CLASSES } from "@/lib/db/schema";
import { learnedUuids, unmanagedAuditEntries } from "@/lib/unmanaged";

const opt = (max: number) => z.string().max(max).nullable().optional();

const list = z.array(z.string().max(512)).max(200).optional();

const Report = z.object({
  agentVersion: z.string().max(32).optional(),
  osVersion: z.string().max(128).optional(),
  manifestSerial: z.string().max(64).optional(),
  applied: list,
  added: list,
  removed: list,
  defaultPrinter: z.string().max(256).nullable().optional(),
  errors: list,
  legacy: z
    .array(
      z.object({
        printer: z.string().max(256),
        queue: z.string().max(512),
        reason: z.string().max(512),
        action: z.enum(["removed", "would-remove", "failed"]),
        scope: z.string().max(300),
        error: z.string().max(1000).optional(),
      }),
    )
    .max(200)
    .optional(),
  sides: z
    .record(z.string().max(256), z.string().max(32))
    .optional()
    .refine((v) => !v || Object.keys(v).length <= 200),
  method: z.string().max(32).optional(),
  update: z
    .object({
      state: z.enum(AGENT_UPDATE_STATES),
      target: z.string().max(32).optional(),
      error: z.string().max(1000).optional(),
      at: z.string().max(40).optional(),
    })
    .optional(),
  durationMs: z.number().int().nonnegative().optional(),
  critical: list,
  fallbacks: z
    .array(z.object({ printer: z.string().max(256), method: z.string().max(32), reason: z.string().max(1000).optional() }))
    .max(200)
    .optional(),
  queues: z
    .array(
      z.object({
        name: z.string().max(256),
        driver: z.string().max(256).nullable().optional(),
        port: z.string().max(512).nullable().optional(),
        method: z.string().max(32).nullable().optional(),
        /** 0.8.1: the package name when this PC uses the per-PC vendor fallback for a driverless printer. */
        vendorFallback: z.string().max(256).nullable().optional(),
        /** 0.9.0: device UUIDs the queue's WSD-monitor port stores (the server learns WSD UUIDs from them). */
        uuids: z.array(z.string().max(64)).max(8).optional(),
      }),
    )
    .max(200)
    .optional(),
  drivers: z
    .array(
      z.object({
        printer: z.string().max(256),
        status: z.enum(AGENT_DRIVER_STATES),
        driverName: z.string().max(256).nullable().optional(),
        message: z.string().max(1000).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
  /** 0.9.0: non-Spoolfree queues on the PC and what "Remove unmanaged printers" did with each. */
  unmanaged: z
    .array(
      z.object({
        queue: z.string().max(512),
        scope: z.string().max(300),
        portKind: z.string().max(32),
        port: opt(512),
        host: opt(256),
        wsdUuid: opt(64),
        ippUuid: opt(64),
        mac: opt(17),
        driver: opt(256),
        class: z.enum(UNMANAGED_CLASSES),
        matchedPrinter: opt(256),
        matchBy: opt(16),
        action: z.enum(UNMANAGED_ACTIONS),
        reason: opt(512),
        error: opt(1000),
      }),
    )
    .max(300)
    .optional(),
  unmanagedPolicy: z
    .object({
      mode: z.enum(REMOVE_UNMANAGED_MODES),
      keepLocal: z.boolean(),
      keep: z.array(z.string().max(200)).max(50),
      blocked: opt(512),
    })
    .optional(),
  commands: z
    .object({
      pollMinutes: z.number().int().min(0).max(1440),
      ran: z.number().int().nonnegative().optional(),
      /** 0.8.1: commands the main sync left to the poll task. */
      deferred: z.number().int().nonnegative().optional(),
      error: z.string().max(1000).nullable().optional(),
    })
    .optional(),
  analytics: z
    .object({
      enabled: z.boolean(),
      logEnabled: z.boolean().nullable().optional(),
      sent: z.number().int().nonnegative().optional(),
      error: z.string().max(1000).nullable().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  try {
    const { agent } = await authenticateAgent(req);
    const parsed = Report.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid report" }, { status: 400 });
    await db()
      .update(schema.agents)
      .set({ lastReport: parsed.data, lastReportAt: new Date() })
      .where(eq(schema.agents.id, agent.id));
    await afterReport(agent, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("report error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * 0.9.0: removals under "Remove unmanaged printers" go to the audit log, and device UUIDs the report proves (the
 * ports of the PC's own Spoolfree queues, legacy queues matched by UUID, MAC or serial) are added to the printers.
 * Best effort: a failure here never fails the report.
 */
async function afterReport(agent: { objectGuid: string; computerName: string }, report: z.output<typeof Report>) {
  try {
    const entries = unmanagedAuditEntries(report);
    if (entries.length) {
      await db()
        .insert(schema.auditLog)
        .values(entries.map((e) => ({ actor: `agent:${agent.computerName}`, action: e.action, entityType: "computer", entityId: agent.objectGuid, details: { computer: agent.computerName, ...e.details } })));
    }
    const hasUuids = (report.queues ?? []).some((q) => q.uuids?.length) || (report.unmanaged ?? []).some((u) => u.matchedPrinter && (u.wsdUuid || u.ippUuid));
    if (!hasUuids) return;
    const printers = await db()
      .select({ id: schema.printers.id, name: schema.printers.name, deviceUuid: schema.printers.deviceUuid, extraUuids: schema.printers.extraUuids })
      .from(schema.printers);
    const learned = learnedUuids(report, printers);
    for (const [name, uuids] of learned) {
      const p = printers.find((x) => x.name.toLowerCase() === name);
      if (!p) continue;
      await db().update(schema.printers).set({ extraUuids: [...p.extraUuids, ...uuids] }).where(eq(schema.printers.id, p.id));
      await db()
        .insert(schema.auditLog)
        .values({ actor: `agent:${agent.computerName}`, action: "printer.uuid_learned", entityType: "printer", entityId: p.id, details: { printer: p.name, uuids } });
    }
  } catch (e) {
    console.error("report post-processing failed", e);
  }
}
