import type { KeyObject } from "node:crypto";
import { keyId, publicKeyRaw, signBytes, verifyBytes } from "../crypto/signing";
import { TEST_PRINT_FINAL, type TestPrintState } from "../db/schema";

/**
 * Signed agent commands (0.8): a test print "from a PC". Each command is signed on its own with the manifest key, over
 * a domain prefix + the JSON payload, so a command can never be mistaken for a manifest or an agent bundle (those are
 * signed over their raw JSON) and the reverse.
 */

export const COMMAND_SIGNING_PREFIX = "spoolfree-command-v1\n";
export const COMMAND_KIND = "spoolfree-command";
/** The first agent version that runs commands. */
export const COMMAND_MIN_AGENT_VERSION = "0.8.0";

export interface CommandPayload {
  kind: typeof COMMAND_KIND;
  v: 1;
  /** The test print id; agents run each id once. */
  id: string;
  type: "test-print";
  computer: { objectGuid: string; name: string };
  /** The Spoolfree queue to print through: agents only accept a printer id + queue name they manage. */
  printer: { id: string; name: string };
  issuedAt: string;
  expiresAt: string;
}

export interface SignedCommand {
  /** base64 of the UTF-8 JSON payload. */
  payload: string;
  /** Ed25519 over COMMAND_SIGNING_PREFIX + the payload bytes. */
  signature: string;
  alg: "Ed25519";
  keyId: string;
}

export function commandSigningBytes(payloadBytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(COMMAND_SIGNING_PREFIX, "utf8"), payloadBytes]);
}

export function signCommand(payload: CommandPayload, privateKey: KeyObject): SignedCommand {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    payload: bytes.toString("base64"),
    signature: signBytes(privateKey, commandSigningBytes(bytes)).toString("base64"),
    alg: "Ed25519",
    keyId: keyId(publicKeyRaw(privateKey)),
  };
}

/** The checks agents do (agent/Spoolfree.Agent.psm1 ConvertFrom-SpoolfreeCommand), for tests and tooling. */
export function verifyCommand(signed: SignedCommand, publicRaw: Buffer, objectGuid: string, now = new Date()): CommandPayload {
  const bytes = Buffer.from(signed.payload, "base64");
  if (!verifyBytes(publicRaw, commandSigningBytes(bytes), Buffer.from(signed.signature, "base64"))) throw new Error("command signature is invalid");
  const p = JSON.parse(bytes.toString("utf8")) as CommandPayload;
  if (p.kind !== COMMAND_KIND || p.v !== 1) throw new Error("not a Spoolfree command");
  if (p.type !== "test-print") throw new Error(`unknown command type ${p.type}`);
  if (p.computer?.objectGuid?.toLowerCase() !== objectGuid.toLowerCase()) throw new Error("command is for a different computer");
  if (!(new Date(p.expiresAt).getTime() > now.getTime())) throw new Error("command expired");
  return p;
}

/** Results an agent may report, and the states they move a test print to. */
export const AGENT_RESULT_STATES = ["sent", "printing", "printed", "failed", "rejected"] as const;
export type AgentResultState = (typeof AGENT_RESULT_STATES)[number];

const ORDER: Record<TestPrintState, number> = { queued: 0, delivered: 1, sent: 2, printing: 3, printed: 4, failed: 4, expired: 4, rejected: 4 };

/**
 * Whether a test print may move from one state to another: forward only, never out of a final state, except that a
 * command delivered before it expired may still report its result (the agent checked the expiry when it ran it).
 */
export function canTransition(from: TestPrintState, to: TestPrintState, delivered: boolean): boolean {
  if (from === to) return false;
  if (TEST_PRINT_FINAL.includes(from)) return from === "expired" && delivered && to !== "expired" && to !== "queued" && to !== "delivered";
  return ORDER[to] > ORDER[from];
}

/** Pure: "a.b.c" >= "x.y.z". */
export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(min);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return true;
}
