import { StarIcon } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db, schema } from "@/lib/db";
import { directory } from "@/lib/directory";
import { shortDn } from "@/lib/format";
import { buildManifest } from "@/lib/manifest";
import { resolvePrinters } from "@/lib/resolve";
import { listPrinters, loadPackagesForMatch, loadPolicy, loadUnmanagedSettings, toManifestInput, unmanagedPolicyFor } from "@/lib/service";
import { UnmanagedQueueList } from "@/components/app/unmanaged-queues";
import { toManifestUnmanaged } from "@/lib/unmanaged";
import { requireAdmin } from "@/lib/session";
import { eq } from "drizzle-orm";
import { ComputerPicker, ComputerUnmanagedEditor, OverridesEditor } from "./preview-client";

export const metadata = { title: "Preview" };

export default async function PreviewPage({ searchParams }: PageProps<"/preview">) {
  await requireAdmin();
  const params = await searchParams;
  let computers;
  try {
    computers = (await directory().listComputers()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return (
      <>
        <PageHeader title="Preview" />
        <div className="p-4 md:p-6">
          <Alert variant="destructive">
            <AlertTitle>Cannot read Active Directory</AlertTitle>
            <AlertDescription>{(e as Error).message}</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }
  const guid = typeof params.computer === "string" ? params.computer.toLowerCase() : null;
  const computer = computers.find((c) => c.objectGuid === guid) ?? null;
  const [policy, printers, packages, unmanagedSettings] = await Promise.all([loadPolicy(), listPrinters(), loadPackagesForMatch(), loadUnmanagedSettings()]);
  const byId = new Map(printers.map((p) => [p.id, p]));
  const name = (id: string) => byId.get(id)?.name ?? "(deleted)";

  const resolution = computer ? resolvePrinters(policy, computer) : null;
  const overrides = computer
    ? await db().select().from(schema.computerOverrides).where(eq(schema.computerOverrides.computerGuid, computer.objectGuid))
    : [];
  // "Remove unmanaged printers" (0.9.0): the PC's effective policy, what its OUs say (without the PC override), its
  // own override and the unmanaged queues its agent reported last.
  const unmanaged = computer ? unmanagedPolicyFor(unmanagedSettings, computer) : null;
  const unmanagedOu = computer ? unmanagedPolicyFor({ ...unmanagedSettings, computerSettings: [] }, computer) : null;
  const ownUnmanaged = computer ? unmanagedSettings.computerSettings.find((c) => c.computerGuid.toLowerCase() === computer.objectGuid) : undefined;
  const [agent] = computer ? await db().select().from(schema.agents).where(eq(schema.agents.objectGuid, computer.objectGuid)) : [];
  const from = (src: string) => (src === "default" ? "server default" : src === "computer" ? "this PC" : shortDn(src) || "Domain root");
  const manifest =
    computer && resolution
      ? buildManifest({
          resolution,
          printers: new Map(printers.map((p) => [p.id, toManifestInput(p, packages)])),
          computer: { objectGuid: computer.objectGuid, dn: computer.dn, name: computer.name },
          now: new Date(),
          ttlHours: 24,
          serial: "preview",
          unmanaged: unmanaged ? toManifestUnmanaged(unmanaged) : undefined,
        })
      : null;

  return (
    <>
      <PageHeader title="Preview" wideActions actions={<ComputerPicker computers={computers.map((c) => ({ guid: c.objectGuid, name: c.name, ou: shortDn(c.dn.slice(c.dn.indexOf(",") + 1)) }))} selected={computer?.objectGuid ?? null} />} />
      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        {!computer && (
          <Alert>
            <AlertTitle>What will a computer get?</AlertTitle>
            <AlertDescription>Pick a computer to see the printers it will receive, where each comes from, and the signed manifest its agent downloads.</AlertDescription>
          </Alert>
        )}
        {computer && resolution && (
          <>
            <div className="grid gap-6 xl:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{computer.name} gets {resolution.printers.length} printer{resolution.printers.length === 1 ? "" : "s"}</CardTitle>
                  <CardDescription className="font-mono text-xs break-all">{computer.dn}</CardDescription>
                </CardHeader>
                <CardContent>
                  {computer.disabled && (
                    <Alert variant="destructive" className="mb-4">
                      <AlertTitle>Computer account is disabled</AlertTitle>
                      <AlertDescription>Its agent will be refused a manifest.</AlertDescription>
                    </Alert>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Printer</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resolution.printers.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-muted-foreground">
                            No printers.
                          </TableCell>
                        </TableRow>
                      )}
                      {resolution.printers.map((r) => (
                        <TableRow key={r.printerId}>
                          <TableCell className="font-medium whitespace-normal">
                            {name(r.printerId)}
                            {resolution.defaultPrinterId === r.printerId && (
                              <Badge variant="secondary" className="ml-2">
                                <StarIcon data-icon="inline-start" />
                                Default
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground whitespace-normal">
                            {r.source.kind === "computer" ? <Badge variant="outline">Computer override</Badge> : shortDn(r.source.ouDn) || "Domain root"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>How it was resolved</CardTitle>
                  <CardDescription>Each OU from the domain root down to the computer.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>OU</TableHead>
                        <TableHead>Changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resolution.trace.map((t) => (
                        <TableRow key={t.ouDn}>
                          <TableCell className="whitespace-normal">{shortDn(t.ouDn) || "Domain root"}</TableCell>
                          <TableCell className="flex flex-wrap gap-1 whitespace-normal">
                            {t.blockedInheritance && <Badge variant="destructive">Blocks inheritance</Badge>}
                            {t.blocked.map((id) => (
                              <Badge key={`b${id}`} variant="destructive">
                                − {name(id)}
                              </Badge>
                            ))}
                            {t.added.map((id) => (
                              <Badge key={`a${id}`} variant="secondary">
                                + {name(id)}
                              </Badge>
                            ))}
                            {t.defaultSet && <Badge variant="outline">default: {name(t.defaultSet)}</Badge>}
                            {!t.blockedInheritance && !t.blocked.length && !t.added.length && !t.defaultSet && <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>

            <OverridesEditor
              computer={{ guid: computer.objectGuid, name: computer.name }}
              printers={printers.map((p) => ({ id: p.id, name: p.name }))}
              overrides={overrides.map((o) => ({ id: o.id, printerId: o.printerId, action: o.action, makeDefault: o.makeDefault }))}
            />

            {unmanaged && unmanagedOu && (
              <Card>
                <CardHeader>
                  <CardTitle>Unmanaged printers</CardTitle>
                  <CardDescription>
                    Queues on {computer.name} that are not Spoolfree queues. The agent always reports them; it removes them only when the setting is on,
                    except the keep list{unmanaged.keepLocal ? " and USB/local printers" : ""}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">Setting</dt>
                    <dd>
                      <Badge variant={unmanaged.mode === "on" ? "destructive" : "outline"}>{unmanaged.mode}</Badge>
                      <span className="ml-2 text-xs text-muted-foreground">from {from(unmanaged.from.mode)}</span>
                    </dd>
                    <dt className="text-muted-foreground">Keep list</dt>
                    <dd className="flex flex-wrap items-center gap-1">
                      {unmanaged.keep.length === 0 ? (
                        <span className="text-muted-foreground">empty</span>
                      ) : (
                        unmanaged.keep.map((k) => (
                          <Badge key={k} variant="secondary" className="font-mono">
                            {k}
                          </Badge>
                        ))
                      )}
                      <span className="text-xs text-muted-foreground">from {from(unmanaged.from.keep)}</span>
                    </dd>
                    <dt className="text-muted-foreground">USB/local printers</dt>
                    <dd>
                      {unmanaged.keepLocal ? "kept" : "removed"}
                      <span className="ml-2 text-xs text-muted-foreground">from {from(unmanaged.from.keepLocal)}</span>
                    </dd>
                  </dl>
                  <ComputerUnmanagedEditor
                    computer={{ guid: computer.objectGuid, name: computer.name }}
                    own={{ mode: ownUnmanaged?.removeUnmanaged ?? null, keepLocal: ownUnmanaged?.keepLocalPrinters ?? null }}
                    ou={{ mode: unmanagedOu.mode, modeFrom: from(unmanagedOu.from.mode), keepLocal: unmanagedOu.keepLocal, keepLocalFrom: from(unmanagedOu.from.keepLocal) }}
                  />
                  <div className="flex flex-col gap-2">
                    <div className="text-sm font-medium">Last agent report</div>
                    {!agent?.lastReport ? (
                      <p className="text-sm text-muted-foreground">No agent report from this PC yet.</p>
                    ) : !Array.isArray(agent.lastReport.unmanaged) ? (
                      <p className="text-sm text-muted-foreground">The agent does not report unmanaged printers yet (needs agent 0.9.0; it updates itself).</p>
                    ) : agent.lastReport.unmanaged.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No unmanaged printers.</p>
                    ) : (
                      <>
                        {agent.lastReport.unmanagedPolicy?.blocked && (
                          <p className="text-xs text-muted-foreground">Nothing removed: {agent.lastReport.unmanagedPolicy.blocked}</p>
                        )}
                        <UnmanagedQueueList items={agent.lastReport.unmanaged} />
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Manifest payload</CardTitle>
                <CardDescription>The agent receives this JSON base64-encoded with an Ed25519 signature over its bytes.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs">{JSON.stringify(manifest, null, 2)}</pre>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
