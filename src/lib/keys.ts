import type { KeyObject } from "node:crypto";
import { config, secretValue } from "./config";
import { keyId, privateKeyFromSeed, publicKeyRaw } from "./crypto/signing";

let cached: { key: KeyObject; publicKey: string; keyId: string } | null = null;

/** Loads MANIFEST_SIGNING_KEY(_FILE). Throws if missing so agents never get unsigned manifests. */
export function signingKey() {
  if (cached) return cached;
  const c = config();
  const seed = secretValue(c.MANIFEST_SIGNING_KEY, c.MANIFEST_SIGNING_KEY_FILE);
  if (!seed) throw new Error("MANIFEST_SIGNING_KEY is not set. Run `pnpm keygen`.");
  const key = privateKeyFromSeed(seed);
  const raw = publicKeyRaw(key);
  cached = { key, publicKey: raw.toString("base64"), keyId: keyId(raw) };
  return cached;
}

export function signingKeyInfo(): { publicKey: string; keyId: string } | { error: string } {
  try {
    const k = signingKey();
    return { publicKey: k.publicKey, keyId: k.keyId };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function enrollmentToken(): string | undefined {
  const c = config();
  return secretValue(c.AGENT_ENROLLMENT_TOKEN, c.AGENT_ENROLLMENT_TOKEN_FILE);
}
