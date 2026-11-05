/**
 * Regenerates agent/tests/fixtures/signed-manifest.json for the Pester tests.
 * Uses the RFC 8032 test-vector-1 key: public, documented, never use it for real.
 */
import { writeFileSync } from "node:fs";
import { privateKeyFromSeed, publicKeyRaw } from "../src/lib/crypto/signing";
import { signManifest, type ManifestPayload } from "../src/lib/manifest";

const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64");
const key = privateKeyFromSeed(seed);
const payload: ManifestPayload = {
  schema: 1,
  serial: "fixture-1",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  computer: { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", dn: "CN=PC1,OU=Staff,DC=example,DC=org", name: "PC1" },
  printers: [
    { id: "p1", name: "Staff Copier", ippUri: "ipp://192.0.2.10:631/ipp/print", ippUrl: "http://192.0.2.10:631/ipp/print", host: "192.0.2.10", model: "Acme", location: "Room 1", revision: 2, isDefault: true },
    { id: "p2", name: "Lab Colour – Ünïcode", ippUri: "ipps://192.0.2.11:443/ipp/print", ippUrl: "https://192.0.2.11:443/ipp/print", host: "192.0.2.11", model: null, location: null, revision: 1, isDefault: false },
  ],
  defaultPrinter: "Staff Copier",
  syncIntervalMinutes: 60,
};
const expired = { ...payload, serial: "fixture-expired", expiresAt: "2020-01-01T00:00:00.000Z" };
writeFileSync(
  "agent/tests/fixtures/signed-manifest.json",
  JSON.stringify({ publicKey: publicKeyRaw(key).toString("base64"), valid: signManifest(payload, key), expired: signManifest(expired, key) }, null, 2) + "\n",
);
console.log("wrote agent/tests/fixtures/signed-manifest.json");
