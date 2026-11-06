import { desc } from "drizzle-orm";
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
import { RevokeButton } from "./revoke-button";

export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  await requireAdmin();
  const agents = await db().select().from(schema.agents).orderBy(desc(schema.agents.lastReportAt));
  const staleBefore = agentStaleCutoff();
  const key = signingKeyInfo();
  const publicUrl = config().PUBLIC_URL;
  const bundle = currentAgentBundle();
  const latest = bundle?.version ?? null;
  const selfUpdate = config().AGENT_SELF_UPDATE;
  const outdatedCount = agents.filter((a) => !a.revokedAt && isAgentOutdated(a.lastReport?.agentVersion, latest)).length;
  // High severity: PCs that takeover left without a printer (agents 0.4.6+ report it until it is fixed).
  const critical = agents.filter((a) => !a.revokedAt && (a.lastReport?.critical ?? []).length > 0);

  return (
    <>
      <PageHeader title="Agents" />
      <div className="flex flex-col gap-6 p-6">
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
        {agents.length === 0 ? (
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
          <Card className="py-0">
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
                {agents.map((a) => {
                  const r = a.lastReport;
                  const stale = !a.lastReportAt || a.lastReportAt.getTime() < staleBefore;
                  const errors = r?.errors ?? [];
                  const legacy = r?.legacy ?? [];
                  const wouldRemove = legacy.filter((l) => l.action === "would-remove");
                  const removedLegacy = legacy.filter((l) => l.action === "removed");
                  const failedLegacy = legacy.filter((l) => l.action === "failed");
                  return (
                    <TableRow key={a.id} className={a.revokedAt ? "opacity-50" : undefined}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{a.computerName}</div>
                        <div className="text-xs text-muted-foreground">{shortDn(a.dn.slice(a.dn.indexOf(",") + 1))}</div>
                      </TableCell>
                      <TableCell>
                        <div>{timeAgo(a.lastReportAt)}</div>
                        {stale && !a.revokedAt && (
                          <Badge variant="outline" className="mt-1">
                            Stale
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-md flex-wrap gap-1">
                          {(r?.applied ?? []).map((n) => (
                            <Badge key={n} variant={n === r?.defaultPrinter ? "default" : "secondary"}>
                              {n}
                            </Badge>
                          ))}
                          {(r?.applied ?? []).length === 0 && <span className="text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                      <TableCell>
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
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
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
                      </TableCell>
                      <TableCell className="pr-4">{!a.revokedAt && <RevokeButton id={a.id} name={a.computerName} />}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
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
                <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs">{`powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-SpoolfreeAgent.ps1 \`
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
