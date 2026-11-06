import { sql } from "drizzle-orm";
import { PageHeader } from "@/components/app/page-header";
import { db, schema } from "@/lib/db";
import { printerUri } from "@/lib/ipp/interpret";
import { requireAdmin } from "@/lib/session";
import { PrinterFormDialog, PrintersTable } from "./printers-client";

export const metadata = { title: "Printers" };

export default async function PrintersPage() {
  await requireAdmin();
  const d = db();
  const printers = await d.select().from(schema.printers).orderBy(schema.printers.name);
  const counts = await d
    .select({ printerId: schema.ouAssignments.printerId, n: sql<number>`count(*)::int` })
    .from(schema.ouAssignments)
    .groupBy(schema.ouAssignments.printerId);
  const byId = new Map(counts.map((c) => [c.printerId, c.n]));
  return (
    <>
      <PageHeader title="Printers" actions={<PrinterFormDialog />} />
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
            assignedOus: byId.get(p.id) ?? 0,
          }))}
        />
      </div>
    </>
  );
}
