import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { dayIn } from "@/lib/analytics/counters";
import { csvCell, parseFilters } from "@/lib/analytics/filters";
import { jobLog } from "@/lib/analytics/queries";
import { config } from "@/lib/config";

/** The job log for the current filters as CSV (admins only). At most EXPORT_MAX rows. */
const EXPORT_MAX = 100_000;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || !session.isAdmin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = config();
  const url = new URL(req.url);
  const f = parseFilters(Object.fromEntries(url.searchParams), dayIn(c.ANALYTICS_TIME_ZONE, new Date()));
  const { rows } = await jobLog(f, { limit: EXPORT_MAX });
  const docs = c.ANALYTICS_COLLECT_DOCUMENT_NAMES;
  const cols = ["printed_at_utc", "user", "computer", "ou", "printer", "managed", "queue", "port_host", "pages", "bytes", ...(docs ? ["document"] : [])];
  const lines = [cols.join(",")];
  for (const j of rows) {
    lines.push(
      [j.printedAt, j.userName, j.computerName, j.ouDn, j.printer, j.printerId ? "yes" : "no", j.queueName, j.portHost, j.pages, j.bytes, ...(docs ? [j.documentName] : [])]
        .map(csvCell)
        .join(","),
    );
  }
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="spoolfree-print-jobs-${f.from}-to-${f.to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
