import { desc, sql } from "drizzle-orm";
import { Suspense } from "react";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { NoMatches } from "@/components/app/no-matches";
import { ServerCogIcon, TriangleAlertIcon } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isAgentOutdated } from "@/lib/agent-bundle";
import { currentAgentBundle } from "@/lib/agent-update";
import { agentStaleCutoff, config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { shortDn, timeAgo } from "@/lib/format";
import { signingKeyInfo } from "@/lib/keys";
import { requireAdmin } from "@/lib/session";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item";
import { activeAgentFilters, agentFacetOptions, agentOuOptions, filterAgents, parseAgentFilters, type AgentFilters } from "@/lib/list-filters/agents";
import { RevokeButton } from "./revoke-button";
import { AgentTestPrintButton } from "@/components/app/test-print-dialog";
import { UnmanagedSummaryToggle } from "@/components/app/unmanaged-queues";
import Link from "next/link";
import { UNMANAGED_CLASSES } from "@/lib/db/schema";
import { UNMANAGED_CLASS_LABELS, unmanagedSummary, type UnmanagedFilter } from "@/lib/unmanaged";

export const metadata = { title: "Agents" };

export default async function AgentsPage({ searchParams }: PageProps<"/agents">) {
  await requireAdmin();
  const f = parseAgentFilters(await searchParams);
  const [all, users] = await Promise.all([db().select().from(schema.agents).orderBy(desc(schema.agents.lastReportAt)), usersByComputer(f)]);
  const staleBefore = agentStaleCutoff();
  const key = signingKeyInfo();
  const publicUrl = config().PUBLIC_URL;
  const bundle = currentAgentBundle();
  const latest = bundle?.version ?? null;
  const selfUpdate = config().AGENT_SELF_UPDATE;
  const agents = all;
  const outdatedCount = agents.filter((a) => !a.revokedAt && isAgentOutdated(a.lastReport?.agentVersion, latest)).length;
  // High severity: PCs that takeover left without a printer (agents 0.4.6+ report it until it is fixed).
  const ctx: AgentCtx = { staleBefore, latest, selfUpdate };
  const critical = agents.filter((a) => !a.revokedAt && (a.lastReport?.critical ?? []).length > 0);
  // Search and filters run on the server (hundreds of PCs); only the matching rows are sent.
  const shown = filterAgents(all, f, { staleBefore, latest }, users);
  const facets = agentFacetOptions(all);
  const fields: FilterField[] = [
    {
      kind: "select",
      key: "state",
      label: "State",
      allLabel: "Any state",
      options: [
        { value: "ok", label: "OK" },
        { value: "error", label: "Error" },
        { value: "critical", label: "Left without printer" },
        { value: "outdated", label: "Outdated agent" },
        { value: "stale", label: `Not seen > ${config().AGENT_STALE_HOURS} h` },
        { value: "would-remove", label: "Takeover pending (would remove)" },
        { value: "revoked", label: "Revoked" },
      ],
    },
    { kind: "select", key: "ou", label: "OU", allLabel: "All OUs", searchable: true, options: agentOuOptions(all).map((o) => ({ value: o, label: shortDn(o) || o })) },
    { kind: "select", key: "version", label: "Agent version", allLabel: "Any version", searchable: true, options: facets.versions.map((v) => ({ value: v, label: `v${v}` })) },
    {
      kind: "select",
      key: "unmanaged",
      label: "Unmanaged printers",
      allLabel: "Any",
      options: [
        { value: "any", label: "Has unmanaged printers" },
        ...UNMANAGED_CLASSES.map((c) => ({ value: c, label: UNMANAGED_CLASS_LABELS[c] })),
        { value: "would-remove", label: "Dry-run: would remove" },
        { value: "removed", label: "Removed some" },
        { value: "failed", label: "Removal failed" },
      ],
    },
    { kind: "select", key: "os", label: "OS build", allLabel: "Any OS build", searchable: true, options: facets.os.map((v) => ({ value: v, label: v })) },
    { kind: "sort", key: "sort", label: "Sort", defaultValue: "seen-desc", options: [{ value: "seen-desc", label: "Last seen (newest)" }, { value: "seen-asc", label: "Last seen (oldest)" }, { value: "name", label: "Computer name" }] },
  ];
  const filtered = activeAgentFilters(f) > 0 || !!f.q;
  const unmanaged = unmanagedSummary(all);

  return (
    <>
      <PageHeader title="Agents" />
      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        {critical.length > 0 && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>
              {critical.length} PC{critical.length > 1 ? "s" : ""} left without a printer
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {critical.flatMap((a) =>
                  (a.lastReport?.critical ?? []).map((m) => (
                    <li key={`${a.id}${m}`}>
                      <span className="font-medium">{a.computerName}</span>: {m}
                    </li>
                  )),
                )}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {unmanaged.reportingPcs > 0 && <UnmanagedFleetCard s={unmanaged} active={f.unmanaged} />}
        {all.length > 0 && (
          <Suspense>
            <ListFilters
              fields={fields}
              searchLabel="Search agents"
              searchPlaceholder="Computer name or user"
              total={all.length}
              shown={shown.length}
              noun={["PC", "PCs"]}
            />
          </Suspense>
        )}
        {filtered && shown.length === 0 ? (
          <NoMatches what="PCs" clearHref="/agents" />
        ) : agents.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerCogIcon />
              </EmptyMedia>
              <EmptyTitle>No agents enrolled</EmptyTitle>
              <EmptyDescription>Deploy Install-SpoolfreeAgent.ps1 as a GPO computer startup script (see below).</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
          {/* Phones: one card per PC. */}
          <ItemGroup className="gap-3 md:hidden">
            {shown.map((a) => {
              const x = agentParts(a, ctx);
              return (
                <Item key={a.id} variant="outline" className={a.revokedAt ? "items-start opacity-50" : "items-start"}>
                  <ItemContent className="min-w-0 gap-2">
                    <ItemTitle className="w-full justify-between">
                      <span className="min-w-0">{x.computer}</span>
                    </ItemTitle>
                    <div className="text-xs text-muted-foreground">Last check-in {x.checkin}</div>
                    <div>{x.applied}</div>
                    <div>{x.result}</div>
                    <div className="text-xs text-muted-foreground">{x.version}</div>
                  </ItemContent>
                  <ItemActions>{x.revoke}</ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
          <Card className="hidden py-0 md:flex">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Computer</TableHead>
                  <TableHead>Last check-in</TableHead>
                  <TableHead>Applied printers</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="w-10 pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((a) => {
                  const x = agentParts(a, ctx);
                  return (
                    <TableRow key={a.id} className={a.revokedAt ? "opacity-50" : undefined}>
                      <TableCell className="pl-4">{x.computer}</TableCell>
                      <TableCell>{x.checkin}</TableCell>
                      <TableCell>{x.applied}</TableCell>
                      <TableCell>{x.result}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{x.version}</TableCell>
                      <TableCell className="pr-4">{x.revoke}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Agent deployment</CardTitle>
            <CardDescription>Pin this public key in the GPO startup script. Agents reject manifests not signed by it.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {"error" in key ? (
              <Badge variant="destructive">{key.error}</Badge>
            ) : (
              <>
                <div>
                  <span className="text-muted-foreground">Key ID </span>
                  <code className="font-mono">{key.keyId}</code>
                </div>
                <div>
                  <span className="text-muted-foreground">Agent bundle </span>
                  {bundle ? (
                    <>
                      <code className="font-mono">v{bundle.version}</code>
                      <span className="text-muted-foreground"> · sha256 </span>
                      <code className="font-mono">{bundle.sha256.slice(0, 16)}</code>
                      <span className="text-muted-foreground">
                        {" "}
                        · self-update {selfUpdate ? "on" : "off"}
                        {outdatedCount ? ` · ${outdatedCount} outdated agent${outdatedCount > 1 ? "s" : ""}` : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">not available (agent scripts not found in AGENT_BUNDLE_DIR)</span>
                  )}
                </div>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs md:p-4">{`powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-SpoolfreeAgent.ps1 \`
  -ServerUrl "${publicUrl}" \`
  -PublicKey "${key.publicKey}" \`
  -EnrollmentTokenPath "\\\\fs01.example.org\\spoolfree$\\enroll.token"`}</pre>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

type AgentRow = typeof schema.agents.$inferSelect;

/**
 * Users seen printing on each PC (print analytics, last 90 days), so a search for a user finds their PC. Only read
 * when there is a search.
 */
async function usersByComputer(f: AgentFilters): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!f.q) return out;
  const rows = await db().execute<{ c: string; u: string }>(
    sql`select distinct lower(computer_name) c, user_name u from print_jobs where user_name is not null and printed_at > now() - interval '90 days' limit 20000`,
  );
  for (const r of rows) out.set(r.c, [...(out.get(r.c) ?? []), r.u]);
  return out;
}
interface AgentCtx {
  staleBefore: number;
  latest: string | null;
  selfUpdate: boolean;
}

/** The pieces of one agent's row, shared by the phone cards and the table. */
function agentParts(a: AgentRow, { staleBefore, latest, selfUpdate }: AgentCtx) {
  const r = a.lastReport;
                  const stale = !a.lastReportAt || a.lastReportAt.getTime() < staleBefore;
                  const errors = r?.errors ?? [];
                  const legacy = r?.legacy ?? [];
                  const wouldRemove = legacy.filter((l) => l.action === "would-remove");
                  const removedLegacy = legacy.filter((l) => l.action === "removed");
                  const failedLegacy = legacy.filter((l) => l.action === "failed");
  return {
    computer: (
      <>
        <div className="font-medium">{a.computerName}</div>
                        <div className="text-xs text-muted-foreground">{shortDn(a.dn.slice(a.dn.indexOf(",") + 1))}</div>
      </>
    ),
    checkin: (
      <>
        <div>{timeAgo(a.lastReportAt)}</div>
                        {stale && !a.revokedAt && (
                          <Badge variant="outline" className="mt-1">
                            Stale
                          </Badge>
                        )}
      </>
    ),
    applied: (
      <>
        <div className="flex max-w-md flex-wrap gap-1">
                          {(r?.applied ?? []).map((n) => (
                            <Badge key={n} variant={n === r?.defaultPrinter ? "default" : "secondary"}>
                              {n}
                            </Badge>
                          ))}
                          {(r?.applied ?? []).length === 0 && <span className="text-muted-foreground">—</span>}
                        </div>
                        {(r?.queues ?? [])
                          .filter((q) => q.method === "Vendor")
                          .map((q) => (
                            <div key={`q${q.name}`} className="mt-1 max-w-md text-xs text-muted-foreground">
                              {q.name}: {q.driver} on {q.port}
                              {q.vendorFallback && (
                                <Badge variant="outline" className="ml-1" title={`Driverless failed on this PC, so it uses the vendor fallback package ${q.vendorFallback}`}>
                                  Vendor fallback
                                </Badge>
                              )}
                            </div>
                          ))}
      </>
    ),
    result: (
      <>
        {a.revokedAt ? (
                          <Badge variant="outline">Revoked</Badge>
                        ) : !r ? (
                          <Badge variant="outline">No report yet</Badge>
                        ) : (r.critical ?? []).length ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="destructive">Printer lost</Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">{(r.critical ?? []).join(" · ")}</TooltipContent>
                          </Tooltip>
                        ) : errors.length ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="destructive">{errors.length} error{errors.length > 1 ? "s" : ""}</Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">{errors.join(" · ")}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge variant="secondary">OK</Badge>
                        )}
                        {(r?.drivers ?? [])
                          .filter((x) => x.status !== "installed" && x.status !== "present")
                          .map((x) => (
                            <div key={`dr${x.printer}`} className={x.status === "failed" ? "mt-1 text-xs text-destructive" : "mt-1 text-xs text-amber-700 dark:text-amber-500"} title={x.message ?? undefined}>
                              {x.printer}: {x.status === "wpp-blocked"
                                ? "vendor driver not allowed under Windows Protected Print Mode; driverless used"
                                : x.status === "vendor-fallback"
                                  ? `vendor fallback: driverless failed on this PC, ${x.driverName ?? "vendor driver"} used${x.message ? ` (${x.message})` : ""}`
                                  : `vendor driver ${x.status}${x.message ? `: ${x.message}` : ""}`}
                            </div>
                          ))}
                        {(r?.fallbacks ?? []).map((f) => (
                          <div key={`fb${f.printer}`} className="mt-1 text-xs text-amber-700 dark:text-amber-500" title={f.reason}>
                            {f.printer}: created with the {f.method === "TcpIpPort" ? "TCP/IP port" : f.method} fallback
                          </div>
                        ))}
                        {legacy.length > 0 && (
                          <div className="mt-1 flex flex-col gap-0.5 text-xs">
                            {wouldRemove.map((l) => (
                              <div key={`w${l.scope}${l.queue}`} className="text-amber-700 dark:text-amber-500" title={l.reason}>
                                Would remove {l.queue} ({l.printer}
                                {l.scope !== "machine" ? `, ${l.scope}` : ""})
                              </div>
                            ))}
                            {removedLegacy.map((l) => (
                              <div key={`r${l.scope}${l.queue}`} className="text-muted-foreground" title={l.reason}>
                                Removed {l.queue} ({l.printer}
                                {l.scope !== "machine" ? `, ${l.scope}` : ""})
                              </div>
                            ))}
                            {failedLegacy.map((l) => (
                              <div key={`f${l.scope}${l.queue}`} className="text-destructive" title={l.error ?? l.reason}>
                                Could not remove {l.queue}: {l.error ?? "failed"}
                              </div>
                            ))}
                          </div>
                        )}
                        {!a.revokedAt && <UnmanagedSummaryToggle report={r} />}
      </>
    ),
    version: (
      <>
        {r?.agentVersion ? `v${r.agentVersion}` : "—"}
                        {r?.method ? ` · ${r.method}` : ""}
                        {!a.revokedAt && isAgentOutdated(r?.agentVersion, latest) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="ml-1">
                                Outdated
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              {selfUpdate ? `The server ships v${latest}; the agent updates itself at its next sync.` : `The server ships v${latest}; self-update is off (AGENT_SELF_UPDATE).`}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <div>{r?.osVersion ?? ""}</div>
                        {r?.update && r.update.state === "pending" && <div>Update to v{r.update.target} installed, runs at the next sync</div>}
                        {r?.update && (r.update.state === "rolled-back" || r.update.state === "failed") && (
                          <div className="text-destructive" title={r.update.error}>
                            {r.update.state === "rolled-back" ? `v${r.update.target} rolled back` : `Update to v${r.update.target} failed`}
                            {r.update.error ? `: ${r.update.error}` : ""}
                          </div>
                        )}
                        {r?.update?.state === "skipped" && (
                          <div className="text-amber-700 dark:text-amber-500" title={r.update.error}>
                            Update to v{r.update.target} skipped{r.update.error ? `: ${r.update.error}` : ""}
                          </div>
                        )}
      </>
    ),
    revoke: (
      <>
        {!a.revokedAt && (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {(r?.applied ?? []).length > 0 && <AgentTestPrintButton agentId={a.id} computerName={a.computerName} />}
            <RevokeButton id={a.id} name={a.computerName} />
          </div>
        )}
      </>
    ),
  };
}

/** Fleet summary of "Remove unmanaged printers" (agents 0.9.0+): every count links to the matching filter. */
function UnmanagedFleetCard({ s, active }: { s: ReturnType<typeof unmanagedSummary>; active: UnmanagedFilter | null }) {
  const link = (value: UnmanagedFilter, label: string, count: number, detail?: string, tone?: string) => (
    <Link
      key={value}
      href={`/agents?unmanaged=${value}`}
      aria-current={active === value ? "true" : undefined}
      className={`flex min-h-11 flex-col justify-center rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${active === value ? "border-primary bg-muted" : ""}`}
    >
      <span className={`font-medium tabular-nums ${tone ?? ""}`}>
        {count} PC{count === 1 ? "" : "s"}
        {detail ? <span className="font-normal text-muted-foreground"> · {detail}</span> : null}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unmanaged printers</CardTitle>
        <CardDescription>
          {s.pcs} of {s.reportingPcs} reporting PC{s.reportingPcs === 1 ? "" : "s"} have printers that are not Spoolfree queues. Set &quot;Remove unmanaged printers&quot; per OU on Assignments.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {link("any", "With unmanaged printers", s.pcs)}
        {UNMANAGED_CLASSES.filter((c) => s.byClass[c].pcs > 0).map((c) =>
          link(c, UNMANAGED_CLASS_LABELS[c], s.byClass[c].pcs, `${s.byClass[c].queues} queue${s.byClass[c].queues === 1 ? "" : "s"}`),
        )}
        {s.wouldRemovePcs > 0 && link("would-remove", "Dry-run: would remove", s.wouldRemovePcs, undefined, "text-amber-700 dark:text-amber-500")}
        {s.removedPcs > 0 && link("removed", "Removed in the last sync", s.removedPcs)}
        {s.failedPcs > 0 && link("failed", "Removal failed", s.failedPcs, undefined, "text-destructive")}
      </CardContent>
    </Card>
  );
}
