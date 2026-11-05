import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { db, schema } from "@/lib/db";

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
  method: z.string().max(32).optional(),
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
