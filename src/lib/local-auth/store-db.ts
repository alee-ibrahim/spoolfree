import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { LocalLoginStore, LocalUserRow } from "./login";

/** Postgres store for local users. Also used by scripts/local-user.ts (no "server-only" here). */
export class DbLocalLoginStore implements LocalLoginStore {
  async findUser(username: string): Promise<LocalUserRow | null> {
    const [u] = await db().select().from(schema.localUsers).where(eq(schema.localUsers.username, username)).limit(1);
    return u ?? null;
  }
  async recordFailure(id: string, failedAttempts: number, lockedUntil: Date | null) {
    await db().update(schema.localUsers).set({ failedAttempts, lockedUntil }).where(eq(schema.localUsers.id, id));
  }
  async recordSuccess(id: string, at: Date) {
    await db().update(schema.localUsers).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: at }).where(eq(schema.localUsers.id, id));
  }
  async audit(actor: string, action: string, details: Record<string, unknown>) {
    await db().insert(schema.auditLog).values({ actor, action, entityType: "local_user", entityId: actor.replace(/^local:/, ""), details });
  }
}

// --- CLI operations -----------------------------------------------------------------------------------

export async function upsertLocalUser(username: string, passwordHash: string, create: boolean): Promise<"created" | "reset"> {
  const existing = await new DbLocalLoginStore().findUser(username);
  if (create && existing) throw new Error(`user ${username} already exists (use "reset")`);
  if (!create && !existing) throw new Error(`no user ${username} (use "add")`);
  if (existing) {
    await db()
      .update(schema.localUsers)
      .set({ passwordHash, failedAttempts: 0, lockedUntil: null, passwordChangedAt: new Date() })
      .where(eq(schema.localUsers.id, existing.id));
    return "reset";
  }
  await db().insert(schema.localUsers).values({ username, passwordHash });
  return "created";
}

export async function updateLocalUser(username: string, set: Partial<{ disabled: boolean; failedAttempts: number; lockedUntil: Date | null }>) {
  const rows = await db().update(schema.localUsers).set(set).where(eq(schema.localUsers.username, username)).returning({ id: schema.localUsers.id });
  if (rows.length === 0) throw new Error(`no user ${username}`);
}

export async function deleteLocalUser(username: string) {
  const rows = await db().delete(schema.localUsers).where(eq(schema.localUsers.username, username)).returning({ id: schema.localUsers.id });
  if (rows.length === 0) throw new Error(`no user ${username}`);
}

export async function listLocalUsers() {
  return db()
    .select({
      username: schema.localUsers.username,
      disabled: schema.localUsers.disabled,
      lockedUntil: schema.localUsers.lockedUntil,
      lastLoginAt: schema.localUsers.lastLoginAt,
      passwordChangedAt: schema.localUsers.passwordChangedAt,
    })
    .from(schema.localUsers)
    .orderBy(schema.localUsers.username);
}
