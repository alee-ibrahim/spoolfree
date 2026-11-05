import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { recentAudit } from "@/lib/service";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireAdmin();
  const rows = await recentAudit(300);
  return (
    <>
      <PageHeader title="Audit log" />
      <div className="p-6">
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">When (UTC)</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="pr-4">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="pl-4 text-muted-foreground">
                    No changes recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4 whitespace-nowrap tabular-nums">{r.at.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
                  <TableCell>{r.actor}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.action}</Badge>
                  </TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={r.entityId ?? ""}>
                    {r.entityType}
                    {r.entityId ? `:${r.entityId}` : ""}
                  </TableCell>
                  <TableCell className="max-w-md truncate pr-4 font-mono text-xs" title={JSON.stringify(r.details)}>
                    {r.details ? JSON.stringify(r.details) : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
