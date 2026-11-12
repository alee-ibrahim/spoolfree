import { z } from "zod";
import { ancestorChain, normalizeDn } from "./dn";
import { normalizeUuid } from "./identity";
import {
  REMOVE_UNMANAGED_MODES,
  UNMANAGED_CLASSES,
  type AgentReport,
  type RemoveUnmanaged,
  type UnmanagedClass,
  type UnmanagedQueue,
} from "./db/schema";

/**
 * "Remove unmanaged printers" (0.9.0), pure parts: policy inheritance down the OU tree, the keep list, the fleet
 * summary of what agents report, the device UUIDs the server learns from reports and the audit entries for removals.
 *
 * Inheritance: the setting, the keep list and "keep USB/local printers" are each inherited separately from the domain
 * root down to the PC's OU; the nearest OU that sets one wins. Block inheritance (printers) does not reset them. A
 * per-PC override (Preview page, CLI `computers:`) wins over the OUs for the setting and "keep USB/local".
 */

export interface OuUnmanagedSetting {
  ouDn: string;
  removeUnmanaged: RemoveUnmanaged | null;
  unmanagedKeep: string[] | null;
  keepLocalPrinters: boolean | null;
}

export interface ComputerUnmanagedSetting {
  computerGuid: string;
  removeUnmanaged: RemoveUnmanaged | null;
  keepLocalPrinters: boolean | null;
}

/** Where a value came from: an OU DN, "computer" (per-PC override) or "default" (server default). */
export type UnmanagedSource = string;

export interface UnmanagedPolicy {
  mode: RemoveUnmanaged;
  keep: string[];
  keepLocal: boolean;
  from: { mode: UnmanagedSource; keep: UnmanagedSource; keepLocal: UnmanagedSource };
}

export const DEFAULT_KEEP_LOCAL = true;
export const KEEP_LIST_MAX = 50;
export const KEEP_ENTRY_MAX = 200;

/** Resolves the unmanaged-printer policy for a computer (or for an OU: pass `CN=__probe__,<ou>` as dn). */
export function resolveUnmanaged(args: {
  baseDn: string;
  ouSettings: OuUnmanagedSetting[];
  computerSettings?: ComputerUnmanagedSetting[];
  computer: { dn: string; objectGuid?: string | null };
  defaultKeep: string[];
}): UnmanagedPolicy {
  const byOu = new Map(args.ouSettings.map((s) => [normalizeDn(s.ouDn), s]));
  const p: UnmanagedPolicy = {
    mode: "off",
    keep: [...args.defaultKeep],
    keepLocal: DEFAULT_KEEP_LOCAL,
    from: { mode: "default", keep: "default", keepLocal: "default" },
  };
  for (const ou of ancestorChain(args.computer.dn, args.baseDn)) {
    const s = byOu.get(normalizeDn(ou));
    if (!s) continue;
    if (s.removeUnmanaged && (REMOVE_UNMANAGED_MODES as string[]).includes(s.removeUnmanaged)) {
      p.mode = s.removeUnmanaged;
      p.from.mode = ou;
    }
    if (Array.isArray(s.unmanagedKeep)) {
      p.keep = [...s.unmanagedKeep];
      p.from.keep = ou;
    }
    if (typeof s.keepLocalPrinters === "boolean") {
      p.keepLocal = s.keepLocalPrinters;
      p.from.keepLocal = ou;
    }
  }
  const guid = args.computer.objectGuid?.toLowerCase();
  const own = guid ? args.computerSettings?.find((c) => c.computerGuid.toLowerCase() === guid) : undefined;
  if (own?.removeUnmanaged && (REMOVE_UNMANAGED_MODES as string[]).includes(own.removeUnmanaged)) {
    p.mode = own.removeUnmanaged;
    p.from.mode = "computer";
  }
  if (typeof own?.keepLocalPrinters === "boolean") {
    p.keepLocal = own.keepLocalPrinters;
    p.from.keepLocal = "computer";
  }
  return p;
}

/**
 * Splits and checks a keep list (new lines or ";"): trimmed, case-insensitive duplicates dropped. Entries are
 * queue-name globs (* and ?) or driver names. Throws on control characters, too long entries or too many.
 */
export function parseKeepList(v: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(v) ? v : (v ?? "").split(/[;\r\n]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const e = String(raw).trim();
    if (!e) continue;
    if (/[\x00-\x1f\x7f]/.test(e)) throw new Error(`keep list entry "${e.slice(0, 40)}" has control characters`);
    if (e.length > KEEP_ENTRY_MAX) throw new Error(`keep list entry is longer than ${KEEP_ENTRY_MAX} characters`);
    if (seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    out.push(e);
  }
  if (out.length > KEEP_LIST_MAX) throw new Error(`a keep list has at most ${KEEP_LIST_MAX} entries`);
  return out;
}

/** zod: a keep list from a string or an array. */
export const keepListInput = z.union([z.string().max(20000), z.array(z.string())]).transform((v, ctx) => {
  try {
    return parseKeepList(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

/** The manifest block (agents 0.9.0+; older agents ignore it). */
export interface ManifestUnmanaged {
  mode: RemoveUnmanaged;
  keep: string[];
  keepLocal: boolean;
}

export const toManifestUnmanaged = (p: UnmanagedPolicy): ManifestUnmanaged => ({ mode: p.mode, keep: p.keep, keepLocal: p.keepLocal });

/**
 * Serial numbers in an IEEE 1284 device ID ("SN:", "SERN:", "SERIALNUMBER:"), upper-case. Agents match them against
 * the names of WSD devices and queues (some printers put the serial in their WSD name).
 */
export function serialsFromDeviceId(deviceId: string | null | undefined): string[] {
  if (!deviceId) return [];
  const out = new Set<string>();
  for (const m of deviceId.matchAll(/(?:^|;)\s*(?:SN|SERN|SERIALNUMBER|SERIAL)\s*:\s*([^;]+)/gi)) {
    const v = m[1].trim().toUpperCase();
    if (/^[A-Z0-9-]{5,40}$/.test(v)) out.add(v);
  }
  return [...out].sort();
}

// --- Reports ----------------------------------------------------------------------------------------------

export interface UnmanagedAgentRow {
  computerName: string;
  dn: string;
  lastReport: AgentReport | null;
  revokedAt?: Date | null;
}

export interface UnmanagedSummary {
  /** PCs (not revoked) whose last report lists at least one unmanaged queue that is still there. */
  pcs: number;
  /** Per class: PCs and queues. */
  byClass: Record<UnmanagedClass, { pcs: number; queues: number }>;
  /** PCs with a dry-run "would remove" entry, and PCs where the agent removed or failed to remove queues. */
  wouldRemovePcs: number;
  removedPcs: number;
  failedPcs: number;
  /** PCs whose agent reports unmanaged queues at all (0.9.0+). */
  reportingPcs: number;
}

/** Queues still on the PC (removed ones are listed in the report once, then gone). */
export const presentUnmanaged = (r: AgentReport | null | undefined): UnmanagedQueue[] => (r?.unmanaged ?? []).filter((u) => u.action !== "removed");

export function unmanagedSummary(rows: UnmanagedAgentRow[]): UnmanagedSummary {
  const byClass = Object.fromEntries(UNMANAGED_CLASSES.map((c) => [c, { pcs: 0, queues: 0 }])) as UnmanagedSummary["byClass"];
  const s: UnmanagedSummary = { pcs: 0, byClass, wouldRemovePcs: 0, removedPcs: 0, failedPcs: 0, reportingPcs: 0 };
  for (const a of rows) {
    if (a.revokedAt || !a.lastReport || !Array.isArray(a.lastReport.unmanaged)) continue;
    s.reportingPcs++;
    const all = a.lastReport.unmanaged;
    const present = presentUnmanaged(a.lastReport);
    if (present.length) s.pcs++;
    for (const c of UNMANAGED_CLASSES) {
      const n = present.filter((u) => u.class === c).length;
      if (n) {
        byClass[c].pcs++;
        byClass[c].queues += n;
      }
    }
    if (all.some((u) => u.action === "would-remove")) s.wouldRemovePcs++;
    if (all.some((u) => u.action === "removed")) s.removedPcs++;
    if (all.some((u) => u.action === "failed")) s.failedPcs++;
  }
  return s;
}

/** Filter values of the Agents page's "Unmanaged printers" filter. */
export const UNMANAGED_FILTERS = ["any", ...UNMANAGED_CLASSES, "would-remove", "removed", "failed"] as const;
export type UnmanagedFilter = (typeof UNMANAGED_FILTERS)[number];

export function matchesUnmanagedFilter(r: AgentReport | null | undefined, f: UnmanagedFilter): boolean {
  const all = r?.unmanaged ?? [];
  if (f === "would-remove" || f === "removed" || f === "failed") return all.some((u) => u.action === f);
  const present = presentUnmanaged(r);
  if (f === "any") return present.length > 0;
  return present.some((u) => u.class === f);
}

/** Matches strong enough to learn a device UUID from: the device's own UUID, its MAC or its serial number. */
const LEARN_FROM = new Set(["uuid", "mac", "serial"]);
export const EXTRA_UUIDS_MAX = 8;

/**
 * Device UUIDs to add to printers (printer name, lower-case -> new UUIDs), from one agent report:
 *  - the UUIDs of the ports of the PC's own Spoolfree queues (`queues[].uuids`: Add-Printer -IppURL creates a WSD-monitor
 *    port that stores the device UUID it reached);
 *  - the WSD/IPP UUIDs of legacy queues the agent matched to a printer by UUID, MAC or serial (never by address alone).
 * A UUID that is already another printer's (`taken`, lower-case UUID -> printer name lower-case) is skipped, so one
 * misreported UUID cannot move between devices.
 */
export function learnedUuids(
  report: Pick<AgentReport, "queues" | "unmanaged">,
  printers: { name: string; deviceUuid: string | null; extraUuids: string[] }[],
): Map<string, string[]> {
  const byName = new Map(printers.map((p) => [p.name.toLowerCase(), p]));
  const taken = new Map<string, string>();
  for (const p of printers) for (const u of [p.deviceUuid, ...p.extraUuids]) if (u) taken.set(u.toLowerCase(), p.name.toLowerCase());
  const out = new Map<string, string[]>();
  const add = (printer: string | null | undefined, uuid: string | null | undefined) => {
    const u = normalizeUuid(uuid ?? null);
    const key = printer?.toLowerCase();
    if (!u || !key || !byName.has(key)) return;
    const owner = taken.get(u);
    if (owner) return; // already known (for this printer or another)
    const p = byName.get(key)!;
    const list = out.get(key) ?? [];
    if (p.extraUuids.length + list.length >= EXTRA_UUIDS_MAX || list.includes(u)) return;
    list.push(u);
    out.set(key, list);
    taken.set(u, key);
  };
  for (const q of report.queues ?? []) for (const u of q.uuids ?? []) add(q.name, u);
  for (const u of report.unmanaged ?? []) {
    if (!u.matchedPrinter || !LEARN_FROM.has(u.matchBy ?? "")) continue;
    add(u.matchedPrinter, u.wsdUuid);
    add(u.matchedPrinter, u.ippUuid);
  }
  return out;
}

/** Audit entries for queues an agent removed (or failed to remove) under "Remove unmanaged printers"; at most `max`. */
export function unmanagedAuditEntries(report: Pick<AgentReport, "unmanaged">, max = 50) {
  return (report.unmanaged ?? [])
    .filter((u) => u.action === "removed" || u.action === "failed")
    .slice(0, max)
    .map((u) => ({
      action: u.action === "removed" ? "agent.unmanaged_removed" : "agent.unmanaged_remove_failed",
      details: { queue: u.queue, class: u.class, scope: u.scope, driver: u.driver ?? null, port: u.port ?? null, matchedPrinter: u.matchedPrinter ?? null, error: u.error ?? null },
    }));
}

export const UNMANAGED_CLASS_LABELS: Record<UnmanagedClass, string> = {
  "legacy-of-managed": "Legacy copy of a Spoolfree printer",
  "other-network": "Other network printer",
  "print-server-connection": "Print server connection",
  dead: "Dead (port or device gone)",
  virtual: "Virtual printer",
  "local-usb": "USB / local",
};
