import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { Snapshot, SnapshotComputer, SnapshotOu, SnapshotStore, SyncStatus } from "./snapshot";

const ROW_ID = 1;
const CHUNK = 500;

/** Postgres-backed snapshot storage (tables directory_ous, directory_computers, directory_sync). */
export class DbSnapshotStore implements SnapshotStore {
  async replace(snapshot: Snapshot, at: Date): Promise<void> {
    await db().transaction(async (tx) => {
      // Two replicas each run a sidecar: serialize the replace instead of racing on the primary keys.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('spoolfree:directory-snapshot'))`);
      await tx.delete(schema.directoryComputers);
      await tx.delete(schema.directoryOus);
      for (let i = 0; i < snapshot.ous.length; i += CHUNK) {
        await tx.insert(schema.directoryOus).values(snapshot.ous.slice(i, i + CHUNK));
      }
      for (let i = 0; i < snapshot.computers.length; i += CHUNK) {
        await tx.insert(schema.directoryComputers).values(snapshot.computers.slice(i, i + CHUNK));
      }
      const row = {
        baseDn: snapshot.baseDn,
        defaultContainer: snapshot.defaultContainer,
        syncedAt: at,
        source: snapshot.source,
        ouCount: snapshot.ous.length,
        computerCount: snapshot.computers.length,
      };
      await tx
        .insert(schema.directorySync)
        .values({ id: ROW_ID, ...row })
        .onConflictDoUpdate({ target: schema.directorySync.id, set: row });
    });
  }

  async recordError(message: string, source: string | null, at: Date): Promise<void> {
    await db()
      .insert(schema.directorySync)
      .values({ id: ROW_ID, lastError: message, lastErrorAt: at, source })
      .onConflictDoUpdate({ target: schema.directorySync.id, set: { lastError: message, lastErrorAt: at } });
  }

  async status(): Promise<SyncStatus | null> {
    const [row] = await db().select().from(schema.directorySync).where(eq(schema.directorySync.id, ROW_ID)).limit(1);
    return row ?? null;
  }

  async listOus(): Promise<SnapshotOu[]> {
    return db().select().from(schema.directoryOus);
  }

  async listComputers(): Promise<SnapshotComputer[]> {
    return db().select().from(schema.directoryComputers);
  }

  async findComputer(guid: string): Promise<SnapshotComputer | null> {
    const [row] = await db()
      .select()
      .from(schema.directoryComputers)
      .where(eq(schema.directoryComputers.objectGuid, guid))
      .limit(1);
    return row ?? null;
  }
}
