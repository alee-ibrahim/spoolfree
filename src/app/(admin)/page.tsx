import { eq } from "drizzle-orm";
import { PrinterIcon } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { MarkerBars, StatusBadges } from "@/components/app/printer-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { agentStaleCutoff, config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { lowMarkers, needsAttention } from "@/lib/ipp/interpret";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "Status" };

export default async function StatusPage() {
  await requireAdmin();
  const d = db();
  const rows = await d
    .select({ p: schema.printers, s: schema.printerStatus })
    .from(schema.printers)
    .leftJoin(schema.printerStatus, eq(schema.printerStatus.printerId, schema.printers.id))
    .orderBy(schema.printers.name);
  const agents = await d.select({ lastReportAt: schema.agents.lastReportAt, lastReport: schema.agents.lastReport }).from(schema.agents);
  const staleBefore = agentStaleCutoff();

  const online = rows.filter((r) => r.s?.online).length;
  const offline = rows.filter((r) => r.s && !r.s.online).length;
  const attention = rows.filter((r) => r.s?.online && needsAttention(r.s).length > 0).length;
  const low = rows.filter((r) => r.s && lowMarkers(r.s).length > 0).length;
  const staleAgents = agents.filter((a) => !a.lastReportAt || a.lastReportAt.getTime() < staleBefore).length;

  const stats = [
    { label: "Printers online", value: `${online} / ${rows.length}`, hint: offline ? `${offline} offline` : "All reachable" },
    { label: "Need attention", value: String(attention), hint: "Jams, paper out, doors" },
    { label: "Low supplies", value: String(low), hint: `At or below ${config().LOW_TONER_PERCENT}%` },
    { label: "Agents", value: String(agents.length), hint: staleAgents ? `${staleAgents} not reporting` : "All reporting" },
  ];

  // Problems first, then by name.
  const sorted = [...rows].sort((a, b) => score(b) - score(a) || a.p.name.localeCompare(b.p.name));

  return (
    <>
      <PageHeader title="Status" />
      <div className="flex flex-col gap-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.label}>
              <CardHeader>
                <CardDescription>{s.label}</CardDescription>
                <CardTitle className="text-3xl tabular-nums">{s.value}</CardTitle>
                <CardDescription>{s.hint}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>

        {rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PrinterIcon />
              </EmptyMedia>
              <EmptyTitle>No printers yet</EmptyTitle>
              <EmptyDescription>Add your first IPP printer to start monitoring it.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link href="/printers">Add printer</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Printer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[28%]">Supplies</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="pr-4">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map(({ p, s }) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.location ?? "—"} · {p.host}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadges status={s} />
                    </TableCell>
                    <TableCell>
                      <MarkerBars markers={s?.markers ?? []} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s?.pageCount?.toLocaleString("en-US") ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{s ? timeAgo(s.lastSeen) : "not polled yet"}</TableCell>
                    <TableCell className="pr-4">
                      {s?.source && s.source !== "none" ? <Badge variant="outline">{s.source.toUpperCase()}</Badge> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}

function score(r: { s: typeof schema.printerStatus.$inferSelect | null }) {
  if (!r.s) return 0;
  if (!r.s.online) return 3;
  if (needsAttention(r.s).length) return 2;
  if (lowMarkers(r.s).length) return 1;
  return 0;
}
