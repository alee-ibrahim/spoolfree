import { isAgentOutdated } from "../agent-bundle";
import type { AgentReport } from "../db/schema";
import { isUnder, parentDn } from "../dn";
import { containerOptions } from "./directory";
import { countActive, matchesWords, one, oneOf, words, type SearchParams } from "./params";

/**
 * ok: reported without errors; error: the last sync had errors; critical: takeover left the PC without a printer;
 * outdated: older than the bundle the server ships; stale: no report within AGENT_STALE_HOURS; would-remove: a
 * dry-run takeover would remove a legacy queue; revoked.
 */
export const AGENT_STATES = ["ok", "error", "critical", "outdated", "stale", "would-remove", "revoked"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const AGENT_SORTS = ["seen-desc", "seen-asc", "name"] as const;
export type AgentSort = (typeof AGENT_SORTS)[number];

export interface AgentFilters {
  q: string | null;
  /** An OU; agents in it and in its child OUs match. */
  ou: string | null;
  state: AgentState | null;
  version: string | null;
  os: string | null;
  sort: AgentSort;
}

export function parseAgentFilters(sp: SearchParams): AgentFilters {
  return {
    q: one(sp, "q", 200),
    ou: one(sp, "ou", 2048),
    state: oneOf(sp, "state", AGENT_STATES),
    version: one(sp, "version", 32),
    os: one(sp, "os", 64),
    sort: oneOf(sp, "sort", AGENT_SORTS) ?? "seen-desc",
  };
}

export const activeAgentFilters = (f: AgentFilters) => countActive({ ...f });

export interface AgentFilterRow {
  computerName: string;
  dn: string;
  lastReportAt: Date | null;
  lastReport: AgentReport | null;
  revokedAt: Date | null;
}

export interface AgentStateCtx {
  /** Epoch ms: reports older than this are stale. */
  staleBefore: number;
  /** The agent version the server ships. */
  latest: string | null;
}

/** Every state an agent is in (an agent can be outdated and stale at once). */
export function agentStates(a: AgentFilterRow, ctx: AgentStateCtx): Set<AgentState> {
  const s = new Set<AgentState>();
  if (a.revokedAt) return s.add("revoked");
  const r = a.lastReport;
  if (!a.lastReportAt || a.lastReportAt.getTime() < ctx.staleBefore) s.add("stale");
  if ((r?.critical ?? []).length) s.add("critical");
  if ((r?.errors ?? []).length) s.add("error");
  if (r && !s.has("critical") && !s.has("error")) s.add("ok");
  if (isAgentOutdated(r?.agentVersion, ctx.latest)) s.add("outdated");
  if ((r?.legacy ?? []).some((l) => l.action === "would-remove")) s.add("would-remove");
  return s;
}

/** The OU an agent's computer object is in. */
export const agentOu = (dn: string) => parentDn(dn) ?? "";

/**
 * Filters and sorts agents (server-side). `users` maps a lower-cased computer name to user names seen on it (print
 * jobs, per-user legacy queues), so a search finds a PC by who uses it.
 */
export function filterAgents<T extends AgentFilterRow>(rows: T[], f: AgentFilters, ctx: AgentStateCtx, users?: Map<string, string[]>): T[] {
  const terms = words(f.q);
  const out = rows.filter((a) => {
    if (terms.length) {
      const legacyUsers = (a.lastReport?.legacy ?? []).map((l) => (l.scope.startsWith("user:") ? l.scope.slice(5) : null));
      if (!matchesWords(terms, [a.computerName, ...legacyUsers, ...(users?.get(a.computerName.toLowerCase()) ?? [])])) return false;
    }
    if (f.ou && !isUnder(agentOu(a.dn), f.ou)) return false;
    if (f.state && !agentStates(a, ctx).has(f.state)) return false;
    if (f.version && (a.lastReport?.agentVersion ?? "") !== f.version) return false;
    if (f.os && (a.lastReport?.osVersion ?? "") !== f.os) return false;
    return true;
  });
  const seen = (a: AgentFilterRow) => a.lastReportAt?.getTime() ?? 0;
  if (f.sort === "name") return out.sort((a, b) => a.computerName.localeCompare(b.computerName, undefined, { numeric: true, sensitivity: "base" }));
  if (f.sort === "seen-asc") return out.sort((a, b) => seen(a) - seen(b));
  return out.sort((a, b) => seen(b) - seen(a));
}

/** OUs that hold agents, plus their parent OUs (so a whole branch can be picked), top-down. */
export const agentOuOptions = (rows: Pick<AgentFilterRow, "dn">[]) => containerOptions(rows);

/** Distinct values for the version / OS filters (versions newest first). */
export function agentFacetOptions(rows: Pick<AgentFilterRow, "lastReport">[]) {
  const versions = [...new Set(rows.map((r) => r.lastReport?.agentVersion).filter((v): v is string => !!v))].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  const os = [...new Set(rows.map((r) => r.lastReport?.osVersion).filter((v): v is string => !!v))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return { versions, os };
}
