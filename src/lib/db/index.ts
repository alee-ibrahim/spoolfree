import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

const g = globalThis as unknown as { __spoolfreeDb?: Db; __spoolfreeSql?: postgres.Sql };

/** Lazily created, process-wide connection pool (survives dev hot reloads). */
export function db(): Db {
  if (!g.__spoolfreeDb) {
    g.__spoolfreeSql = postgres(config().DATABASE_URL, { max: 10, onnotice: () => {} });
    g.__spoolfreeDb = drizzle(g.__spoolfreeSql, { schema });
  }
  return g.__spoolfreeDb;
}

/** Raw postgres.js client (advisory locks, health checks). */
export function sqlClient(): postgres.Sql {
  db();
  return g.__spoolfreeSql!;
}

export { schema };
