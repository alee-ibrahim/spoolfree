import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * Ed25519 manifest signing.
 * The private key is stored as base64 of the 32-byte seed (MANIFEST_SIGNING_KEY).
 * The public key the agent pins is base64 of the raw 32-byte key.
 */

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function privateKeyFromSeed(seedB64: string): KeyObject {
  const seed = Buffer.from(seedB64.trim(), "base64");
  if (seed.length !== 32) throw new Error("MANIFEST_SIGNING_KEY must be base64 of a 32-byte Ed25519 seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyRaw(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(jwk.x as string, "base64url");
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function generateSeed(): { seed: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d as string, "base64url");
  return { seed: seed.toString("base64"), publicKey: publicKeyRaw(privateKey).toString("base64") };
}

/** Short identifier so admins can check which key an agent has pinned. */
export function keyId(publicRaw: Buffer): string {
  return createHash("sha256").update(publicRaw).digest("hex").slice(0, 16);
}

export function signBytes(privateKey: KeyObject, data: Buffer): Buffer {
  return sign(null, data, privateKey);
}

export function verifyBytes(publicRaw: Buffer, data: Buffer, signature: Buffer): boolean {
  return verify(null, data, publicKeyFromRaw(publicRaw), signature);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
