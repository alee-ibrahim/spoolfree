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
import { listPrinters, loadPolicy, toManifestInput } from "@/lib/service";
import { requireAdmin } from "@/lib/session";
import { eq } from "drizzle-orm";
import { ComputerPicker, OverridesEditor } from "./preview-client";

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
        <div className="p-6">
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
  const [policy, printers] = await Promise.all([loadPolicy(), listPrinters()]);
  const byId = new Map(printers.map((p) => [p.id, p]));
  const name = (id: string) => byId.get(id)?.name ?? "(deleted)";

  const resolution = computer ? resolvePrinters(policy, computer) : null;
  const overrides = computer
    ? await db().select().from(schema.computerOverrides).where(eq(schema.computerOverrides.computerGuid, computer.objectGuid))
    : [];
  const manifest =
    computer && resolution
      ? buildManifest({
          resolution,
          printers: new Map(printers.map((p) => [p.id, toManifestInput(p)])),
          computer: { objectGuid: computer.objectGuid, dn: computer.dn, name: computer.name },
          now: new Date(),
          ttlHours: 24,
          serial: "preview",
        })
      : null;

  return (
    <>
      <PageHeader title="Preview" actions={<ComputerPicker computers={computers.map((c) => ({ guid: c.objectGuid, name: c.name, ou: shortDn(c.dn.slice(c.dn.indexOf(",") + 1)) }))} selected={computer?.objectGuid ?? null} />} />
      <div className="flex flex-col gap-6 p-6">
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
                          <TableCell className="font-medium">
                            {name(r.printerId)}
                            {resolution.defaultPrinterId === r.printerId && (
                              <Badge variant="secondary" className="ml-2">
                                <StarIcon data-icon="inline-start" />
                                Default
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
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
                          <TableCell>{shortDn(t.ouDn) || "Domain root"}</TableCell>
                          <TableCell className="flex flex-wrap gap-1">
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
