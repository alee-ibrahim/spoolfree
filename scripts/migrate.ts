/** pnpm db:migrate — applies migrations from ./drizzle (the server also does this on start). */
import { runMigrations } from "../src/lib/db/migrate";
import { sqlClient } from "../src/lib/db";

runMigrations()
  .then(() => sqlClient().end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
