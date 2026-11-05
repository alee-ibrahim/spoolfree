import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { db, schema } from "@/lib/db";
import { signingKey } from "@/lib/keys";
import { signManifest } from "@/lib/manifest";
import { manifestForComputer } from "@/lib/service";

export async function GET(req: Request) {
  try {
    const { agent, computer } = await authenticateAgent(req);
    const payload = await manifestForComputer(computer);
    const signed = signManifest(payload, signingKey().key);
    await db().update(schema.agents).set({ lastManifestAt: new Date() }).where(eq(schema.agents.id, agent.id));
    return NextResponse.json(signed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("manifest error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
