import { NextResponse } from "next/server";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { JobsBatch, toJobRows } from "@/lib/analytics/ingest";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";

/**
 * Print analytics (agents 0.5+): a batch of PrintService event 307 records from one PC. Duplicates (same PC, event
 * record id and time) are ignored, so agents may resend a batch. 404 when ANALYTICS_ENABLED is off.
 */
export async function POST(req: Request) {
  try {
    const { agent, computer } = await authenticateAgent(req);
    const c = config();
    if (!c.ANALYTICS_ENABLED) return NextResponse.json({ error: "analytics disabled" }, { status: 404 });
    const parsed = JobsBatch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid batch", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
    }
    const printers = await db().select({ id: schema.printers.id, name: schema.printers.name }).from(schema.printers);
    const rows = toJobRows(parsed.data.events, {
      agentId: agent.id,
      computer: { objectGuid: computer.objectGuid, name: computer.name, dn: computer.dn },
      printers,
      collectDocumentNames: c.ANALYTICS_COLLECT_DOCUMENT_NAMES,
    });
    const inserted = rows.length
      ? await db().insert(schema.printJobs).values(rows).onConflictDoNothing().returning({ id: schema.printJobs.id })
      : [];
    return NextResponse.json({ ok: true, accepted: inserted.length, duplicates: rows.length - inserted.length });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("jobs error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
