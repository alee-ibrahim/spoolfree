import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
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
      <div className="p-4 md:p-6">
        {/* Phones: one entry per change. */}
        <ItemGroup className="gap-2 md:hidden">
          {rows.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded yet.</p>}
          {rows.map((r) => (
            <Item key={r.id} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap">
                  <Badge variant="outline">{r.action}</Badge>
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{r.at.toISOString().replace("T", " ").slice(0, 16)} UTC</span>
                </ItemTitle>
                <ItemDescription className="break-all">{r.actor}</ItemDescription>
                <ItemDescription className="font-mono text-xs break-all">
                  {r.entityType}
                  {r.entityId ? `:${r.entityId}` : ""}
                </ItemDescription>
                {r.details && (
                  <details className="text-xs">
                    <summary className="cursor-pointer py-2 text-muted-foreground">Details</summary>
                    <pre className="overflow-x-auto rounded-md bg-muted p-2 whitespace-pre-wrap break-all">{JSON.stringify(r.details, null, 2)}</pre>
                  </details>
                )}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        <Card className="hidden py-0 md:flex">
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
