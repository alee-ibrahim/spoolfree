import { Suspense } from "react";
import { ListFilters, type FilterField } from "@/components/app/list-filters";
import { NoMatches } from "@/components/app/no-matches";
import { PageHeader } from "@/components/app/page-header";
import type { OuOption } from "@/components/app/ou-picker";
import { db, schema } from "@/lib/db";
import { isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { directory } from "@/lib/directory";
import { buildOuTree, flattenTree } from "@/lib/ou-tree";
import { printerUri } from "@/lib/ipp/interpret";
import { requireAdmin } from "@/lib/session";
import { driverNames } from "@/lib/drivers/package";
import { driverDecision, loadPackagesForMatch } from "@/lib/service";
import { shortDn } from "@/lib/format";
import { activePrinterFilters, brandOptions, filterPrinters, parsePrinterFilters } from "@/lib/list-filters/printers";
import { PrinterFormDialog, PrintersTable, type DriverPackageOption } from "./printers-client";

export const metadata = { title: "Printers" };

export default async function PrintersPage({ searchParams }: PageProps<"/printers">) {
  await requireAdmin();
  const d = db();
  const f = parsePrinterFilters(await searchParams);
  const [allPrinters, statuses, assignments, settings, ouOptions, packages] = await Promise.all([
    d.select().from(schema.printers).orderBy(schema.printers.name),
    d.select().from(schema.printerStatus),
    d.select().from(schema.ouAssignments),
    d.select().from(schema.ouSettings),
    loadOuOptions(),
    loadPackagesForMatch(),
  ]);
  const packageOptions: DriverPackageOption[] = packages.map((p) => ({ id: p.id, name: p.name, universal: p.universal, drivers: driverNames(p.infs) }));
  const byPrinter = new Map<string, string[]>();
  for (const a of assignments) byPrinter.set(a.printerId, [...(byPrinter.get(a.printerId) ?? []), a.ouDn]);
  const defaultOf = new Map(settings.filter((s) => s.defaultPrinterId).map((s) => [normalizeDn(s.ouDn), s.defaultPrinterId!]));
  const nameOf = new Map(allPrinters.map((p) => [p.id, p.name]));
  const statusOf = new Map(statuses.map((s) => [s.printerId, s]));
  // Search and filters run here on the server; the list keeps the filter rows' order (sorted by f.sort).
  const printers = filterPrinters(
    allPrinters.map((p) => ({ ...p, ouDns: byPrinter.get(p.id) ?? [], status: statusOf.get(p.id) ?? null })),
    f,
  );
  const assignedOus = [...new Map(assignments.map((a) => [normalizeDn(a.ouDn), a.ouDn])).values()].sort((a, b) => shortDn(a).localeCompare(shortDn(b)));
  const fields: FilterField[] = [
    { kind: "toggle", key: "status", label: "Status", options: [{ value: "online", label: "Online" }, { value: "offline", label: "Offline" }, { value: "error", label: "Error" }] },
    { kind: "switch", key: "low", label: "Toner low" },
    { kind: "switch", key: "unassigned", label: "Unassigned" },
    { kind: "select", key: "ou", label: "OU", allLabel: "All OUs", searchable: true, options: assignedOus.map((o) => ({ value: o, label: shortDn(o) || o })) },
    { kind: "select", key: "brand", label: "Brand", allLabel: "All brands", options: brandOptions(allPrinters).map((b) => ({ value: b, label: b })) },
    { kind: "toggle", key: "takeover", label: "Takeover", options: [{ value: "off", label: "Off" }, { value: "dry-run", label: "Dry-run" }, { value: "on", label: "On" }] },
    {
      kind: "select",
      key: "sides",
      label: "Duplex default",
      allLabel: "Any duplex",
      options: [
        { value: "auto", label: "Driver default" },
        { value: "one-sided", label: "One-sided" },
        { value: "two-sided-long-edge", label: "Two-sided (long edge)" },
        { value: "two-sided-short-edge", label: "Two-sided (short edge)" },
      ],
    },
    { kind: "select", key: "driver", label: "Driver mode", allLabel: "Any driver mode", options: [{ value: "auto", label: "Auto" }, { value: "driverless", label: "Driverless" }, { value: "vendor", label: "Vendor" }] },
    { kind: "sort", key: "sort", label: "Sort", defaultValue: "name", options: [{ value: "name", label: "Name" }, { value: "location", label: "Location / floor" }, { value: "status", label: "Status (problems first)" }] },
  ];
  const filtered = activePrinterFilters(f) > 0 || !!f.q;
  const options: OuOption[] | null =
    ouOptions?.map((o) => {
      const def = defaultOf.get(o.key);
      return { ...o, defaultPrinter: def ? { id: def, name: nameOf.get(def) ?? "(deleted)" } : null };
    }) ?? null;
  return (
    <>
      <PageHeader title="Printers" actions={<PrinterFormDialog ouOptions={options} packages={packageOptions} />} />
      <div className="flex flex-col gap-3 p-4 md:gap-4 md:p-6">
        {allPrinters.length > 0 && (
          <Suspense>
            <ListFilters
              fields={fields}
              searchLabel="Search printers"
              searchPlaceholder="Name, IP, model, location or alias"
              total={allPrinters.length}
              shown={printers.length}
              noun={["printer", "printers"]}
            />
          </Suspense>
        )}
        {filtered && printers.length === 0 ? (
          <NoMatches what="printers" clearHref="/printers" />
        ) : (
        <PrintersTable
          packages={packageOptions}
          printers={printers.map((p) => {
            const dec = driverDecision(p, packages);
            return {
            id: p.id,
            name: p.name,
            host: p.host,
            port: p.port,
            ippPath: p.ippPath,
            ippPathAuto: p.ippPathAuto,
            ippUri: printerUri(p),
            ippVersion: p.lastTest?.ippRequestVersion ?? null,
            useTls: p.useTls,
            location: p.location,
            model: p.model,
            notes: p.notes,
            legacyTakeover: p.legacyTakeover,
            legacyShares: p.legacyShares,
            legacyAliases: p.legacyAliases,
            defaultSides: p.defaultSides,
            sidesSupported: p.lastTest?.sidesSupported ?? null,
            sidesDefault: p.lastTest?.sidesDefault ?? null,
            revision: p.revision,
            lastTestAt: p.lastTestAt?.toISOString() ?? null,
            lastTestOk: p.lastTest?.ok ?? null,
            lastTestFormats: p.lastTest?.driverlessFormats ?? [],
            assignedOus: byPrinter.get(p.id)?.length ?? 0,
            ous: (byPrinter.get(p.id) ?? []).map((ouDn) => ({ ouDn, isDefault: defaultOf.get(normalizeDn(ouDn)) === p.id })),
            driverMode: p.driverMode,
            driverPackageId: p.driverPackageId,
            driverName: p.driverName,
            vendorProtocol: p.vendorProtocol,
            lprQueue: p.lprQueue,
            ippVersions: p.lastTest?.ippVersions ?? null,
            status: p.status ? { online: p.status.online, state: p.status.state, stateReasons: p.status.stateReasons, markers: p.status.markers } : null,
            decision: {
              mode: dec.mode,
              source: dec.source,
              reason: dec.reason,
              needed: dec.needed,
              packageName: dec.package?.name ?? null,
              driverName: dec.driverName,
              match: dec.match,
              sticky: !!p.autoVendorReason,
            },
            };
          })}
          ouOptions={options}
        />
        )}
      </div>
    </>
  );
}

/** Every OU and container from the directory, in tree order, with a full path label. Null when AD cannot be read. */
async function loadOuOptions(): Promise<Omit<OuOption, "defaultPrinter">[] | null> {
  try {
    const [containers, computers] = await Promise.all([directory().listContainers(), directory().listComputers()]);
    const flat = flattenTree(buildOuTree(containers));
    const nameByKey = new Map<string, string>();
    return flat.map((n) => {
      const key = normalizeDn(n.dn);
      const label = n.kind === "domain" ? n.dn.replace(/DC=/gi, "").replace(/,/g, ".") : n.name;
      const parent = parentDn(n.dn);
      const parentPath = parent && n.depth > 0 ? nameByKey.get(normalizeDn(parent)) : undefined;
      const path = parentPath ? `${parentPath} › ${label}` : label;
      // Paths start below the domain: "Workstations › Administration › Finance".
      nameByKey.set(key, n.kind === "domain" ? "" : path);
      return {
        key,
        dn: n.dn,
        name: label,
        path,
        depth: n.depth,
        kind: n.kind,
        computers: computers.filter((c) => !c.disabled && isUnder(c.dn, n.dn) && normalizeDn(c.dn) !== key).length,
      };
    });
  } catch {
    return null;
  }
}
