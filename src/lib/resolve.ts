import { ancestorChain, normalizeDn } from "./dn";

/**
 * Pure printer-resolution logic. Given the policy (OU assignments, OU
 * settings and per-computer overrides) and a computer's DN, decide which
 * printers the computer gets and which one is default.
 *
 * Rules, applied top-down from the base DN to the computer's parent OU:
 *  1. If an OU has `blockInheritance`, everything inherited so far is dropped
 *     (including the inherited default).
 *  2. Printers listed in the OU's `blockedPrinterIds` are removed from the
 *     inherited set.
 *  3. Printers assigned directly to the OU are added.
 *  4. If the OU names a default printer that is in the set, it becomes the
 *     default. An inherited default that was removed is cleared.
 * Then per-computer overrides apply: `block` removes, `add` adds, and an
 * `add` with `makeDefault` sets the default.
 */

export interface PolicyAssignment {
  ouDn: string;
  printerId: string;
}

export interface PolicyOuSetting {
  ouDn: string;
  blockInheritance: boolean;
  blockedPrinterIds: string[];
  defaultPrinterId: string | null;
}

export interface PolicyOverride {
  computerGuid: string;
  printerId: string;
  action: "add" | "block";
  makeDefault: boolean;
}

export interface Policy {
  baseDn: string;
  assignments: PolicyAssignment[];
  ouSettings: PolicyOuSetting[];
  overrides: PolicyOverride[];
}

export type Source =
  | { kind: "ou"; ouDn: string }
  | { kind: "computer" };

export interface ResolvedPrinter {
  printerId: string;
  source: Source;
}

export interface TraceStep {
  ouDn: string;
  blockedInheritance: boolean;
  blocked: string[];
  added: string[];
  defaultSet: string | null;
}

export interface Resolution {
  printers: ResolvedPrinter[];
  defaultPrinterId: string | null;
  trace: TraceStep[];
  overridesApplied: PolicyOverride[];
}

export interface ComputerRef {
  dn: string;
  objectGuid?: string | null;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function resolvePrinters(policy: Policy, computer: ComputerRef): Resolution {
  const chain = ancestorChain(computer.dn, policy.baseDn);
  const assignmentsByOu = groupBy(policy.assignments, (a) => normalizeDn(a.ouDn));
  const settingsByOu = new Map(policy.ouSettings.map((s) => [normalizeDn(s.ouDn), s]));

  // Insertion-ordered so output is stable: inherited first, then nearer OUs.
  const current = new Map<string, Source>();
  let defaultId: string | null = null;
  const trace: TraceStep[] = [];

  for (const ou of chain) {
    const key = normalizeDn(ou);
    const settings = settingsByOu.get(key);
    const step: TraceStep = { ouDn: ou, blockedInheritance: false, blocked: [], added: [], defaultSet: null };

    if (settings?.blockInheritance) {
      current.clear();
      defaultId = null;
      step.blockedInheritance = true;
    }
    for (const pid of settings?.blockedPrinterIds ?? []) {
      if (current.delete(pid)) step.blocked.push(pid);
    }
    for (const a of assignmentsByOu.get(key) ?? []) {
      if (!current.has(a.printerId)) step.added.push(a.printerId);
      current.set(a.printerId, { kind: "ou", ouDn: ou });
    }
    if (defaultId && !current.has(defaultId)) defaultId = null;
    if (settings?.defaultPrinterId && current.has(settings.defaultPrinterId)) {
      defaultId = settings.defaultPrinterId;
      step.defaultSet = defaultId;
    }
    trace.push(step);
  }

  const guid = computer.objectGuid?.toLowerCase();
  const overridesApplied: PolicyOverride[] = [];
  if (guid) {
    const mine = policy.overrides.filter((o) => o.computerGuid.toLowerCase() === guid);
    // Blocks first, then adds: an explicit add for the same printer wins.
    for (const o of mine.filter((o) => o.action === "block")) {
      current.delete(o.printerId);
      overridesApplied.push(o);
    }
    for (const o of mine.filter((o) => o.action === "add")) {
      if (!current.has(o.printerId)) current.set(o.printerId, { kind: "computer" });
      if (o.makeDefault) defaultId = o.printerId;
      overridesApplied.push(o);
    }
    if (defaultId && !current.has(defaultId)) defaultId = null;
  }

  return {
    printers: [...current.entries()].map(([printerId, source]) => ({ printerId, source })),
    defaultPrinterId: defaultId,
    trace,
    overridesApplied,
  };
}

/** OUs (from `ous`) whose computers would get no printers from OU policy. */
export function ousWithoutPrinters(policy: Policy, ous: string[]): string[] {
  return ous.filter((ou) => {
    // A synthetic computer directly inside the OU.
    const r = resolvePrinters({ ...policy, overrides: [] }, { dn: `CN=__probe__,${ou}` });
    return r.printers.length === 0;
  });
}
