import { NextResponse } from "next/server";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { currentAgentBundle } from "@/lib/agent-update";
import { config } from "@/lib/config";

/**
 * The agent self-update bundle (agents 0.4.3+), for enrolled agents only (machine token). The agent checks the bytes
 * against the SHA-256 and the Ed25519 signature in its signed manifest, so this response needs no signature of its
 * own; the headers repeat them for debugging.
 */
export async function GET(req: Request) {
  try {
    await authenticateAgent(req);
    const bundle = config().AGENT_SELF_UPDATE ? currentAgentBundle() : null;
    if (!bundle) return NextResponse.json({ error: "no agent bundle" }, { status: 404 });
    return new Response(new Uint8Array(bundle.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bundle.size),
        "Cache-Control": "no-store",
        "X-Spoolfree-Agent-Version": bundle.version,
        "X-Spoolfree-Bundle-Sha256": bundle.sha256,
        "X-Spoolfree-Bundle-Signature": bundle.signature,
      },
    });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("agent bundle error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
