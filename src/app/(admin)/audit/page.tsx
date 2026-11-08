import { count, desc } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { NoMatches } from "@/components/app/no-matches";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db, schema } from "@/lib/db";
import { activeAuditFilters, auditActionOptions, auditWhere, parseAuditFilters } from "@/lib/list-filters/audit";
import { toQuery } from "@/lib/list-filters/params";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  await requireAdmin();
  const f = parseAuditFilters(await searchParams);
  const d = db();
  const a = schema.auditLog;
  const w = auditWhere(f);
  // Filtering, counting and paging run in Postgres: the log only grows.
  const [rows, [{ n: shown }], [{ n: total }], actors, actions] = await Promise.all([
    d.select().from(a).where(w).orderBy(desc(a.id)).limit(PAGE_SIZE).offset((f.page - 1) * PAGE_SIZE),
    d.select({ n: count() }).from(a).where(w),
    d.select({ n: count() }).from(a),
    d.selectDistinct({ v: a.actor }).from(a).orderBy(a.actor).limit(500),
    d.selectDistinct({ v: a.action }).from(a).orderBy(a.action).limit(500),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const fields: FilterField[] = [
    { kind: "select", key: "actor", label: "Who", allLabel: "Anyone", searchable: true, options: actors.map((r) => ({ value: r.v, label: r.v })) },
    { kind: "select", key: "action", label: "Action", allLabel: "Any action", searchable: true, options: auditActionOptions(actions.map((r) => r.v)) },
    { kind: "dates", label: "Date (UTC)", fromKey: "from", toKey: "to", today },
  ];
  const filtered = activeAuditFilters(f) > 0 || !!f.q;
  const pages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
  const link = (page: number) => `/audit${toQuery({ q: f.q, actor: f.actor, action: f.action, from: f.from, to: f.to, page: page > 1 ? page : null })}`;
  return (
    <>
      <PageHeader title="Audit log" />
      <div className="flex flex-col gap-3 p-4 md:gap-4 md:p-6">
        {total > 0 && (
          <Suspense>
            <ListFilters fields={fields} searchLabel="Search the audit log" searchPlaceholder="Search who, action, target, details" total={total} shown={shown} noun={["change", "changes"]} />
          </Suspense>
        )}
        {filtered && shown === 0 && <NoMatches what="changes" clearHref="/audit" />}
        {/* Phones: one entry per change. */}
        <ItemGroup className="gap-2 md:hidden">
          {total === 0 && <p className="text-sm text-muted-foreground">No changes recorded yet.</p>}
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
        <Card className={filtered && shown === 0 ? "hidden" : "hidden py-0 md:flex"}>
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
              {total === 0 && (
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
        {pages > 1 && (
          <nav className="flex items-center justify-between gap-2" aria-label="Audit log pages">
            <Button asChild variant="outline" className={f.page <= 1 ? "pointer-events-none opacity-50" : undefined}>
              <Link href={link(f.page - 1)} aria-disabled={f.page <= 1} scroll={false}>
                Newer
              </Link>
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              Page {Math.min(f.page, pages)} of {pages}
            </span>
            <Button asChild variant="outline" className={f.page >= pages ? "pointer-events-none opacity-50" : undefined}>
              <Link href={link(f.page + 1)} aria-disabled={f.page >= pages} scroll={false}>
                Older
              </Link>
            </Button>
          </nav>
        )}
      </div>
    </>
  );
}
