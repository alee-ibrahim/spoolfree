import { ChartColumnIcon, DownloadIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayIn } from "@/lib/analytics/counters";
import { filterParams, parseFilters } from "@/lib/analytics/filters";
import { counterComparison, filterOptions, jobLog, pagesByDay, summary, top, unmanagedQueues, type Ranked } from "@/lib/analytics/queries";
import { config } from "@/lib/config";
import { shortDn } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { CounterVsPcs, PagesOverTime, RankingBars } from "./analytics-charts";
import { ListFilters, type FilterField } from "@/components/app/list-filters";

export const metadata = { title: "Analytics" };

const PAGE_SIZE = 25;
const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export default async function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  await requireAdmin();
  const c = config();
  const tz = c.ANALYTICS_TIME_ZONE;
  const today = dayIn(tz, new Date());
  const sp = await searchParams;
  const f = parseFilters(sp, today);
  const page = Math.max(1, Number.parseInt(String(sp.page ?? "1"), 10) || 1);

  const [sum, byDay, users, computers, printers, ous, counters, unmanaged, log, options] = await Promise.all([
    summary(f),
    pagesByDay(f),
    top(f, "user"),
    top(f, "computer"),
    top(f, "printer"),
    top(f, "ou"),
    counterComparison(f),
    unmanagedQueues(f),
    jobLog(f, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    filterOptions(f),
  ]);
  // Jobs in the date range before the other filters, for "N of M jobs".
  const anyFilter = !!(f.user || f.printer || f.ou || f.computer || f.q);
  const rangeTotal = anyFilter ? (await jobLog({ ...f, user: null, printer: null, ou: null, computer: null, q: null }, { limit: 0 })).total : log.total;
  const fields: FilterField[] = [
    { kind: "dates", label: "Date range", fromKey: "from", toKey: "to", today, required: true, from: f.from, to: f.to },
    { kind: "select", key: "user", label: "User", allLabel: "All users", searchable: true, options: options.users.map((u) => ({ value: u, label: u })) },
    { kind: "select", key: "printer", label: "Printer", allLabel: "All printers", searchable: true, options: options.printers },
    { kind: "select", key: "ou", label: "OU", allLabel: "All OUs", searchable: true, options: options.ous.map((o) => ({ value: o, label: shortDn(o) || o })) },
    { kind: "select", key: "computer", label: "PC", allLabel: "All PCs", searchable: true, options: options.computers.map((c) => ({ value: c, label: c })) },
  ];
  const showDocs = c.ANALYTICS_COLLECT_DOCUMENT_NAMES;
  const link = (extra: Record<string, string | null>) => `/analytics?${filterParams(f, extra)}`;
  const kpis = [
    { label: "Print jobs", value: sum.jobs },
    { label: "Pages from PCs", value: sum.pages },
    { label: "Active users", value: sum.users },
    { label: "Printers used", value: sum.printers },
  ];
  const pages = Math.max(1, Math.ceil(log.total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Analytics"
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/analytics/export?${filterParams(f)}`} download>
              <DownloadIcon data-icon="inline-start" aria-hidden />
              CSV
            </a>
          </Button>
        }
      />
      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        {!c.ANALYTICS_ENABLED && (
          <Alert>
            <ChartColumnIcon />
            <AlertTitle>Print analytics is off</AlertTitle>
            <AlertDescription>
              Agents collect print jobs only when ANALYTICS_ENABLED is on. Printer page counters are recorded either way. Read the privacy notes
              in the docs before you turn it on.
            </AlertDescription>
          </Alert>
        )}

        <Suspense>
          <ListFilters
            fields={fields}
            searchLabel="Search print jobs"
            searchPlaceholder={showDocs ? "User or document name" : "User name"}
            total={rangeTotal}
            shown={log.total}
            noun={["job", "jobs"]}
            keep={["from", "to"]}
          />
        </Suspense>

        <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
          {kpis.map((k) => (
            <Card key={k.label} className="gap-1 py-4 md:py-6">
              <CardHeader className="px-4 md:px-6">
                <CardDescription>{k.label}</CardDescription>
                <CardTitle className="text-2xl font-semibold md:text-3xl" title={nf.format(k.value)}>
                  {k.value >= 100_000 ? compact.format(k.value) : nf.format(k.value)}
                </CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        {sum.jobs === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChartColumnIcon />
              </EmptyMedia>
              <EmptyTitle>No print jobs in this range</EmptyTitle>
              <EmptyDescription>
                {c.ANALYTICS_ENABLED
                  ? "Agents send the jobs PCs print at each sync. Widen the date range or clear the filters."
                  : "Turn on ANALYTICS_ENABLED to collect print jobs from PCs."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Pages over time</CardTitle>
                <CardDescription>Pages printed from PCs per day ({tz}).</CardDescription>
              </CardHeader>
              <CardContent>
                <PagesOverTime data={byDay} />
              </CardContent>
            </Card>

            <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
              <RankCard title="Top users" rows={users} filter={(k) => link({ user: k })} />
              <RankCard title="Top PCs" rows={computers} filter={(k) => link({ computer: k })} />
              <RankCard title="Top printers" rows={printers} filter={(k) => link({ printer: k })} />
              <RankCard
                title="Pages by OU (department)"
                rows={ous.map((o) => ({ ...o, label: leafOu(o.label) }))}
                filter={(k) => (k ? link({ ou: k }) : null)}
              />
            </div>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Printer counters and PC jobs</CardTitle>
            <CardDescription>
              Pages each printer&apos;s own counter advanced, split into pages PCs reported and the rest (copies, direct, USB and mobile
              printing). Counters are read by the status poller.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {counters.some((r) => r.counterPages !== null) && (
              <CounterVsPcs
                data={counters
                  .filter((r) => r.counterPages !== null)
                  .map((r) => ({ name: r.name, pcPages: Math.min(r.pcPages, r.counterPages ?? 0), notFromPcs: r.notFromPcs ?? 0 }))}
              />
            )}
            <CounterTable rows={counters} />
          </CardContent>
        </Card>

        {unmanaged.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Queues Spoolfree does not manage</CardTitle>
              <CardDescription>PCs printed to these hand-installed or legacy queues. The port host shows which device they point at.</CardDescription>
            </CardHeader>
            <CardContent>
              <ItemGroup className="gap-2 md:hidden">
                {unmanaged.map((u) => (
                  <Item key={`${u.queueName}|${u.portHost}`} variant="outline" size="sm">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="break-all">{u.queueName}</ItemTitle>
                      <ItemDescription className="font-mono text-xs break-all">{u.portHost ?? "local / unknown port"}</ItemDescription>
                      <ItemDescription>
                        {nf.format(u.pages)} pages · {u.jobs} jobs · {u.computers} PC{u.computers === 1 ? "" : "s"}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
              <Table className="hidden md:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Queue</TableHead>
                    <TableHead>Port host</TableHead>
                    <TableHead className="text-right">PCs</TableHead>
                    <TableHead className="text-right">Jobs</TableHead>
                    <TableHead className="text-right">Pages</TableHead>
                    <TableHead>Last printed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unmanaged.map((u) => (
                    <TableRow key={`${u.queueName}|${u.portHost}`}>
                      <TableCell className="font-medium">
                        <Link className="underline-offset-4 hover:underline" href={link({ printer: `queue:${u.queueName}` })}>
                          {u.queueName}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{u.portHost ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.computers}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf.format(u.jobs)}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf.format(u.pages)}</TableCell>
                      <TableCell className="text-muted-foreground">{u.lastPrinted.slice(0, 10)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Job log</CardTitle>
            <CardDescription>
              {nf.format(log.total)} job{log.total === 1 ? "" : "s"} in the range. Newest first. Times in {tz}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ItemGroup className="gap-2 md:hidden">
              {log.rows.map((j) => (
                <Item key={j.id} variant="outline" size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full justify-between">
                      <span className="truncate">{j.userName ?? "(unknown user)"}</span>
                      <span className="shrink-0 tabular-nums">{j.pages ?? "?"} p</span>
                    </ItemTitle>
                    <ItemDescription>
                      {j.printer}
                      {!j.printerId && " (unmanaged)"} · {j.computerName}
                    </ItemDescription>
                    {showDocs && j.documentName && <ItemDescription className="break-all">{j.documentName}</ItemDescription>}
                    <ItemDescription className="text-xs tabular-nums">{localTime(j.printedAt, tz)}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>PC</TableHead>
                  <TableHead>Printer</TableHead>
                  {showDocs && <TableHead>Document</TableHead>}
                  <TableHead className="text-right">Pages</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.rows.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="tabular-nums">{localTime(j.printedAt, tz)}</TableCell>
                    <TableCell>{j.userName ?? "—"}</TableCell>
                    <TableCell>{j.computerName}</TableCell>
                    <TableCell>
                      {j.printer}
                      {!j.printerId && (
                        <Badge variant="outline" className="ml-2">
                          unmanaged
                        </Badge>
                      )}
                    </TableCell>
                    {showDocs && (
                      <TableCell className="max-w-72 truncate" title={j.documentName ?? ""}>
                        {j.documentName ?? "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{j.pages ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pages > 1 && (
              <nav className="flex items-center justify-between gap-2" aria-label="Job log pages">
                <Button asChild variant="outline" size="sm" className={page <= 1 ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={link({ page: String(page - 1) })} aria-disabled={page <= 1} scroll={false}>
                    Newer
                  </Link>
                </Button>
                <span className="text-sm text-muted-foreground tabular-nums">
                  Page {page} of {pages}
                </span>
                <Button asChild variant="outline" size="sm" className={page >= pages ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={link({ page: String(page + 1) })} aria-disabled={page >= pages} scroll={false}>
                    Older
                  </Link>
                </Button>
              </nav>
            )}
          </CardContent>
        </Card>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          Print jobs are kept for {c.ANALYTICS_RETENTION_DAYS} days. Document names are {showDocs ? "collected" : "not collected"}{" "}
          (ANALYTICS_COLLECT_DOCUMENT_NAMES). Tell staff that printing is logged.
        </p>
      </div>
    </>
  );
}

/** The OU's own name (its path is in the table and the filter). */
function leafOu(dn: string) {
  return shortDn(dn).split(" / ").at(-1) || "(no OU)";
}

function localTime(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function RankCard({ title, rows, filter }: { title: string; rows: Ranked[]; filter: (key: string) => string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>By pages, top {rows.length}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data.</p>
        ) : (
          <>
            <RankingBars data={rows} />
            <details className="text-sm">
              <summary className="cursor-pointer py-2 text-muted-foreground">Table</summary>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Jobs</TableHead>
                    <TableHead className="text-right">Pages</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const href = filter(r.key);
                    return (
                      <TableRow key={r.key}>
                        <TableCell className="whitespace-normal">
                          {href ? (
                            <Link className="underline-offset-4 hover:underline" href={href} scroll={false}>
                              {r.label}
                            </Link>
                          ) : (
                            r.label
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(r.jobs)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nf.format(r.pages)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CounterTable({ rows }: { rows: Awaited<ReturnType<typeof counterComparison>> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No counter readings or PC jobs in this range.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Printer</TableHead>
          <TableHead className="text-right">Counter</TableHead>
          <TableHead className="text-right">From PCs</TableHead>
          <TableHead className="text-right">Not from PCs</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.printerId}>
            <TableCell className="whitespace-normal">{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">{r.counterPages === null ? "—" : nf.format(r.counterPages)}</TableCell>
            <TableCell className="text-right tabular-nums">{nf.format(r.pcPages)}</TableCell>
            <TableCell className="text-right tabular-nums">{r.notFromPcs === null ? "—" : nf.format(r.notFromPcs)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

