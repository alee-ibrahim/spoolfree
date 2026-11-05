import { z } from "zod";
import { dnEquals, isUnder, normalizeDn, rdnValue } from "../dn";
import { isGuid, normalizeGuid } from "./guid";
import { DirectoryUnavailableError, type ComputerObject, type Directory, type OuNode } from "./types";

/**
 * DIRECTORY_MODE=snapshot: the app never talks to a domain controller. The adsync sidecar
 * (adsync/ in this repository) reads AD over Kerberos and pushes a full snapshot to
 * POST /api/internal/directory-snapshot; it is stored in Postgres and everything that
 * needs AD (OU tree, computer lists, agent enrollment and manifest checks) reads it.
 */

const UAC_ACCOUNTDISABLE = 0x2;
const MAX_TEXT = 2048;

const dn = z.string().trim().min(3).max(MAX_TEXT);
const guid = z.string().refine(isGuid, "invalid objectGuid").transform(normalizeGuid);
const optText = z
  .string()
  .max(MAX_TEXT)
  .nullish()
  .transform((v) => (v ? v : null));

export const SnapshotPayload = z.object({
  version: z.literal(1),
  /** The domain controller it was read from (informational). */
  source: z.string().max(255).optional(),
  collectedAt: z.string().max(64).optional(),
  baseDn: dn,
  defaultComputersContainer: dn.optional(),
  ous: z
    .array(z.object({ dn, name: z.string().max(MAX_TEXT).optional(), objectGuid: guid.optional(), description: optText }))
    .max(50_000),
  computers: z
    .array(
      z.object({
        dn: dn.regex(/^CN=[^,]+,.+/i, "computer dn must start with CN=<name>,"),
        objectGuid: guid,
        name: z.string().max(255).optional(),
        dnsHostName: optText,
        operatingSystem: optText,
        userAccountControl: z.number().int().min(0).max(0xffffffff),
      }),
    )
    .max(200_000),
});
export type SnapshotPayload = z.input<typeof SnapshotPayload>;

export const SyncErrorPayload = z.object({
  version: z.literal(1),
  status: z.literal("error"),
  source: z.string().max(255).optional(),
  error: z.string().min(1).max(4000),
});

export interface SnapshotOu {
  dn: string;
  objectGuid: string | null;
  name: string;
  description: string | null;
}

export interface SnapshotComputer {
  objectGuid: string;
  dn: string;
  name: string;
  dnsHostName: string | null;
  operatingSystem: string | null;
  userAccountControl: number;
  disabled: boolean;
}

export interface Snapshot {
  baseDn: string;
  defaultContainer: string;
  source: string | null;
  ous: SnapshotOu[];
  computers: SnapshotComputer[];
}

export interface SyncStatus {
  baseDn: string | null;
  defaultContainer: string | null;
  syncedAt: Date | null;
  source: string | null;
  ouCount: number;
  computerCount: number;
  lastErrorAt: Date | null;
  lastError: string | null;
}

export class SnapshotRejected extends Error {}

/**
 * Validates a pushed snapshot and turns it into rows. Throws SnapshotRejected (or a ZodError)
 * instead of storing anything doubtful: a wrong base DN, objects outside it, duplicates or an
 * empty computer list would otherwise lock every agent out or hand PCs the wrong printers.
 */
export function parseSnapshot(input: unknown, expectedBaseDn: string): Snapshot {
  const p = SnapshotPayload.parse(input);
  if (!dnEquals(p.baseDn, expectedBaseDn)) {
    throw new SnapshotRejected(`snapshot base DN ${p.baseDn} does not match LDAP_BASE_DN ${expectedBaseDn}`);
  }
  if (p.computers.length === 0) throw new SnapshotRejected("snapshot has no computers; refusing to replace the directory");

  const outside = (d: string) => !isUnder(d, p.baseDn);
  const ous: SnapshotOu[] = [];
  const seenOu = new Set<string>();
  for (const o of p.ous) {
    if (outside(o.dn)) throw new SnapshotRejected(`OU outside the base DN: ${o.dn}`);
    const key = normalizeDn(o.dn);
    if (seenOu.has(key)) throw new SnapshotRejected(`duplicate OU: ${o.dn}`);
    seenOu.add(key);
    ous.push({ dn: o.dn, objectGuid: o.objectGuid ?? null, name: o.name || rdnValue(o.dn), description: o.description });
  }

  const computers: SnapshotComputer[] = [];
  const seenGuid = new Set<string>();
  const seenDn = new Set<string>();
  for (const c of p.computers) {
    if (outside(c.dn)) throw new SnapshotRejected(`computer outside the base DN: ${c.dn}`);
    if (seenGuid.has(c.objectGuid)) throw new SnapshotRejected(`duplicate objectGuid: ${c.objectGuid}`);
    const key = normalizeDn(c.dn);
    if (seenDn.has(key)) throw new SnapshotRejected(`duplicate computer DN: ${c.dn}`);
    seenGuid.add(c.objectGuid);
    seenDn.add(key);
    computers.push({
      objectGuid: c.objectGuid,
      dn: c.dn,
      name: (c.name || rdnValue(c.dn)).replace(/\$$/, "").toUpperCase(),
      dnsHostName: c.dnsHostName,
      operatingSystem: c.operatingSystem,
      userAccountControl: c.userAccountControl,
      disabled: (c.userAccountControl & UAC_ACCOUNTDISABLE) !== 0,
    });
  }

  const def = p.defaultComputersContainer ?? `CN=Computers,${p.baseDn}`;
  if (outside(def)) throw new SnapshotRejected(`default computers container outside the base DN: ${def}`);
  return { baseDn: p.baseDn, defaultContainer: def, source: p.source ?? null, ous, computers };
}

/** Error messages from the sidecar are shown in the UI: single line, bounded. */
export function sanitizeSyncError(msg: string): string {
  return msg.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e -￿]/g, "").trim().slice(0, 500);
}

export type Freshness =
  | { state: "never"; lastError: string | null; lastErrorAt: Date | null }
  | { state: "fresh" | "stale"; syncedAt: Date; ageMinutes: number; lastError: string | null; lastErrorAt: Date | null };

/**
 * "stale" when the last snapshot is older than staleMinutes. A failed sync after the last good
 * snapshot is reported as lastError (the snapshot itself stays usable until it goes stale).
 */
export function freshness(status: SyncStatus | null, now: Date, staleMinutes: number): Freshness {
  const errorAfterSync =
    status?.lastErrorAt && (!status.syncedAt || status.lastErrorAt.getTime() > status.syncedAt.getTime());
  const lastError = errorAfterSync ? status!.lastError : null;
  const lastErrorAt = errorAfterSync ? status!.lastErrorAt : null;
  if (!status?.syncedAt) return { state: "never", lastError, lastErrorAt };
  const ageMinutes = Math.max(0, (now.getTime() - status.syncedAt.getTime()) / 60_000);
  return { state: ageMinutes > staleMinutes ? "stale" : "fresh", syncedAt: status.syncedAt, ageMinutes, lastError, lastErrorAt };
}

/** Storage behind SnapshotDirectory: Postgres in the app (snapshot-db.ts), memory in tests. */
export interface SnapshotStore {
  replace(snapshot: Snapshot, at: Date): Promise<void>;
  recordError(message: string, source: string | null, at: Date): Promise<void>;
  status(): Promise<SyncStatus | null>;
  listOus(): Promise<SnapshotOu[]>;
  listComputers(): Promise<SnapshotComputer[]>;
  findComputer(guid: string): Promise<SnapshotComputer | null>;
}

export class MemorySnapshotStore implements SnapshotStore {
  snapshot: Snapshot | null = null;
  state: SyncStatus | null = null;

  async replace(snapshot: Snapshot, at: Date) {
    this.snapshot = snapshot;
    this.state = {
      ...(this.state ?? { lastErrorAt: null, lastError: null }),
      baseDn: snapshot.baseDn,
      defaultContainer: snapshot.defaultContainer,
      syncedAt: at,
      source: snapshot.source,
      ouCount: snapshot.ous.length,
      computerCount: snapshot.computers.length,
    };
  }
  async recordError(message: string, source: string | null, at: Date) {
    this.state = {
      ...(this.state ?? { baseDn: null, defaultContainer: null, syncedAt: null, ouCount: 0, computerCount: 0, source }),
      lastErrorAt: at,
      lastError: message,
    };
  }
  async status() {
    return this.state;
  }
  async listOus() {
    return this.snapshot?.ous ?? [];
  }
  async listComputers() {
    return this.snapshot?.computers ?? [];
  }
  async findComputer(g: string) {
    return this.snapshot?.computers.find((c) => c.objectGuid === g) ?? null;
  }
}

function toComputer(c: SnapshotComputer): ComputerObject {
  return {
    dn: c.dn,
    name: c.name,
    objectGuid: c.objectGuid,
    dnsHostName: c.dnsHostName,
    operatingSystem: c.operatingSystem,
    disabled: c.disabled,
  };
}

export class SnapshotDirectory implements Directory {
  constructor(
    private store: SnapshotStore,
    private opts: { baseDn: string; maxAgeHours: number; now?: () => Date },
  ) {}

  private async current(): Promise<SyncStatus & { syncedAt: Date }> {
    const s = await this.store.status();
    if (!s?.syncedAt) {
      throw new DirectoryUnavailableError("No directory snapshot yet: the AD sync sidecar has not delivered one.");
    }
    return s as SyncStatus & { syncedAt: Date };
  }

  async listContainers(): Promise<OuNode[]> {
    const s = await this.current();
    const base = s.baseDn ?? this.opts.baseDn;
    const nodes: OuNode[] = [{ dn: base, name: rdnValue(base), kind: "domain" }];
    for (const o of await this.store.listOus()) {
      nodes.push({ dn: o.dn, name: o.name, kind: "ou", description: o.description });
    }
    const def = s.defaultContainer ?? `CN=Computers,${base}`;
    if (!nodes.some((n) => dnEquals(n.dn, def))) nodes.push({ dn: def, name: rdnValue(def), kind: "container" });
    return nodes;
  }

  async listComputers(): Promise<ComputerObject[]> {
    await this.current();
    return (await this.store.listComputers()).map(toComputer);
  }

  /**
   * Used to authenticate agents. Fails closed when the snapshot is older than
   * DIRECTORY_MAX_AGE_HOURS, so a broken sync cannot keep a disabled computer working forever.
   */
  async findComputerByGuid(g: string): Promise<ComputerObject | null> {
    const s = await this.current();
    const now = (this.opts.now ?? (() => new Date()))();
    const maxMs = this.opts.maxAgeHours * 3600_000;
    if (maxMs > 0 && now.getTime() - s.syncedAt.getTime() > maxMs) {
      throw new DirectoryUnavailableError(
        `Directory snapshot is older than ${this.opts.maxAgeHours} h (DIRECTORY_MAX_AGE_HOURS); agents are refused until the AD sync recovers.`,
      );
    }
    const c = await this.store.findComputer(normalizeGuid(g));
    return c ? toComputer(c) : null;
  }

  async defaultComputersContainer(): Promise<string> {
    const s = await this.current();
    return s.defaultContainer ?? `CN=Computers,${s.baseDn ?? this.opts.baseDn}`;
  }
}
