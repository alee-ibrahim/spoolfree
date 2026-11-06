import { NetworkIcon } from "lucide-react";
import { DirectorySyncBadge } from "@/components/app/directory-sync-status";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ancestorChain, isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { baseDn, directory } from "@/lib/directory";
import { buildOuTree, flattenTree } from "@/lib/ou-tree";
import { resolvePrinters } from "@/lib/resolve";
import { listPrinters, loadPolicy } from "@/lib/service";
import { requireAdmin } from "@/lib/session";
import { OuPanel } from "./ou-panel";
import { OuTree } from "./ou-tree";

export const metadata = { title: "Assignments" };

export default async function AssignmentsPage({ searchParams }: PageProps<"/assignments">) {
  await requireAdmin();
  const params = await searchParams;
  let containers;
  let computers;
  try {
    [containers, computers] = await Promise.all([directory().listContainers(), directory().listComputers()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Assignments" actions={<DirectorySyncBadge />} />
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>Cannot read Active Directory</AlertTitle>
            <AlertDescription>{(e as Error).message}</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }
  const [policy, printers] = await Promise.all([loadPolicy(), listPrinters()]);
  const flat = flattenTree(buildOuTree(containers));
  const selectedDn = typeof params.ou === "string" ? params.ou : (flat[1]?.dn ?? flat[0]?.dn);
  const selected = flat.find((n) => normalizeDn(n.dn) === normalizeDn(selectedDn ?? "")) ?? flat[0];

  const ownCount = new Map<string, number>();
  for (const a of policy.assignments) ownCount.set(normalizeDn(a.ouDn), (ownCount.get(normalizeDn(a.ouDn)) ?? 0) + 1);
  const settingsByOu = new Map(policy.ouSettings.map((s) => [normalizeDn(s.ouDn), s]));
  const probe = (ou: string) => resolvePrinters({ ...policy, overrides: [] }, { dn: `CN=__probe__,${ou}` });

  const sel = selected.dn;
  const parent = parentDn(sel);
  const inherited = parent && ancestorChain(`CN=x,${sel}`, baseDn()).length > 1 ? probe(parent) : null;
  const effective = probe(sel);
  const settings = settingsByOu.get(normalizeDn(sel));
  const own = policy.assignments.filter((a) => normalizeDn(a.ouDn) === normalizeDn(sel)).map((a) => a.printerId);
  const inOu = computers.filter((c) => normalizeDn(parentDn(c.dn) ?? "") === normalizeDn(sel));
  const below = computers.filter((c) => isUnder(c.dn, sel)).length;

  return (
    <>
      <PageHeader title="Assignments" actions={<DirectorySyncBadge />} />
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <NetworkIcon className="size-4" /> Directory
            </CardTitle>
            <CardDescription>Printers assigned to an OU flow down to its child OUs.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <OuTree
              selectedKey={normalizeDn(sel)}
              items={flat.map((n) => {
                const key = normalizeDn(n.dn);
                const parent = parentDn(n.dn);
                return {
                  key,
                  dn: n.dn,
                  label: n.kind === "domain" ? n.dn.replace(/DC=/gi, "").replace(/,/g, ".") : n.name,
                  depth: n.depth,
                  kind: n.kind,
                  parentKey: parent && n.depth > 0 ? normalizeDn(parent) : null,
                  hasChildren: n.children.length > 0,
                  count: ownCount.get(key) ?? 0,
                  blocked: settingsByOu.get(key)?.blockInheritance ?? false,
                };
              })}
            />
          </CardContent>
        </Card>

        <OuPanel
          ou={{ dn: sel, name: selected.name, kind: selected.kind, description: selected.description ?? null, isRoot: !inherited }}
          printers={printers.map((p) => ({ id: p.id, name: p.name, location: p.location }))}
          own={own}
          inherited={(inherited?.printers ?? []).map((r) => ({
            printerId: r.printerId,
            fromOu: r.source.kind === "ou" ? r.source.ouDn : "",
          }))}
          inheritedDefault={inherited?.defaultPrinterId ?? null}
          blockInheritance={settings?.blockInheritance ?? false}
          blocked={settings?.blockedPrinterIds ?? []}
          defaultPrinterId={settings?.defaultPrinterId ?? null}
          effective={effective.printers.map((r) => r.printerId)}
          effectiveDefault={effective.defaultPrinterId}
          computers={inOu.map((c) => ({ name: c.name, guid: c.objectGuid }))}
          computersBelow={below}
        />
      </div>
    </>
  );
}
