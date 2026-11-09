import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { db, schema } from "@/lib/db";
import { AGENT_UPDATE_STATES } from "@/lib/db/schema";

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
      }),
    )
    .max(200)
    .optional(),
  drivers: z
    .array(
      z.object({
        printer: z.string().max(256),
        status: z.enum(["installed", "present", "wpp-blocked", "failed", "fallback"]),
        driverName: z.string().max(256).nullable().optional(),
        message: z.string().max(1000).nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
  commands: z
    .object({
      pollMinutes: z.number().int().min(0).max(1440),
      ran: z.number().int().nonnegative().optional(),
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
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("report error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
