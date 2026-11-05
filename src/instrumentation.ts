/**
 * Runs once per server start: applies database migrations and starts the
 * in-process printer poller (disable with POLLER_ENABLED=0, e.g. on extra replicas;
 * an advisory lock already prevents duplicate polling).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { config } = await import("./lib/config");
  const c = config();
  if (process.env.MIGRATE_ON_START !== "0") {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
  }
  if (c.POLLER_ENABLED) {
    const { startPoller } = await import("./lib/status/poller");
    startPoller();
  }
}
