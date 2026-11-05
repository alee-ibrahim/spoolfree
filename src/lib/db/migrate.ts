import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";

export async function runMigrations() {
  const folder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  await migrate(db(), { migrationsFolder: folder });
  console.log("[spoolfree] database migrations applied");
}
