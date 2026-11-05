import { eq } from "drizzle-orm";
import { checkEnrollmentToken } from "@/lib/agent-auth";
import { agentStaleCutoff, config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { renderMetrics } from "@/lib/metrics";

export async function GET(req: Request) {
  const token = config().METRICS_TOKEN;
  if (token) {
    const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!checkEnrollmentToken(presented, token)) return new Response("unauthorized\n", { status: 401 });
  }
  const d = db();
  const rows = await d
    .select({ p: schema.printers, s: schema.printerStatus })
    .from(schema.printers)
    .leftJoin(schema.printerStatus, eq(schema.printerStatus.printerId, schema.printers.id));
  const agents = await d.select({ lastReportAt: schema.agents.lastReportAt, lastReport: schema.agents.lastReport }).from(schema.agents);
  const staleBefore = agentStaleCutoff();
  const body = renderMetrics({
    printers: rows.map(({ p, s }) => ({
      name: p.name,
      host: p.host,
      location: p.location,
      online: s?.online ?? null,
      markers: s?.markers ?? [],
      pageCount: s?.pageCount ?? null,
      lastSeen: s?.lastSeen ?? null,
    })),
    agents: {
      total: agents.length,
      stale: agents.filter((a) => !a.lastReportAt || a.lastReportAt.getTime() < staleBefore).length,
      withErrors: agents.filter((a) => (a.lastReport?.errors?.length ?? 0) > 0).length,
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; version=0.0.4" } });
}
