import { PageHeader } from "@/components/app/page-header";
import type { OuOption } from "@/components/app/ou-picker";
import { db, schema } from "@/lib/db";
import { isUnder, normalizeDn, parentDn } from "@/lib/dn";
import { directory } from "@/lib/directory";
import { buildOuTree, flattenTree } from "@/lib/ou-tree";
import { printerUri } from "@/lib/ipp/interpret";
import { requireAdmin } from "@/lib/session";
import { PrinterFormDialog, PrintersTable } from "./printers-client";

export const metadata = { title: "Printers" };

export default async function PrintersPage() {
  await requireAdmin();
  const d = db();
  const printers = await d.select().from(schema.printers).orderBy(schema.printers.name);
  const [assignments, settings, ouOptions] = await Promise.all([
    d.select().from(schema.ouAssignments),
    d.select().from(schema.ouSettings),
    loadOuOptions(),
  ]);
  const byPrinter = new Map<string, string[]>();
  for (const a of assignments) byPrinter.set(a.printerId, [...(byPrinter.get(a.printerId) ?? []), a.ouDn]);
  const defaultOf = new Map(settings.filter((s) => s.defaultPrinterId).map((s) => [normalizeDn(s.ouDn), s.defaultPrinterId!]));
  const nameOf = new Map(printers.map((p) => [p.id, p.name]));
  const options: OuOption[] | null =
    ouOptions?.map((o) => {
      const def = defaultOf.get(o.key);
      return { ...o, defaultPrinter: def ? { id: def, name: nameOf.get(def) ?? "(deleted)" } : null };
    }) ?? null;
  return (
    <>
      <PageHeader title="Printers" actions={<PrinterFormDialog ouOptions={options} />} />
      <div className="p-4 md:p-6">
        <PrintersTable
          printers={printers.map((p) => ({
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
          }))}
          ouOptions={options}
        />
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
