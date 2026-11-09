import { NextResponse } from "next/server";
import { AgentAuthError, agentFromToken, authenticateAgent } from "@/lib/agent-auth";
import { signingKey } from "@/lib/keys";
import { deliverCommands, pendingCommandRows } from "@/lib/test-print/service";

/**
 * Agents 0.8+ poll this every AGENT_COMMAND_POLL_MINUTES for pending commands (test prints). Kept cheap: a token lookup
 * and one indexed query; the directory check and signing only happen when there is something to deliver. Commands are
 * signed one by one with the manifest key; agents verify each (signature, computer, expiry, single use, managed queue).
 */
export async function GET(req: Request) {
  try {
    const light = await agentFromToken(req);
    const rows = await pendingCommandRows(light.id);
    if (!rows.length) return NextResponse.json({ commands: [] }, { headers: { "Cache-Control": "no-store" } });
    // Something to hand out: full check (computer account exists and is enabled), like the manifest.
    const { agent } = await authenticateAgent(req);
    const commands = await deliverCommands(agent, rows, signingKey().key);
    return NextResponse.json({ commands }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("commands error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
