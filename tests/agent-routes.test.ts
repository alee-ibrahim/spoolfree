import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { generateSeed, publicKeyRaw, privateKeyFromSeed, sha256Hex } from "@/lib/crypto/signing";
import { verifyCommand } from "@/lib/test-print/command";

/**
 * Route and server-action checks the 0.8.0 review found untested: the agent command poll (cheap path, token checks,
 * directory check before signing), command results, the report fields of 0.8.1, and that the test-print server
 * actions refuse anyone who is not an admin before touching anything.
 */

const seed = generateSeed();
const pg = vi.hoisted(() => ({ db: null as unknown, admin: false, lookups: 0, computers: new Map<string, { objectGuid: string; dn: string; name: string; disabled: boolean }>() }));

vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});
vi.mock("@/lib/directory", () => ({
  directory: () => ({
    findComputerByGuid: async (guid: string) => {
      pg.lookups++;
      return pg.computers.get(guid.toLowerCase()) ?? null;
    },
  }),
  baseDn: () => "DC=example,DC=org",
}));
vi.mock("@/lib/session", () => ({
  requireAdmin: async () => {
    if (!pg.admin) throw new Error("NEXT_REDIRECT;/login");
    return { name: "admin", email: "admin@example.org", local: false };
  },
}));

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;

const GUID = "11111111-2222-3333-4444-555555555555";
const GUID2 = "66666666-2222-3333-4444-555555555555";
const TOKEN = "machine-token-pc01-0123456789";
const TOKEN2 = "machine-token-pc02-0123456789";

async function addAgent(name: string, guid: string, token: string, extra: Partial<typeof schema.agents.$inferInsert> = {}) {
  const [a] = await d
    .insert(schema.agents)
    .values({ objectGuid: guid, dn: `CN=${name},OU=PCs,DC=example,DC=org`, computerName: name, tokenHash: sha256Hex(token), lastReportAt: new Date(), lastReport: { agentVersion: "0.8.1", applied: ["Sim Laser"] }, ...extra })
    .returning();
  pg.computers.set(guid, { objectGuid: guid, dn: `CN=${name},OU=PCs,DC=example,DC=org`, name, disabled: false });
  return a;
}

async function addPrinter() {
  const lastTest = { ok: true, formats: ["image/pwg-raster"], driverlessFormats: ["image/pwg-raster"], ippVersions: ["2.0"], model: "Sim", uuid: null, features: [], color: false, duplex: true, problems: [] };
  const [p] = await d.insert(schema.printers).values({ name: "Sim Laser", host: "127.0.0.1", port: 631, lastTest, lastTestAt: new Date() }).returning();
  return p;
}

const req = (url: string, token?: string, init: RequestInit = {}) =>
  new Request(`https://spoolfree.example.org${url}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });

beforeAll(async () => {
  process.env.MANIFEST_SIGNING_KEY = seed.seed;
  d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  pg.db = d;
});
beforeEach(async () => {
  await d.delete(schema.auditLog);
  await d.delete(schema.testPrints);
  await d.delete(schema.agents);
  await d.delete(schema.printers);
  pg.computers.clear();
  pg.lookups = 0;
  pg.admin = false;
});

describe("GET /api/agent/commands (the minute poll)", () => {
  const get = async (token?: string) => {
    const { GET } = await import("@/app/api/agent/commands/route");
    return GET(req("/api/agent/commands", token));
  };

  it("refuses missing, unknown and revoked tokens", async () => {
    await addAgent("PC-01", GUID, TOKEN, { revokedAt: new Date() });
    expect((await get()).status).toBe(401);
    expect((await get("not-a-token-of-any-agent-000")).status).toBe(401);
    expect((await get(TOKEN)).status).toBe(401);
  });

  it("answers an empty list from the token alone: no directory lookup when nothing is pending", async () => {
    await addAgent("PC-01", GUID, TOKEN);
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ commands: [] });
    expect(pg.lookups).toBe(0);
  });

  it("checks the computer account before signing a pending command, and signs it for this PC only", async () => {
    const { queuePcTestPrint } = await import("@/lib/test-print/service");
    const p = await addPrinter();
    const a = await addAgent("PC-01", GUID, TOKEN);
    await addAgent("PC-02", GUID2, TOKEN2);
    const row = await queuePcTestPrint(p, a, "admin@example.org");

    // Another PC sees nothing.
    expect(await (await get(TOKEN2)).json()).toEqual({ commands: [] });

    pg.computers.get(GUID)!.disabled = true;
    expect((await get(TOKEN)).status).toBe(403);
    pg.computers.get(GUID)!.disabled = false;

    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Parameters<typeof verifyCommand>[0][] };
    expect(body.commands).toHaveLength(1);
    const payload = verifyCommand(body.commands[0], publicKeyRaw(privateKeyFromSeed(seed.seed)), GUID);
    expect(payload).toMatchObject({ id: row.id, printer: { name: "Sim Laser" } });
    expect(pg.lookups).toBeGreaterThan(0);
  });
});

describe("POST /api/agent/commands/[id] (results)", () => {
  const post = async (id: string, body: unknown, token = TOKEN) => {
    const { POST } = await import("@/app/api/agent/commands/[id]/route");
    return POST(req(`/api/agent/commands/${id}`, token, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  };

  it("accepts 'unknown' (submitted, not confirmed) as a final state that is not printed", async () => {
    const { queuePcTestPrint, getTestPrint } = await import("@/lib/test-print/service");
    const p = await addPrinter();
    const a = await addAgent("PC-01", GUID, TOKEN);
    const row = await queuePcTestPrint(p, a, "admin@example.org");
    const res = await post(row.id, { state: "unknown", jobId: 4, message: "submitted; no PrintService event confirmed it" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "unknown" });
    const after = (await getTestPrint(row.id))!;
    expect(after.state).toBe("unknown");
    expect(after.completedAt).not.toBeNull();
    // Final: a later "printed" cannot overwrite it.
    expect(await (await post(row.id, { state: "printed" })).json()).toEqual({ ok: true, state: "unknown" });
  });

  it("refuses invalid bodies, other agents' commands and bad tokens", async () => {
    const { queuePcTestPrint } = await import("@/lib/test-print/service");
    const p = await addPrinter();
    const a = await addAgent("PC-01", GUID, TOKEN);
    await addAgent("PC-02", GUID2, TOKEN2);
    const row = await queuePcTestPrint(p, a, "admin@example.org");
    expect((await post(row.id, { state: "exploded" })).status).toBe(400);
    expect((await post(row.id, { state: "printed" }, TOKEN2)).status).toBe(404);
    expect((await post(row.id, { state: "printed" }, "not-a-token-of-any-agent-000")).status).toBe(401);
  });
});

describe("POST /api/agent/report (0.8.1 fields)", () => {
  it("keeps the per-PC vendor fallback of each queue and the vendor-fallback driver result", async () => {
    const a = await addAgent("PC-01", GUID, TOKEN);
    const { POST } = await import("@/app/api/agent/report/route");
    const report = {
      agentVersion: "0.8.1",
      queues: [
        { name: "Sim Laser", driver: "Brother HL-L5100DN series", port: "Spoolfree_127.0.0.1", method: "Vendor", vendorFallback: "Brother HL-L5100DN" },
        { name: "Other", driver: "Microsoft IPP Class Driver", port: "x", method: "IppUrl", vendorFallback: null },
      ],
      drivers: [{ printer: "Sim Laser", status: "vendor-fallback", driverName: "Brother HL-L5100DN series", message: "Add-Printer -IppURL failed" }],
    };
    const res = await POST(req("/api/agent/report", TOKEN, { method: "POST", body: JSON.stringify(report) }));
    expect(res.status).toBe(200);
    const [row] = await d.select().from(schema.agents);
    expect(row.id).toBe(a.id);
    expect(row.lastReport?.queues?.[0]).toMatchObject({ vendorFallback: "Brother HL-L5100DN" });
    expect(row.lastReport?.drivers?.[0]).toMatchObject({ status: "vendor-fallback" });
  });
});

describe("POST /api/agent/report (0.9.2 leniency)", () => {
  it("accepts the {} that Windows PowerShell 5.1 writes for a missing MAC (0.9.0 agents) and stores null", async () => {
    await addAgent("PC-01", GUID, TOKEN);
    const { POST } = await import("@/app/api/agent/report/route");
    const entry = { queue: "Old Laser", scope: "machine", portKind: "tcpip", port: "IP_192.0.2.30", host: "192.0.2.30", class: "other-network", action: "report" };
    const report = { agentVersion: "0.9.0", unmanaged: [{ ...entry, mac: {}, wsdUuid: {}, ippUuid: null }] };
    const res = await POST(req("/api/agent/report", TOKEN, { method: "POST", body: JSON.stringify(report) }));
    expect(res.status).toBe(200);
    const [row] = await d.select().from(schema.agents);
    expect(row.lastReport?.unmanaged?.[0]).toMatchObject({ queue: "Old Laser", mac: null, wsdUuid: null });
    // Other objects and wrong types are still rejected.
    for (const mac of [{ a: 1 }, ["001122334455"], 12]) {
      const bad = await POST(req("/api/agent/report", TOKEN, { method: "POST", body: JSON.stringify({ unmanaged: [{ ...entry, mac }] }) }));
      expect(bad.status).toBe(400);
    }
  });
});

describe("test print server actions refuse non-admins", () => {
  it("every action calls requireAdmin first and changes nothing", async () => {
    const p = await addPrinter();
    const a = await addAgent("PC-01", GUID, TOKEN);
    const actions = await import("@/app/(admin)/test-print-actions");
    await expect(actions.testPrintOptions(p.id)).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(actions.agentTestPrintOptions(a.id)).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(actions.startTestPrint({ printerId: p.id, mode: "pc", agentId: a.id } as never)).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(actions.testPrintStatus("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await d.select().from(schema.testPrints)).toHaveLength(0);
    expect(await d.select().from(schema.auditLog)).toHaveLength(0);

    // An admin gets through (sanity check of the mock).
    pg.admin = true;
    await expect(actions.testPrintOptions(p.id)).resolves.toMatchObject({ printerId: p.id });
  });
});

afterAll(() => {
  delete process.env.MANIFEST_SIGNING_KEY;
});
