import { Suspense } from "react";
import { DirectorySyncBadge } from "@/components/app/directory-sync-status";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { PageHeader } from "@/components/app/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ancestorChain, isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { shortDn } from "@/lib/format";
import { baseDn, directory } from "@/lib/directory";
import { buildOuTree, flattenTree } from "@/lib/ou-tree";
import { resolvePrinters } from "@/lib/resolve";
import { listPrinters, loadPolicy, loadUnmanagedSettings, unmanagedPolicyFor } from "@/lib/service";
import { requireAdmin } from "@/lib/session";
import { activeOuTreeFilters, matchOuTree, parseOuTreeFilters, visibleOuTree } from "@/lib/list-filters/directory";
import { toQuery } from "@/lib/list-filters/params";
import { OuPanel } from "./ou-panel";
import { OuTree } from "./ou-tree";
import { TreeCard } from "./tree-card";

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
        <div className="p-4 md:p-6">
          <Alert variant="destructive">
            <AlertTitle>Cannot read Active Directory</AlertTitle>
            <AlertDescription>{(e as Error).message}</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }
  const [policy, printers, unmanagedSettings] = await Promise.all([loadPolicy(), listPrinters(), loadUnmanagedSettings()]);
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
  // "Remove unmanaged printers" (0.9.0): what this OU would inherit (from its parent) and what it sets itself.
  // The root inherits only the server defaults.
  const unmanagedInherited =
    parent && inherited
      ? unmanagedPolicyFor(unmanagedSettings, { dn: `CN=__probe__,${parent}` })
      : unmanagedPolicyFor({ ouSettings: [], computerSettings: [] }, { dn: `CN=__probe__,${sel}` });
  const ownUnmanaged = unmanagedSettings.ouSettings.find((s) => normalizeDn(s.ouDn) === normalizeDn(sel));
  const fromLabel = (src: string) => (src === "default" ? "server default" : shortDn(src) || "Domain root");

  // Tree filters (URL params, applied here): name search, only OUs with their own printers, OUs that get printer X.
  const f = parseOuTreeFilters(params);
  const items = flat.map((n) => {
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
  });
  const dnOf = new Map(items.map((i) => [i.key, i.dn]));
  const matched = matchOuTree(items, f, (key) => probe(dnOf.get(key) ?? key).printers.some((r) => r.printerId === f.printer));
  const visible = visibleOuTree(items, matched).map((i) => ({ ...i, matched: !matched || matched.has(i.key) }));
  const fields: FilterField[] = [
    { kind: "switch", key: "assigned", label: "Only OUs with printers" },
    { kind: "select", key: "printer", label: "Gets printer", allLabel: "Any printer", searchable: true, options: printers.map((p) => ({ value: p.id, label: p.name })) },
  ];
  const filterQuery = toQuery({ q: f.q, assigned: f.withPrinters, printer: f.printer });

  return (
    <>
      <PageHeader title="Assignments" actions={<DirectorySyncBadge />} />
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <Suspense>
          <ListFilters
            fields={fields}
            searchLabel="Filter OUs"
            searchPlaceholder={`Filter ${items.length} OUs by name`}
            total={items.length}
            shown={matched ? matched.size : items.length}
            noun={["OU", "OUs"]}
            keep={["ou"]}
          />
        </Suspense>
      </div>
      <div className="grid gap-4 p-4 md:gap-6 md:p-6 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <TreeCard selectedLabel={selected.kind === "domain" ? "Domain root" : selected.name} defaultOpen={typeof params.ou !== "string" || activeOuTreeFilters(f) > 0 || !!f.q}>
            <OuTree selectedKey={normalizeDn(sel)} items={visible} filtering={!!matched} filterQuery={filterQuery} />
        </TreeCard>

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
          unmanaged={{
            own: {
              mode: ownUnmanaged?.removeUnmanaged ?? null,
              keep: ownUnmanaged?.unmanagedKeep ?? null,
              keepLocal: ownUnmanaged?.keepLocalPrinters ?? null,
            },
            inherited: {
              mode: unmanagedInherited.mode,
              modeFrom: fromLabel(unmanagedInherited.from.mode),
              keep: unmanagedInherited.keep,
              keepFrom: fromLabel(unmanagedInherited.from.keep),
              keepLocal: unmanagedInherited.keepLocal,
              keepLocalFrom: fromLabel(unmanagedInherited.from.keepLocal),
            },
          }}
        />
      </div>
    </>
  );
}
