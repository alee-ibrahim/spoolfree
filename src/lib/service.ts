import "server-only";
import { desc } from "drizzle-orm";
import { db, schema } from "./db";
import { baseDn, directory, type ComputerObject } from "./directory";
import { buildManifest, type ManifestPrinterInput } from "./manifest";
import { resolvePrinters, type Policy } from "./resolve";
import { config } from "./config";

export async function audit(
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown>,
) {
  await db().insert(schema.auditLog).values({ actor, action, entityType, entityId, details: details ?? null });
}

export async function loadPolicy(): Promise<Policy> {
  const d = db();
  const [assignments, settings, overrides] = await Promise.all([
    d.select().from(schema.ouAssignments),
    d.select().from(schema.ouSettings),
    d.select().from(schema.computerOverrides),
  ]);
  return {
    baseDn: baseDn(),
    assignments: assignments.map((a) => ({ ouDn: a.ouDn, printerId: a.printerId })),
    ouSettings: settings.map((s) => ({
      ouDn: s.ouDn,
      blockInheritance: s.blockInheritance,
      blockedPrinterIds: s.blockedPrinterIds,
      defaultPrinterId: s.defaultPrinterId,
    })),
    overrides: overrides.map((o) => ({
      computerGuid: o.computerGuid,
      printerId: o.printerId,
      action: o.action,
      makeDefault: o.makeDefault,
    })),
  };
}

export async function listPrinters() {
  return db().select().from(schema.printers).orderBy(schema.printers.name);
}

export function toManifestInput(p: typeof schema.printers.$inferSelect): ManifestPrinterInput {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    ippPath: p.ippPath,
    useTls: p.useTls,
    model: p.model,
    location: p.location,
    revision: p.revision,
    legacyTakeover: p.legacyTakeover,
    legacyShares: p.legacyShares,
    defaultSides: p.defaultSides,
  };
}

export async function manifestForComputer(computer: ComputerObject) {
  const [policy, printers] = await Promise.all([loadPolicy(), listPrinters()]);
  const resolution = resolvePrinters(policy, computer);
  return buildManifest({
    resolution,
    printers: new Map(printers.map((p) => [p.id, toManifestInput(p)])),
    computer: { objectGuid: computer.objectGuid, dn: computer.dn, name: computer.name },
    now: new Date(),
    ttlHours: config().MANIFEST_TTL_HOURS,
    legacyPrintServers: config().LEGACY_PRINT_SERVERS,
  });
}

export async function recentAudit(limit = 200) {
  return db().select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(limit);
}

export { directory };
