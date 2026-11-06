import type { KeyObject } from "node:crypto";
import { normalizeMac, normalizeUuid } from "./identity";
import { printerUri } from "./ipp/interpret";
import type { Resolution } from "./resolve";
import { keyId, publicKeyRaw, randomToken, signBytes } from "./crypto/signing";

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
  defaultSides?: "auto" | "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  deviceUuid?: string | null;
  macAddresses?: string[];
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
  };
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
