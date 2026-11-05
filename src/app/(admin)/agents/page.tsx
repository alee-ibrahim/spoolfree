import { desc } from "drizzle-orm";
import { ServerCogIcon } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

  return (
    <>
      <PageHeader title="Agents" />
      <div className="flex flex-col gap-6 p-6">
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
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r?.agentVersion ? `v${r.agentVersion}` : "—"}
                        {r?.method ? ` · ${r.method}` : ""}
                        <div>{r?.osVersion ?? ""}</div>
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
