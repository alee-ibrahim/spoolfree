import { ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { NoMatches } from "@/components/app/no-matches";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { toQuery } from "@/lib/list-filters/params";
import {
  activeRecentJobFilters,
  JOB_STATES,
  parseRecentJobFilters,
  recentJobPrintersQuery,
  recentJobsCountQuery,
  recentJobsQuery,
  stateTone,
  toRecentJob,
  type RecentJob,
} from "@/lib/recent-jobs";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "Recent jobs" };

const PAGE_SIZE = 50;
const when = (iso: string | null) => (iso ? `${iso.replace("T", " ").slice(0, 16)}` : "—");
const SOURCE_LABEL = { pc: "PC", printer: "Printer", test: "Test print" } as const;

function StateBadge({ job }: { job: RecentJob }) {
  return (
    <Badge variant={stateTone(job.state)} title={job.message ?? undefined}>
      {job.state}
    </Badge>
  );
}

export default async function RecentJobsPage({ searchParams }: PageProps<"/jobs">) {
  await requireAdmin();
  const f = parseRecentJobFilters(await searchParams);
  const none = { printer: null, state: null, source: null, q: null };
  const d = db();
  // Everything comes from Spoolfree's own tables (PC job reports, test prints, the poller's printer job lists): opening this page asks no printer anything.
  const [rows, [shownRow], [totalRow], printers] = await Promise.all([
    d.execute<Record<string, unknown>>(recentJobsQuery(f, PAGE_SIZE, (f.page - 1) * PAGE_SIZE)),
    d.execute<Record<string, unknown>>(recentJobsCountQuery(f)),
    d.execute<Record<string, unknown>>(recentJobsCountQuery(none)),
    d.execute<Record<string, unknown>>(recentJobPrintersQuery()),
  ]);
  const jobs = rows.map(toRecentJob);
  const shown = Number(shownRow?.c ?? 0);
  const total = Number(totalRow?.c ?? 0);
  const fields: FilterField[] = [
    { kind: "select", key: "printer", label: "Printer", allLabel: "All printers", searchable: true, options: printers.map((r) => ({ value: String(r.v), label: String(r.label) })) },
    { kind: "select", key: "state", label: "State", allLabel: "Any state", options: JOB_STATES.map((s) => ({ value: s, label: s })) },
    { kind: "toggle", key: "source", label: "Source", options: [{ value: "pc", label: "PCs" }, { value: "printer", label: "Printers" }, { value: "test", label: "Test prints" }] },
  ];
  const filtered = activeRecentJobFilters(f) > 0 || !!f.q;
  const pages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
  const link = (page: number) => `/jobs${toQuery({ q: f.q, printer: f.printer, state: f.state, source: f.source, page: page > 1 ? page : null })}`;
  const { ANALYTICS_ENABLED: analytics, PRINTER_JOBS_POLL: printerJobs } = config();
  const empty = [
    "No jobs recorded yet.",
    analytics && "Agents send the jobs PCs print at each sync.",
    printerJobs && "The status poller reads each printer's completed jobs.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <PageHeader title="Recent jobs" />
      <div className="flex flex-col gap-3 p-4 md:gap-4 md:p-6">
        {(!analytics || !printerJobs) && (
          <Alert>
            <ListChecksIcon />
            <AlertTitle>{!analytics && !printerJobs ? "Only test prints are listed" : !analytics ? "No PC jobs are listed" : "No printer job lists are read"}</AlertTitle>
            <AlertDescription>
              {!analytics &&
                "Jobs printed from PCs, with the PC name, are recorded only when print analytics (ANALYTICS_ENABLED) is on. Read the privacy notes in the docs before you turn it on. "}
              {!printerJobs && "Jobs that did not come from a PC (copies, USB, mobile, direct IP) are read from the printers only when PRINTER_JOBS_POLL is on."}
            </AlertDescription>
          </Alert>
        )}
        {total > 0 && (
          <Suspense>
            <ListFilters fields={fields} searchLabel="Search jobs" searchPlaceholder="User, PC, document or printer" total={total} shown={shown} noun={["job", "jobs"]} />
          </Suspense>
        )}
        {filtered && shown === 0 && <NoMatches what="jobs" clearHref="/jobs" />}
        {/* Phones: one entry per job. */}
        <ItemGroup className="gap-2 md:hidden">
          {total === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
          {jobs.map((j) => (
            <Item key={`${j.source}-${j.id}`} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap">
                  <span className="break-all">{j.printer}</span>
                  <StateBadge job={j} />
                </ItemTitle>
                <ItemDescription className="break-all">
                  {j.name ?? "(document name not collected)"}
                  {j.pages !== null && ` · ${j.pages} ${j.pages === 1 ? "page" : "pages"}`}
                </ItemDescription>
                <ItemDescription className="break-all">
                  {[j.owner, j.computer].filter(Boolean).join(" on ") || "—"} · {SOURCE_LABEL[j.source]}
                </ItemDescription>
                <ItemDescription className="text-xs tabular-nums">{when(j.at)} UTC</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        <Card className={filtered && shown === 0 ? "hidden" : "hidden py-0 md:flex"}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Printer</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>User</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Pages</TableHead>
                <TableHead>Submitted (UTC)</TableHead>
                <TableHead className="pr-4">Completed (UTC)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {total === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="pl-4 text-muted-foreground">
                    {empty}
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((j) => (
                <TableRow key={`${j.source}-${j.id}`}>
                  <TableCell className="max-w-48 truncate pl-4" title={j.printer}>
                    {j.printer}
                  </TableCell>
                  <TableCell className="max-w-64">
                    <div className="truncate" title={j.name ?? undefined}>
                      {j.name ?? <span className="text-muted-foreground">(name not collected)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {SOURCE_LABEL[j.source]}
                      {j.jobRef && ` · ${j.source === "pc" ? "event" : "job"} ${j.jobRef}`}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-48">
                    <div className="truncate">{j.owner ?? "—"}</div>
                    {j.computer && <div className="truncate text-xs text-muted-foreground">{j.computer}</div>}
                  </TableCell>
                  <TableCell>
                    <StateBadge job={j} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{j.pages ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{when(j.submittedAt)}</TableCell>
                  <TableCell className="pr-4 whitespace-nowrap tabular-nums">{when(j.completedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        {pages > 1 && (
          <nav className="flex items-center justify-between gap-2" aria-label="Job pages">
            <Button asChild variant="outline" className={f.page <= 1 ? "pointer-events-none opacity-50" : undefined}>
              <Link href={link(f.page - 1)} aria-disabled={f.page <= 1} scroll={false}>
                Newer
              </Link>
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              Page {Math.min(f.page, pages)} of {pages}
            </span>
            <Button asChild variant="outline" className={f.page >= pages ? "pointer-events-none opacity-50" : undefined}>
              <Link href={link(f.page + 1)} aria-disabled={f.page >= pages} scroll={false}>
                Older
              </Link>
            </Button>
          </nav>
        )}
      </div>
    </>
  );
}
