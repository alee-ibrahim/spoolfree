import type { KeyObject } from "node:crypto";
import { manifestAliases } from "./aliases";
import { normalizeMac, normalizeUuid } from "./identity";
import { printerUri } from "./ipp/interpret";
import type { Resolution } from "./resolve";
import type { AgentUpdateOffer } from "./agent-bundle";
import type { DriverDecision, PackageForMatch } from "./drivers/auto";
import type { DriverInf } from "./db/schema";
import { keyId, publicKeyRaw, randomToken, signBytes } from "./crypto/signing";
import type { SignedCommand } from "./test-print/command";

export const MANIFEST_SCHEMA = 1;

export interface ManifestPrinterInput {
  id: string;
  name: string;
  host: string;
  port: number;
  ippPath: string;
  useTls: boolean;
  model: string | null;
  location: string | null;
  revision: number;
  legacyTakeover?: "off" | "dry-run" | "on";
  legacyShares?: string[];
  legacyAliases?: string[];
  defaultSides?: "auto" | "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  deviceUuid?: string | null;
  macAddresses?: string[];
  /** The resolved driver (src/lib/drivers/auto.ts); absent or driverless = IPP Class Driver. */
  driver?: DriverDecision | null;
}

/** Vendor driver for a queue (agents 0.7+; older agents ignore it and create the driverless queue). */
export interface ManifestDriver {
  mode: "vendor";
  /** Driver package to download from url (machine token); the agent checks sha256 and size before using it. */
  packageId: string;
  packageName: string;
  sha256: string;
  size: number;
  url: string;
  /** Add-PrinterDriver -Name, the INF and its catalog (paths inside the zip, "/" separators). */
  driverName: string;
  inf: string;
  catalog: string;
  /** Port: raw9100 (Standard TCP/IP RAW, port 9100), lpr (Standard TCP/IP LPR, lprQueue) or ipp (ippUrl). */
  protocol: "raw9100" | "lpr" | "ipp";
  lprQueue: string | null;
}

export interface ManifestPrinter {
  id: string;
  /** Windows queue name. Stable across "Replace". */
  name: string;
  /** ipp:// or ipps:// URI. */
  ippUri: string;
  /** http:// or https:// form of the same endpoint, used with Add-Printer -IppURL. */
  ippUrl: string;
  host: string;
  model: string | null;
  location: string | null;
  /** Bumped whenever the endpoint changes; the agent re-creates the queue on change. */
  revision: number;
  isDefault: boolean;
  /** Legacy queue takeover for this device (agents 0.4+; older agents ignore it). */
  legacy?: { mode: "off" | "dry-run" | "on"; shares: string[] };
  /** Default duplex for the queue (agents 0.4+): auto | one-sided | two-sided-long-edge | two-sided-short-edge. */
  defaultSides?: "auto" | "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  /**
   * Device identity for legacy queue takeover (agents 0.4.2+): the IPP printer-uuid (bare, lower-case), which
   * WSD/IPP ports store, and MAC addresses (12 lower-case hex digits), which Brother default host names embed.
   */
  deviceUuid?: string | null;
  macAddresses?: string[];
  /**
   * Old host names of the device (agents 0.5+): a legacy TCP/IP port whose host equals one of them (case-insensitive,
   * ".local" optional) is a queue for this device. Lower-case; empty unless takeover is on or dry-run.
   */
  legacyAliases?: string[];
  /** Agents 0.7+: "vendor" with driver set, or "driverless" (the IPP Class Driver). */
  driverMode?: "driverless" | "vendor";
  driver?: ManifestDriver;
  /**
   * Agents 0.8.1+, driverless printers only: the vendor driver a PC uses when Add-Printer -IppURL fails on it (per-PC
   * vendor fallback, make-before-break; PCs where driverless works stay driverless). Same checks as driver. Older
   * agents ignore it.
   */
  fallbackDriver?: ManifestDriver;
}

/** Print analytics settings for agents (0.5+). */
export interface ManifestAnalytics {
  enabled: boolean;
  collectDocumentNames: boolean;
}

export interface ManifestPayload {
  schema: number;
  serial: string;
  issuedAt: string;
  expiresAt: string;
  computer: { objectGuid: string; dn: string; name: string };
  printers: ManifestPrinter[];
  defaultPrinter: string | null;
  syncIntervalMinutes: number;
  /** Print servers whose \\server\share connections count as legacy queues (LEGACY_PRINT_SERVERS). */
  legacyPrintServers?: string[];
  /**
   * Ids of every printer on this server (agents 0.4.2+). A queue with a "Managed by Spoolfree" comment whose
   * printer id is not in this list, and that carries no server key, was created by another Spoolfree server.
   */
  serverPrinterIds?: string[];
  /** Agent self-update (agents 0.4.3+): the agent version the server ships ... */
  agentVersion?: string;
  /** ... its bundle's SHA-256 and size, and the detached Ed25519 signature over the bundle bytes (same key). */
  agentBundle?: { sha256: string; size: number; signature: string };
  /** Agents install an older agentVersion only when this is true (AGENT_ALLOW_DOWNGRADE). */
  agentAllowDowngrade?: boolean;
  /** Print analytics (agents 0.5+): read PrintService event 307 and POST it to /api/agent/jobs. */
  analytics?: ManifestAnalytics;
  /**
   * Agents 0.8+: pending commands (test prints) for this PC, each signed on its own (src/lib/test-print/command.ts).
   * Older agents ignore them.
   */
  commands?: SignedCommand[];
  /** Agents 0.8+: how often to poll /api/agent/commands (minutes; 0 = only at sync). */
  commandPollMinutes?: number;
}

export interface SignedManifest {
  /** base64 of the UTF-8 JSON payload. The signature covers exactly these bytes. */
  payload: string;
  signature: string;
  alg: "Ed25519";
  keyId: string;
}

export function httpUrlFor(p: Pick<ManifestPrinterInput, "host" | "port" | "ippPath" | "useTls">): string {
  return printerUri(p).replace(/^ipps:/, "https:").replace(/^ipp:/, "http:");
}

export function buildManifest(args: {
  resolution: Resolution;
  printers: Map<string, ManifestPrinterInput>;
  computer: { objectGuid: string; dn: string; name: string };
  now: Date;
  ttlHours: number;
  syncIntervalMinutes?: number;
  serial?: string;
  legacyPrintServers?: string[];
  agentUpdate?: AgentUpdateOffer;
  analytics?: ManifestAnalytics;
  commands?: SignedCommand[];
  commandPollMinutes?: number;
}): ManifestPayload {
  const list: ManifestPrinter[] = [];
  for (const r of args.resolution.printers) {
    const p = args.printers.get(r.printerId);
    if (!p) continue;
    list.push({
      id: p.id,
      name: p.name,
      ippUri: printerUri(p),
      ippUrl: httpUrlFor(p),
      host: p.host,
      model: p.model,
      location: p.location,
      revision: p.revision,
      isDefault: r.printerId === args.resolution.defaultPrinterId,
      defaultSides: p.defaultSides ?? "auto",
      deviceUuid: normalizeUuid(p.deviceUuid ?? null),
      macAddresses: [...new Set((p.macAddresses ?? []).map((m) => normalizeMac(m)).filter((m): m is string => m !== null))].sort(),
      legacy: { mode: p.legacyTakeover ?? "off", shares: p.legacyTakeover && p.legacyTakeover !== "off" ? (p.legacyShares ?? []) : [] },
      legacyAliases: p.legacyTakeover && p.legacyTakeover !== "off" ? manifestAliases(p.legacyAliases) : [],
      ...manifestDriver(p.driver ?? null),
    });
  }
  const def = list.find((p) => p.isDefault)?.name ?? null;
  return {
    schema: MANIFEST_SCHEMA,
    serial: args.serial ?? randomToken(12),
    issuedAt: args.now.toISOString(),
    expiresAt: new Date(args.now.getTime() + args.ttlHours * 3600_000).toISOString(),
    computer: args.computer,
    printers: list,
    defaultPrinter: def,
    syncIntervalMinutes: args.syncIntervalMinutes ?? 15,
    legacyPrintServers: args.legacyPrintServers ?? [],
    serverPrinterIds: [...args.printers.keys()].sort(),
    analytics: args.analytics ?? { enabled: false, collectDocumentNames: false },
    commands: args.commands ?? [],
    commandPollMinutes: args.commandPollMinutes ?? 0,
    ...(args.agentUpdate
      ? {
          agentVersion: args.agentUpdate.version,
          agentBundle: { sha256: args.agentUpdate.sha256, size: args.agentUpdate.size, signature: args.agentUpdate.signature },
          agentAllowDowngrade: args.agentUpdate.allowDowngrade,
        }
      : {}),
  };
}

function toManifestDriver(d: Pick<DriverDecision, "protocol" | "lprQueue">, pkg: PackageForMatch, driverName: string, inf: DriverInf): ManifestDriver {
  return {
    mode: "vendor",
    packageId: pkg.id,
    packageName: pkg.name,
    sha256: pkg.sha256,
    size: pkg.size,
    url: `/api/agent/drivers/${pkg.id}`,
    driverName,
    inf: inf.path,
    catalog: inf.catalog,
    protocol: d.protocol,
    lprQueue: d.protocol === "lpr" ? (d.lprQueue ?? "lp") : null,
  };
}

function manifestDriver(d: DriverDecision | null): Pick<ManifestPrinter, "driverMode" | "driver" | "fallbackDriver"> {
  if (!d || d.mode !== "vendor" || !d.package || !d.inf || !d.driverName) {
    const f = d?.fallback;
    return f ? { driverMode: "driverless", fallbackDriver: toManifestDriver(d, f.package, f.driverName, f.inf) } : { driverMode: "driverless" };
  }
  return { driverMode: "vendor", driver: toManifestDriver(d, d.package, d.driverName, d.inf) };
}

export function signManifest(payload: ManifestPayload, privateKey: KeyObject): SignedManifest {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    payload: bytes.toString("base64"),
    signature: signBytes(privateKey, bytes).toString("base64"),
    alg: "Ed25519",
    keyId: keyId(publicKeyRaw(privateKey)),
  };
}
