import { PackageIcon, ShieldAlertIcon } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { driverNames } from "@/lib/drivers/package";
import { listDriverPackages, toPackageForMatch } from "@/lib/drivers/store";
import { timeAgo } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { driverDecision } from "@/lib/service";
import { DeletePackageButton, UploadDriverDialog } from "./drivers-client";

export const metadata = { title: "Drivers" };

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default async function DriversPage() {
  await requireAdmin();
  const d = db();
  const [rows, printers] = await Promise.all([listDriverPackages(d), d.select().from(schema.printers).orderBy(schema.printers.name)]);
  const packages = rows.map(toPackageForMatch);
  const decisions = printers.map((p) => ({ p, dec: driverDecision(p, packages) }));
  const usedBy = new Map<string, string[]>();
  for (const { p, dec } of decisions) if (dec.mode === "vendor" && dec.package) usedBy.set(dec.package.id, [...(usedBy.get(dec.package.id) ?? []), p.name]);
  const needed = decisions.filter(({ dec }) => dec.needed);
  const vendor = decisions.filter(({ dec }) => dec.mode === "vendor");

  return (
    <>
      <PageHeader title="Drivers" actions={<UploadDriverDialog maxMb={config().DRIVER_PACKAGE_MAX_MB} />} />
      <div className="flex flex-col gap-4 p-4 md:gap-6 md:p-6">
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>Vendor drivers put third-party code on every PC that gets the printer</AlertTitle>
          <AlertDescription>
            Use them only for printers that need one (IPP 1.x only, no driverless format, or slow). PCs install a package only when
            its SHA-256 matches the signed manifest and its catalog (.cat) has a valid Authenticode signature.
          </AlertDescription>
        </Alert>

        {needed.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>
              {needed.length} printer{needed.length > 1 ? "s" : ""} need{needed.length === 1 ? "s" : ""} a vendor driver
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {needed.map(({ p, dec }) => (
                  <li key={p.id}>
                    <span className="font-medium">{p.name}</span>: {dec.reason}; {dec.needed}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageIcon />
              </EmptyMedia>
              <EmptyTitle>No driver packages</EmptyTitle>
              <EmptyDescription>
                Upload a zip of a signed x64 printer driver (its INF, CAT and files). Brand universal drivers (Brother Universal, HP UPD) can
                serve every printer of that brand in auto mode.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Package</TableHead>
                  <TableHead>Drivers</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Size / SHA-256</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead className="w-10 pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const names = driverNames(r.infs);
                  const users = usedBy.get(r.id) ?? [];
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="pl-4 align-top font-medium whitespace-normal">
                        {r.name}
                        <div className="flex flex-wrap gap-1 pt-1">
                          {r.manufacturer && <Badge variant="secondary">{r.manufacturer}</Badge>}
                          {r.universal && <Badge variant="outline">Universal</Badge>}
                          <Badge variant="outline">{r.architecture}</Badge>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-72 align-top text-sm whitespace-normal">
                        {r.universal && r.universalDriver ? <div className="font-medium">{r.universalDriver}</div> : null}
                        <div className="text-muted-foreground">
                          {names.slice(0, 3).join("; ")}
                          {names.length > 3 ? ` and ${names.length - 3} more` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-sm whitespace-normal">{[...new Set(r.infs.map((i) => i.driverVer).filter(Boolean))].join("; ") || "—"}</TableCell>
                      <TableCell className="align-top text-sm">
                        {mb(r.size)}
                        <div className="font-mono text-xs text-muted-foreground" title={r.sha256}>
                          {r.sha256.slice(0, 16)}…
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        {timeAgo(r.uploadedAt)}
                        <div className="text-xs text-muted-foreground">{r.uploadedBy}</div>
                      </TableCell>
                      <TableCell className="align-top text-sm whitespace-normal">{users.length ? users.join(", ") : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="pr-4 align-top">
                        <DeletePackageButton id={r.id} name={r.name} inUse={users} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Printers on vendor drivers</CardTitle>
            <CardDescription>The driver PCs get now. Auto-mode decisions that switched to vendor stay until you change the printer&apos;s driver mode.</CardDescription>
          </CardHeader>
          <CardContent>
            {vendor.length === 0 ? (
              <p className="text-sm text-muted-foreground">None: every printer is driverless.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {vendor.map(({ p, dec }) => (
                  <li key={p.id}>
                    <span className="font-medium">{p.name}</span>: {dec.driverName} from {dec.package?.name} ({dec.source === "auto" ? `auto, ${dec.match}` : "manual"}),{" "}
                    {dec.protocol === "raw9100" ? "RAW 9100" : dec.protocol === "lpr" ? "LPR" : "IPP"}. <span className="text-muted-foreground">{dec.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
