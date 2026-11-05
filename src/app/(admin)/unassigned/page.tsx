import Link from "next/link";
import { DirectorySyncBadge } from "@/components/app/directory-sync-status";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { directory } from "@/lib/directory";
import { shortDn } from "@/lib/format";
import { resolvePrinters } from "@/lib/resolve";
import { loadPolicy } from "@/lib/service";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "Unassigned PCs" };

export default async function UnassignedPage() {
  await requireAdmin();
  let computers, defaultContainer;
  try {
    [computers, defaultContainer] = await Promise.all([directory().listComputers(), directory().defaultComputersContainer()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Unassigned PCs" actions={<DirectorySyncBadge />} />
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>Cannot read Active Directory</AlertTitle>
            <AlertDescription>{(e as Error).message}</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }
  const policy = await loadPolicy();
  const enabled = computers.filter((c) => !c.disabled);
  const inDefault = enabled.filter((c) => isUnder(c.dn, defaultContainer));
  const noPrinters = enabled
    .filter((c) => !isUnder(c.dn, defaultContainer))
    .filter((c) => resolvePrinters(policy, c).printers.length === 0);
  const byOu = new Map<string, typeof noPrinters>();
  for (const c of noPrinters) {
    const ou = parentDn(c.dn) ?? "";
    byOu.set(normalizeDn(ou), [...(byOu.get(normalizeDn(ou)) ?? []), c]);
  }

  return (
    <>
      <PageHeader title="Unassigned PCs" actions={<DirectorySyncBadge />} />
      <div className="grid gap-6 p-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>In the default Computers container</CardTitle>
            <CardDescription>
              <span className="font-mono text-xs">{defaultContainer}</span> — new PCs land here when nobody moves them to an OU.
              Group Policy for OUs does not reach them, so the agent may not be installed either.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ComputerTable list={inDefault} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>In OUs that get no printers</CardTitle>
            <CardDescription>Enabled computers whose OU chain resolves to zero printers (after overrides).</CardDescription>
          </CardHeader>
          <CardContent>
            {byOu.size === 0 ? (
              <p className="text-sm text-muted-foreground">Every computer in an OU gets at least one printer.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>OU</TableHead>
                    <TableHead>Computers</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...byOu.values()].map((list) => {
                    const ou = parentDn(list[0].dn) ?? "";
                    return (
                      <TableRow key={ou}>
                        <TableCell className="font-medium">{shortDn(ou)}</TableCell>
                        <TableCell className="flex flex-wrap gap-1">
                          {list.map((c) => (
                            <Badge key={c.objectGuid} variant="outline">
                              {c.name}
                            </Badge>
                          ))}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/assignments?ou=${encodeURIComponent(ou)}`}>Assign</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ComputerTable({ list }: { list: { name: string; objectGuid: string; operatingSystem?: string | null }[] }) {
  if (list.length === 0) return <p className="text-sm text-muted-foreground">None. Good housekeeping.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Computer</TableHead>
          <TableHead>OS</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((c) => (
          <TableRow key={c.objectGuid}>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell className="text-muted-foreground">{c.operatingSystem ?? "—"}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/preview?computer=${c.objectGuid}`}>Preview</Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
