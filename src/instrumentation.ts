/**
 * Runs once per server start: applies database migrations and starts the
 * in-process printer poller (disable with POLLER_ENABLED=0, e.g. on extra replicas;
 * an advisory lock already prevents duplicate polling).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { config } = await import("./lib/config");
  const c = config();
  if (process.env.NODE_ENV === "production") {
    // Refuse to start with an admin policy that would lock everyone out or let the wrong people in.
    const { adminAccessConfigErrors } = await import("./lib/admin-claims");
    const { adminAccessPolicy } = await import("./lib/config");
    const errors = adminAccessConfigErrors(adminAccessPolicy());
    if (errors.length > 0) {
      for (const e of errors) console.error(`[spoolfree] configuration error: ${e}`);
      process.exit(1);
    }
  }
  if (process.env.MIGRATE_ON_START !== "0") {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
  }
  if (c.POLLER_ENABLED) {
    const { startPoller } = await import("./lib/status/poller");
    startPoller();
  }
}
