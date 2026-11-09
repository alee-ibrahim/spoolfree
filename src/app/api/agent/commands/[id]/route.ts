import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { AGENT_RESULT_STATES } from "@/lib/test-print/command";
import { recordAgentResult, TestPrintError } from "@/lib/test-print/service";

const Result = z.object({
  state: z.enum(AGENT_RESULT_STATES),
  jobId: z.number().int().nonnegative().nullable().optional(),
  jobStatus: z.string().max(300).nullable().optional(),
  message: z.string().max(1000).nullable().optional(),
});

/** An agent reports what happened to one of its commands: sent (job spooled), printing, printed, failed, rejected. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { agent } = await authenticateAgent(req);
    const { id } = await ctx.params;
    const parsed = Result.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid result" }, { status: 400 });
    const row = await recordAgentResult(agent, id, parsed.data);
    return NextResponse.json({ ok: true, state: row.state });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof TestPrintError) return NextResponse.json({ error: e.message }, { status: e.code === "not-found" ? 404 : 409 });
    console.error("command result error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
