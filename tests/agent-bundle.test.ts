import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_BUNDLE_FILES,
  agentUpdateOffer,
  buildAgentBundle,
  encodeAgentBundle,
  isAgentOutdated,
  parseAgentVersion,
  sha256,
  signAgentBundle,
} from "@/lib/agent-bundle";
import { generateSeed, privateKeyFromSeed, publicKeyRaw, verifyBytes } from "@/lib/crypto/signing";
import { buildManifest, signManifest } from "@/lib/manifest";
import { resolvePrinters } from "@/lib/resolve";

const repoAgent = path.resolve(import.meta.dirname, "../agent");
const key = privateKeyFromSeed(generateSeed().seed);
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };

describe("agent bundle", () => {
  it("builds from the repo's agent scripts, at the package version, with the fixed file list", () => {
    const b = buildAgentBundle(repoAgent)!;
    expect(b.version).toBe(pkg.version);
    expect(b.files).toEqual([...AGENT_BUNDLE_FILES]);
    expect(b.sha256).toBe(sha256(b.bytes));
    const doc = JSON.parse(b.bytes.toString("utf8"));
    expect(doc).toMatchObject({ type: "spoolfree-agent-bundle", format: 1, version: pkg.version });
    for (const f of doc.files) {
      const content = Buffer.from(f.content, "base64");
      expect(content.equals(readFileSync(path.join(repoAgent, f.name)))).toBe(true);
      expect(f.sha256).toBe(sha256(content));
    }
    // The launcher is installed by the GPO installer only, never by self-update.
    expect(b.files).not.toContain("Start-SpoolfreeSync.ps1");
  });

  it("is deterministic and signed over the exact bytes with the manifest key", () => {
    const a = buildAgentBundle(repoAgent)!;
    const b = buildAgentBundle(repoAgent)!;
    expect(a.bytes.equals(b.bytes)).toBe(true);
    const s = signAgentBundle(a, key);
    expect(verifyBytes(publicKeyRaw(key), s.bytes, Buffer.from(s.signature, "base64"))).toBe(true);
    const tampered = Buffer.from(s.bytes);
    tampered[10] ^= 1;
    expect(verifyBytes(publicKeyRaw(key), tampered, Buffer.from(s.signature, "base64"))).toBe(false);
  });

  it("refuses unknown or duplicate file names and bad versions", () => {
    const f = (name: string) => ({ name, content: Buffer.from("x") });
    expect(() => encodeAgentBundle("1.2.3", [f("evil.ps1")])).toThrow(/unexpected/);
    expect(() => encodeAgentBundle("1.2.3", [f("../Spoolfree.Agent.psm1")])).toThrow(/unexpected/);
    expect(() => encodeAgentBundle("1.2.3", [f("Invoke-SpoolfreeSync.ps1"), f("Invoke-SpoolfreeSync.ps1")])).toThrow(/duplicate/);
    expect(() => encodeAgentBundle("1.2", [f("Invoke-SpoolfreeSync.ps1")])).toThrow(/invalid/);
  });

  it("returns null without the scripts, and reads the module's declared version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-agent-"));
    try {
      expect(buildAgentBundle(path.join(dir, "missing"))).toBeNull();
      writeFileSync(path.join(dir, "Spoolfree.Agent.psm1"), "Set-StrictMode -Version 2.0\n$script:AgentVersion = '7.8.9'\n");
      expect(buildAgentBundle(dir)).toBeNull(); // required files missing
      writeFileSync(path.join(dir, "Invoke-SpoolfreeSync.ps1"), "exit 0\n");
      writeFileSync(path.join(dir, "Set-SpoolfreeUserDefault.ps1"), "#\n");
      writeFileSync(path.join(dir, "notes.txt"), "ignored\n");
      const b = buildAgentBundle(dir)!;
      expect(b.version).toBe("7.8.9");
      expect(b.files).toEqual(["Spoolfree.Agent.psm1", "Invoke-SpoolfreeSync.ps1", "Set-SpoolfreeUserDefault.ps1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(parseAgentVersion("# $script:AgentVersion = '1.0.0'")).toBeNull();
    expect(parseAgentVersion("$script:AgentVersion = '1.0.0'")).toBe("1.0.0");
  });

  it("flags agents older than the bundled version only", () => {
    expect(isAgentOutdated("0.4.2", "0.4.3")).toBe(true);
    expect(isAgentOutdated("0.4.9", "0.4.10")).toBe(true);
    expect(isAgentOutdated("0.4.3", "0.4.3")).toBe(false);
    expect(isAgentOutdated("0.5.0", "0.4.3")).toBe(false);
    expect(isAgentOutdated(undefined, "0.4.3")).toBe(false);
    expect(isAgentOutdated("0.4.2", null)).toBe(false);
    expect(isAgentOutdated("dev", "0.4.3")).toBe(false);
  });
});

describe("manifest offers the agent bundle", () => {
  const OU = "OU=Staff,DC=example,DC=org";
  const computer = { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", dn: `CN=PC1,${OU}`, name: "PC1" };
  const resolution = resolvePrinters({ baseDn: "DC=example,DC=org", assignments: [], ouSettings: [], overrides: [] }, computer);
  const base = { resolution, printers: new Map(), computer, now: new Date("2026-11-06T00:00:00Z"), ttlHours: 24, serial: "s" };

  it("carries agentVersion, the bundle hash, size and signature inside the signed payload", () => {
    const bundle = signAgentBundle(buildAgentBundle(repoAgent)!, key);
    const m = buildManifest({ ...base, agentUpdate: agentUpdateOffer(bundle, false) });
    expect(m.agentVersion).toBe(bundle.version);
    expect(m.agentBundle).toEqual({ sha256: bundle.sha256, size: bundle.size, signature: bundle.signature });
    expect(m.agentAllowDowngrade).toBe(false);
    const signed = signManifest(m, key);
    const payload = JSON.parse(Buffer.from(signed.payload, "base64").toString("utf8"));
    expect(payload.agentBundle.sha256).toBe(bundle.sha256);
    expect(buildManifest({ ...base, agentUpdate: agentUpdateOffer(bundle, true) }).agentAllowDowngrade).toBe(true);
  });

  it("omits the fields when self-update is off", () => {
    const m = buildManifest(base);
    expect(m).not.toHaveProperty("agentVersion");
    expect(m).not.toHaveProperty("agentBundle");
    expect(m).not.toHaveProperty("agentAllowDowngrade");
  });
});
