import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { DirectorySyncBadge } from "@/components/app/directory-sync-status";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { directory } from "@/lib/directory";
import { shortDn } from "@/lib/format";
import { resolvePrinters } from "@/lib/resolve";
import { loadPolicy } from "@/lib/service";
import { requireAdmin } from "@/lib/session";
import { activeUnassignedFilters, containerOptions, filterComputers, parseUnassignedFilters } from "@/lib/list-filters/directory";

export const metadata = { title: "Unassigned PCs" };

export default async function UnassignedPage({ searchParams }: PageProps<"/unassigned">) {
  await requireAdmin();
  const f = parseUnassignedFilters(await searchParams);
  let computers, defaultContainer;
  try {
    [computers, defaultContainer] = await Promise.all([directory().listComputers(), directory().defaultComputersContainer()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Unassigned PCs" actions={<DirectorySyncBadge />} />
        <div className="p-4 md:p-6">
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
  const allInDefault = enabled.filter((c) => isUnder(c.dn, defaultContainer));
  const allNoPrinters = enabled
    .filter((c) => !isUnder(c.dn, defaultContainer))
    .filter((c) => resolvePrinters(policy, c).printers.length === 0);
  // Search (name, OS) and the OU filter (that OU and below) run here on the server.
  const inDefault = filterComputers(allInDefault, f);
  const noPrinters = filterComputers(allNoPrinters, f);
  const total = allInDefault.length + allNoPrinters.length;
  const filtered = activeUnassignedFilters(f) > 0 || !!f.q;
  const fields: FilterField[] = [
    {
      kind: "select",
      key: "ou",
      label: "OU",
      allLabel: "All OUs",
      searchable: true,
      options: containerOptions([...allInDefault, ...allNoPrinters]).map((o) => ({ value: o, label: shortDn(o) || o })),
    },
  ];
  const byOu = new Map<string, typeof noPrinters>();
  for (const c of noPrinters) {
    const ou = parentDn(c.dn) ?? "";
    byOu.set(normalizeDn(ou), [...(byOu.get(normalizeDn(ou)) ?? []), c]);
  }

  return (
    <>
      <PageHeader title="Unassigned PCs" actions={<DirectorySyncBadge />} />
      {total > 0 && (
        <div className="px-4 pt-4 md:px-6 md:pt-6">
          <Suspense>
            <ListFilters
              fields={fields}
              searchLabel="Search unassigned PCs"
              searchPlaceholder="Computer name or OS"
              total={total}
              shown={inDefault.length + noPrinters.length}
              noun={["PC", "PCs"]}
            />
          </Suspense>
        </div>
      )}
      <div className="grid gap-4 p-4 md:gap-6 md:p-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>In the default Computers container</CardTitle>
            <CardDescription>
              <span className="font-mono text-xs break-all">{defaultContainer}</span> — new PCs land here when nobody moves them to an OU.
              Group Policy for OUs does not reach them, so the agent may not be installed either.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ComputerTable list={inDefault} filtered={filtered && allInDefault.length > 0} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>In OUs that get no printers</CardTitle>
            <CardDescription>Enabled computers whose OU chain resolves to zero printers (after overrides).</CardDescription>
          </CardHeader>
          <CardContent>
            {byOu.size === 0 ? (
              <p className="text-sm text-muted-foreground">
                {filtered && allNoPrinters.length > 0 ? "No PC here matches the filters." : "Every computer in an OU gets at least one printer."}
              </p>
            ) : (
              <ItemGroup className="gap-2">
                {[...byOu.values()].map((list) => {
                  const ou = parentDn(list[0].dn) ?? "";
                  return (
                    <Item key={ou} variant="outline" size="sm" className="items-start">
                      <ItemContent className="min-w-0">
                        <ItemTitle>{shortDn(ou)}</ItemTitle>
                        <div className="flex flex-wrap gap-1 pt-1">
                          {list.map((c) => (
                            <Badge key={c.objectGuid} variant="outline">
                              {c.name}
                            </Badge>
                          ))}
                        </div>
                      </ItemContent>
                      <ItemActions>
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/assignments?ou=${encodeURIComponent(ou)}`}>Assign</Link>
                        </Button>
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ComputerTable({ list, filtered }: { list: { name: string; objectGuid: string; operatingSystem?: string | null }[]; filtered: boolean }) {
  if (list.length === 0) return <p className="text-sm text-muted-foreground">{filtered ? "No PC here matches the filters." : "None. Good housekeeping."}</p>;
  return (
    <ItemGroup className="gap-2">
      {list.map((c) => (
        <Item key={c.objectGuid} variant="outline" size="sm">
          <ItemContent className="min-w-0">
            <ItemTitle>{c.name}</ItemTitle>
            <ItemDescription>{c.operatingSystem ?? "Unknown OS"}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant="ghost" asChild>
              <Link href={`/preview?computer=${c.objectGuid}`}>Preview</Link>
            </Button>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}
