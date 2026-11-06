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
