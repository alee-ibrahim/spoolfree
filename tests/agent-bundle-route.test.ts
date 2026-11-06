import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@/lib/agent-bundle";
import { generateSeed, verifyBytes } from "@/lib/crypto/signing";

const repoAgent = path.resolve(import.meta.dirname, "../agent");
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/agent-auth", () => {
  class AgentAuthError extends Error {
    constructor(
      message: string,
      public status = 401,
    ) {
      super(message);
    }
  }
  return {
    AgentAuthError,
    authenticateAgent: async (req: Request) => {
      if (!auth.ok || req.headers.get("authorization") !== "Bearer machine-token-0123456789") throw new AgentAuthError("unauthorized");
      return { agent: { id: "a1" }, computer: {} };
    },
  };
});
describe("GET /api/agent/bundle", () => {
  const seed = generateSeed();
  const saved = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...saved, MANIFEST_SIGNING_KEY: seed.seed, AGENT_BUNDLE_DIR: repoAgent };
    delete process.env.AGENT_SELF_UPDATE;
  });
  afterAll(() => {
    process.env = saved;
  });

  const get = async (token?: string) => {
    const { GET } = await import("@/app/api/agent/bundle/route");
    return GET(new Request("https://spoolfree.example.org/api/agent/bundle", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  };

  it("serves the signed bundle to an enrolled agent", async () => {
    const res = await get("machine-token-0123456789");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(sha256(bytes)).toBe(res.headers.get("x-spoolfree-bundle-sha256"));
    expect(res.headers.get("x-spoolfree-agent-version")).toBe(pkg.version);
    const sig = Buffer.from(res.headers.get("x-spoolfree-bundle-signature")!, "base64");
    expect(verifyBytes(Buffer.from(seed.publicKey, "base64"), bytes, sig)).toBe(true);
    // The manifest offers exactly these bytes.
    const { agentUpdateForManifest } = await import("@/lib/agent-update");
    expect(agentUpdateForManifest()).toMatchObject({ version: pkg.version, sha256: sha256(bytes), size: bytes.length, allowDowngrade: false });
  });

  it("refuses requests without a valid machine token", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("someone-elses-token-000000")).status).toBe(401);
  });

  it("answers 404 when self-update is off or the scripts are missing", async () => {
    process.env.AGENT_SELF_UPDATE = "false";
    expect((await get("machine-token-0123456789")).status).toBe(404);
    const { agentUpdateForManifest } = await import("@/lib/agent-update");
    expect(agentUpdateForManifest()).toBeUndefined();
    vi.resetModules();
    process.env.AGENT_SELF_UPDATE = "true";
    process.env.AGENT_BUNDLE_DIR = path.join(tmpdir(), "spoolfree-no-such-dir");
    expect((await get("machine-token-0123456789")).status).toBe(404);
  });
});
