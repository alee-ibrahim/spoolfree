import type { AgentReport } from "./db/schema";

/**
 * Per-PC vendor fallback (agents 0.8.1+): the PCs whose last report lists a queue on the vendor fallback package,
 * by queue name (lower-case; queue name = printer name). Revoked agents are left out. Sorted by computer name.
 */
export function vendorFallbackByQueue(agents: { computerName: string; lastReport: AgentReport | null; revokedAt?: Date | null }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of agents) {
    if (a.revokedAt) continue;
    for (const q of a.lastReport?.queues ?? []) {
      if (!q?.vendorFallback || typeof q.name !== "string") continue;
      const key = q.name.toLowerCase();
      const list = out.get(key) ?? [];
      if (!list.includes(a.computerName)) list.push(a.computerName);
      out.set(key, list);
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.localeCompare(y));
  return out;
}
