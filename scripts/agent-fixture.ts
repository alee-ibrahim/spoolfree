/**
 * Regenerates agent/tests/fixtures/signed-manifest.json, signed-bundle.json and signed-commands.json for the Pester tests.
 * Uses the RFC 8032 test-vector-1 key: public, documented, never use it for real.
 */
import { writeFileSync } from "node:fs";
import { privateKeyFromSeed, publicKeyRaw } from "../src/lib/crypto/signing";
import { signManifest, type ManifestPayload } from "../src/lib/manifest";
import { encodeAgentBundle, sha256, signAgentBundle } from "../src/lib/agent-bundle";
import { signCommand, type CommandPayload } from "../src/lib/test-print/command";

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

// Self-update bundles (agents 0.4.3+), signed with the same test key. "other" uses the RFC 8032 test-vector-2 key.
const otherKey = privateKeyFromSeed(Buffer.from("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "hex").toString("base64"));
const file = (name: string, text: string) => ({ name, content: Buffer.from(text, "utf8") });
const files = (version: string) => [
  file("Spoolfree.Agent.psm1", `Set-StrictMode -Version 2.0\n$script:AgentVersion = '${version}'\nfunction Get-SpoolfreeAgentVersion { return $script:AgentVersion }\n`),
  file("Invoke-SpoolfreeSync.ps1", "exit 0\n"),
  file("Set-SpoolfreeUserDefault.ps1", "# user default\n"),
];
const entry = (b: ReturnType<typeof encodeAgentBundle>, k = key) => {
  const s = signAgentBundle(b, k);
  return { version: s.version, sha256: s.sha256, signature: s.signature, bytes: s.bytes.toString("base64") };
};
// A bundle whose JSON names a file outside the allowed list (hand-built: encodeAgentBundle refuses it).
const evilDoc = Buffer.from(
  JSON.stringify({
    type: "spoolfree-agent-bundle",
    format: 1,
    version: "9.9.9",
    files: [...files("9.9.9"), file("evil.ps1", "calc\n")].map((f) => ({ name: f.name, sha256: sha256(f.content), content: f.content.toString("base64") })),
  }),
  "utf8",
);
const evil = { version: "9.9.9", bytes: evilDoc, sha256: sha256(evilDoc), size: evilDoc.length, files: [] };
writeFileSync(
  "agent/tests/fixtures/signed-bundle.json",
  JSON.stringify(
    {
      publicKey: publicKeyRaw(key).toString("base64"),
      valid: entry(encodeAgentBundle("9.9.9", files("9.9.9"))),
      otherKey: entry(encodeAgentBundle("9.9.9", files("9.9.9")), otherKey),
      wrongModuleVersion: entry(encodeAgentBundle("9.9.9", files("9.9.8"))),
      unknownFile: entry(evil),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote agent/tests/fixtures/signed-bundle.json");

// Signed commands (agents 0.8+): test prints, same test key. Each envelope is signed over the domain prefix.
const command = (over: Partial<CommandPayload> = {}): CommandPayload => ({
  kind: "spoolfree-command",
  v: 1,
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  type: "test-print",
  computer: { objectGuid: payload.computer.objectGuid, name: "PC1" },
  printer: { id: "p1", name: "Staff Copier" },
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...over,
});
writeFileSync(
  "agent/tests/fixtures/signed-commands.json",
  JSON.stringify(
    {
      publicKey: publicKeyRaw(key).toString("base64"),
      valid: signCommand(command(), key),
      second: signCommand(command({ id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302", printer: { id: "p2", name: "Lab Colour" } }), key),
      expired: signCommand(command({ id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303", expiresAt: "2020-01-01T00:00:00.000Z" }), key),
      otherComputer: signCommand(command({ computer: { objectGuid: "11111111-2222-3333-4444-555555555555", name: "PC2" } }), key),
      otherKey: signCommand(command(), otherKey),
      unknownType: signCommand({ ...command(), type: "run-script" } as unknown as CommandPayload, key),
      // A manifest envelope is never accepted as a command (no prefix in its signature), and the reverse.
      manifest: signManifest(payload, key),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote agent/tests/fixtures/signed-commands.json");
