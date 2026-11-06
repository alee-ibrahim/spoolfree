import { createHash, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { signBytes } from "./crypto/signing";

/**
 * Agent self-update bundle (agents 0.4.3+).
 *
 * The bundle is one UTF-8 JSON document: { type, format, version, files: [{ name, sha256, content(base64) }] }.
 * Agents check its SHA-256 against the signed manifest and an Ed25519 signature over the exact bytes (same key as the
 * manifest) before they install it. JSON instead of a zip: Windows PowerShell 5.1 parses it without extra code, and
 * there are no paths to escape (file names come from a fixed list, no directories).
 */

export const AGENT_BUNDLE_TYPE = "spoolfree-agent-bundle";
export const AGENT_BUNDLE_FORMAT = 1;
/** Files a bundle carries; the agent refuses any other name. The launcher (Start-SpoolfreeSync.ps1) is never self-updated. */
export const AGENT_BUNDLE_FILES = ["Spoolfree.Agent.psm1", "Invoke-SpoolfreeSync.ps1", "Set-SpoolfreeUserDefault.ps1", "Install-SpoolfreeAgent.ps1"] as const;
export const AGENT_BUNDLE_REQUIRED = ["Spoolfree.Agent.psm1", "Invoke-SpoolfreeSync.ps1", "Set-SpoolfreeUserDefault.ps1"] as const;
/** Same limit as the agent (4 MiB). */
export const AGENT_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;

export interface AgentBundle {
  version: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  files: string[];
}

export interface SignedAgentBundle extends AgentBundle {
  /** base64 Ed25519 signature over `bytes`. */
  signature: string;
}

/** The version a Spoolfree.Agent.psm1 declares (`$script:AgentVersion = 'x.y.z'`), or null. */
export function parseAgentVersion(psm1: string): string | null {
  const m = /^\$script:AgentVersion\s*=\s*'(\d+\.\d+\.\d+)'/m.exec(psm1);
  return m ? m[1] : null;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Serializes a bundle. Files keep the given order; names must be from AGENT_BUNDLE_FILES. */
export function encodeAgentBundle(version: string, files: { name: string; content: Buffer }[]): AgentBundle {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid agent version '${version}'`);
  const seen = new Set<string>();
  for (const f of files) {
    if (!(AGENT_BUNDLE_FILES as readonly string[]).includes(f.name)) throw new Error(`unexpected agent file '${f.name}'`);
    if (seen.has(f.name)) throw new Error(`duplicate agent file '${f.name}'`);
    seen.add(f.name);
  }
  const doc = {
    type: AGENT_BUNDLE_TYPE,
    format: AGENT_BUNDLE_FORMAT,
    version,
    files: files.map((f) => ({ name: f.name, sha256: sha256(f.content), content: f.content.toString("base64") })),
  };
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  if (bytes.length > AGENT_BUNDLE_MAX_BYTES) throw new Error("agent bundle is larger than 4 MiB");
  return { version, bytes, sha256: sha256(bytes), size: bytes.length, files: files.map((f) => f.name) };
}

/**
 * Builds the bundle from a directory holding the agent scripts (the image ships them in /app/agent). Returns null
 * when the directory or a required file is missing. The version is the one Spoolfree.Agent.psm1 declares.
 */
export function buildAgentBundle(dir: string): AgentBundle | null {
  if (!existsSync(dir)) return null;
  for (const r of AGENT_BUNDLE_REQUIRED) if (!existsSync(path.join(dir, r))) return null;
  const files = AGENT_BUNDLE_FILES.filter((n) => existsSync(path.join(dir, n))).map((name) => ({ name, content: readFileSync(path.join(dir, name)) }));
  const version = parseAgentVersion(files.find((f) => f.name === "Spoolfree.Agent.psm1")!.content.toString("utf8"));
  if (!version) throw new Error(`${dir}/Spoolfree.Agent.psm1 declares no agent version`);
  return encodeAgentBundle(version, files);
}

export function signAgentBundle(bundle: AgentBundle, privateKey: KeyObject): SignedAgentBundle {
  return { ...bundle, signature: signBytes(privateKey, bundle.bytes).toString("base64") };
}

/** Manifest fields that offer the bundle (agents 0.4.3+; older agents ignore them). */
export interface AgentUpdateOffer {
  version: string;
  sha256: string;
  size: number;
  signature: string;
  allowDowngrade: boolean;
}

export function agentUpdateOffer(bundle: SignedAgentBundle, allowDowngrade: boolean): AgentUpdateOffer {
  return { version: bundle.version, sha256: bundle.sha256, size: bundle.size, signature: bundle.signature, allowDowngrade };
}

/** Pure: does a reported agent version lag behind the bundled one? Unknown or unparsable versions are not flagged. */
export function isAgentOutdated(reported: string | null | undefined, latest: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => (v && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(reported);
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
