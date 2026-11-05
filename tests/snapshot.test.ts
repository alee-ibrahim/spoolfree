import { describe, expect, it } from "vitest";
import { handleSnapshotPush } from "@/lib/directory/ingest";
import { freshness, MemorySnapshotStore, parseSnapshot, SnapshotDirectory, SnapshotRejected } from "@/lib/directory/snapshot";
import { DirectoryUnavailableError } from "@/lib/directory/types";

const BASE = "DC=example,DC=org";
const TOKEN = "t".repeat(40);
const G1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const G2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function payload(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: "dc1.example.org",
    baseDn: BASE,
    defaultComputersContainer: `CN=Computers,${BASE}`,
    ous: [
      { dn: `OU=Workstations,${BASE}`, name: "Workstations", objectGuid: "{A1B2C3D4-0000-4000-8000-000000000001}" },
      { dn: `OU=Lab,OU=Workstations,${BASE}`, description: "Science lab" },
    ],
    computers: [
      { dn: `CN=Lab-01,OU=Lab,OU=Workstations,${BASE}`, objectGuid: G1.toUpperCase(), name: "Lab-01", dnsHostName: "lab-01.example.org", userAccountControl: 4096 },
      { dn: `CN=OLD-PC,CN=Computers,${BASE}`, objectGuid: G2, userAccountControl: 4098 },
    ],
    ...over,
  };
}

function post(body: unknown, token: string | null = TOKEN) {
  return new Request("http://localhost/api/internal/directory-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const NOW = new Date("2026-11-06T12:00:00Z");
const deps = (store: MemorySnapshotStore, over: Partial<Parameters<typeof handleSnapshotPush>[1]> = {}) => ({
  mode: "snapshot",
  token: TOKEN,
  store,
  baseDn: BASE,
  now: () => NOW,
  ...over,
});

describe("snapshot ingestion", () => {
  it("normalizes GUIDs, names and the disabled flag", () => {
    const s = parseSnapshot(payload(), BASE);
    expect(s.ous.map((o) => o.name)).toEqual(["Workstations", "Lab"]);
    expect(s.ous[0].objectGuid).toBe("a1b2c3d4-0000-4000-8000-000000000001");
    expect(s.computers[0]).toMatchObject({ objectGuid: G1, name: "LAB-01", disabled: false });
    expect(s.computers[1]).toMatchObject({ name: "OLD-PC", disabled: true });
  });

  it("rejects a snapshot of another domain, objects outside the base DN, duplicates and empty computer lists", () => {
    expect(() => parseSnapshot(payload({ baseDn: "DC=other,DC=org" }), BASE)).toThrow(SnapshotRejected);
    expect(() => parseSnapshot(payload({ ous: [{ dn: "OU=X,DC=other,DC=org" }] }), BASE)).toThrow(/outside/);
    const c = payload().computers;
    expect(() => parseSnapshot(payload({ computers: [c[0], { ...c[1], objectGuid: G1 }] }), BASE)).toThrow(/duplicate objectGuid/);
    expect(() => parseSnapshot(payload({ computers: [c[0], { ...c[1], dn: c[0].dn.toLowerCase() }] }), BASE)).toThrow(/duplicate computer DN/);
    expect(() => parseSnapshot(payload({ computers: [] }), BASE)).toThrow(/no computers/);
    expect(() => parseSnapshot(payload({ computers: [{ ...c[0], objectGuid: "nope" }] }), BASE)).toThrow();
  });

  it("stores a valid push and serves it through SnapshotDirectory", async () => {
    const store = new MemorySnapshotStore();
    const res = await handleSnapshotPush(post(payload()), deps(store));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ous: 2, computers: 2 });

    const dir = new SnapshotDirectory(store, { baseDn: BASE, maxAgeHours: 24, now: () => NOW });
    const containers = await dir.listContainers();
    expect(containers.map((n) => n.kind)).toEqual(["domain", "ou", "ou", "container"]);
    expect(await dir.defaultComputersContainer()).toBe(`CN=Computers,${BASE}`);
    expect((await dir.findComputerByGuid(G1.toUpperCase()))?.dn).toBe(`CN=Lab-01,OU=Lab,OU=Workstations,${BASE}`);
    expect((await dir.findComputerByGuid(G2))?.disabled).toBe(true);
    expect(await dir.findComputerByGuid("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("a moved computer is served with its new DN after the next snapshot", async () => {
    const store = new MemorySnapshotStore();
    await handleSnapshotPush(post(payload()), deps(store));
    const moved = payload();
    moved.computers[0].dn = `CN=Lab-01,OU=Workstations,${BASE}`;
    await handleSnapshotPush(post(moved), deps(store));
    const dir = new SnapshotDirectory(store, { baseDn: BASE, maxAgeHours: 24, now: () => NOW });
    expect((await dir.findComputerByGuid(G1))?.dn).toBe(`CN=Lab-01,OU=Workstations,${BASE}`);
  });

  it("records error reports and rejected snapshots without touching the stored snapshot", async () => {
    const store = new MemorySnapshotStore();
    await handleSnapshotPush(post(payload()), deps(store));
    const bad = await handleSnapshotPush(post(payload({ computers: [] })), deps(store));
    expect(bad.status).toBe(400);
    expect(store.snapshot?.computers).toHaveLength(2);
    expect(store.state?.lastError).toMatch(/^rejected: snapshot has no computers/);

    const report = await handleSnapshotPush(post({ version: 1, status: "error", error: "KDC unreachable\nretrying" }), deps(store));
    expect(report.status).toBe(200);
    expect(store.state?.lastError).toBe("KDC unreachable retrying");
    expect(store.snapshot?.computers).toHaveLength(2);
  });
});

describe("internal endpoint auth", () => {
  it("is 404 unless DIRECTORY_MODE=snapshot", async () => {
    const res = await handleSnapshotPush(post(payload()), deps(new MemorySnapshotStore(), { mode: "ldap" }));
    expect(res.status).toBe(404);
  });

  it("refuses everything when the token is unset or too short", async () => {
    for (const token of [undefined, "", "short-token"]) {
      const store = new MemorySnapshotStore();
      const res = await handleSnapshotPush(post(payload(), token || "x".repeat(40)), deps(store, { token }));
      expect(res.status).toBe(503);
      expect(store.snapshot).toBeNull();
    }
  });

  it("requires the exact bearer token", async () => {
    const store = new MemorySnapshotStore();
    for (const t of [null, "wrong".repeat(10), TOKEN + "x"]) {
      expect((await handleSnapshotPush(post(payload(), t), deps(store))).status).toBe(401);
    }
    const basic = new Request("http://localhost/x", { method: "POST", headers: { authorization: `Basic ${TOKEN}` }, body: "{}" });
    expect((await handleSnapshotPush(basic, deps(store))).status).toBe(401);
    expect(store.snapshot).toBeNull();
    expect(store.state).toBeNull();
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    const store = new MemorySnapshotStore();
    expect((await handleSnapshotPush(post("{not json"), deps(store))).status).toBe(400);
    const big = new Request("http://localhost/x", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(65 * 1024 * 1024) },
      body: "{}",
    });
    expect((await handleSnapshotPush(big, deps(store))).status).toBe(413);
  });
});

describe("stale handling", () => {
  const status = (syncedAt: Date | null, lastErrorAt: Date | null = null) => ({
    baseDn: BASE,
    defaultContainer: null,
    syncedAt,
    source: null,
    ouCount: 1,
    computerCount: 1,
    lastErrorAt,
    lastError: lastErrorAt ? "boom" : null,
  });

  it("classifies never / fresh / stale and reports errors newer than the snapshot", () => {
    expect(freshness(null, NOW, 30).state).toBe("never");
    const fresh = freshness(status(new Date(NOW.getTime() - 5 * 60_000)), NOW, 30);
    expect(fresh).toMatchObject({ state: "fresh", ageMinutes: 5, lastError: null });
    expect(freshness(status(new Date(NOW.getTime() - 31 * 60_000)), NOW, 30).state).toBe("stale");
    const failedAfter = freshness(status(new Date(NOW.getTime() - 10 * 60_000), new Date(NOW.getTime() - 60_000)), NOW, 30);
    expect(failedAfter.lastError).toBe("boom");
    const failedBefore = freshness(status(new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 10 * 60_000)), NOW, 30);
    expect(failedBefore.lastError).toBeNull();
  });

  it("refuses agent lookups (fail closed) when there is no snapshot or it is older than the max age", async () => {
    const store = new MemorySnapshotStore();
    const dir = (now: Date, maxAgeHours = 24) => new SnapshotDirectory(store, { baseDn: BASE, maxAgeHours, now: () => now });
    await expect(dir(NOW).findComputerByGuid(G1)).rejects.toBeInstanceOf(DirectoryUnavailableError);
    await expect(dir(NOW).listComputers()).rejects.toBeInstanceOf(DirectoryUnavailableError);

    await store.replace(parseSnapshot(payload(), BASE), NOW);
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    await expect(dir(later).findComputerByGuid(G1)).rejects.toThrow(/older than 24 h/);
    // OU tree and lists stay readable from the last good snapshot
    expect(await dir(later).listComputers()).toHaveLength(2);
    // DIRECTORY_MAX_AGE_HOURS=0 disables the check
    expect((await dir(later, 0).findComputerByGuid(G1))?.name).toBe("LAB-01");
  });
});
