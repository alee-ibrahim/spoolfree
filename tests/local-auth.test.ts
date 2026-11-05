import { describe, expect, it } from "vitest";
import { autoSignInEnabled, shouldAutoSignIn } from "@/lib/auth-flow";
import { clientIp, IpRateLimiter, LocalLogin, type LocalLoginStore, type LocalUserRow } from "@/lib/local-auth/login";
import { hashPassword, verifyPassword } from "@/lib/local-auth/password";

const PW = "correct horse battery staple";

describe("argon2id passwords", () => {
  it("hashes to a PHC string and verifies", async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword(PW + "x", h)).toBe(false);
    expect(h).not.toBe(await hashPassword(PW)); // random salt
  });
  it("rejects short passwords, malformed and tampered hashes", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 12/);
    expect(await verifyPassword(PW, "$2b$10$notargon")).toBe(false);
    const h = await hashPassword(PW);
    expect(await verifyPassword(PW, h.replace("m=19456", "m=99999999"))).toBe(false);
    const parts = h.split("$");
    parts[5] = Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "");
    expect(await verifyPassword(PW, parts.join("$"))).toBe(false);
  });
});

class MemStore implements LocalLoginStore {
  users = new Map<string, LocalUserRow>();
  audits: { actor: string; action: string; details: Record<string, unknown> }[] = [];
  async findUser(u: string) {
    return this.users.get(u) ?? null;
  }
  async recordFailure(id: string, failedAttempts: number, lockedUntil: Date | null) {
    for (const u of this.users.values()) if (u.id === id) Object.assign(u, { failedAttempts, lockedUntil });
  }
  async recordSuccess(id: string) {
    for (const u of this.users.values()) if (u.id === id) Object.assign(u, { failedAttempts: 0, lockedUntil: null });
  }
  async audit(actor: string, action: string, details: Record<string, unknown>) {
    this.audits.push({ actor, action, details });
  }
}

async function setup(opts: Partial<ConstructorParameters<typeof LocalLogin>[1]> = {}) {
  const store = new MemStore();
  store.users.set("breakglass", { id: "u1", username: "breakglass", passwordHash: await hashPassword(PW), disabled: false, failedAttempts: 0, lockedUntil: null });
  const login = new LocalLogin(store, { enabled: true, maxFailures: 3, lockoutMinutes: 15, ipMaxAttempts: 100, ipWindowMinutes: 15, ...opts });
  return { store, login };
}

const T0 = new Date("2026-11-06T12:00:00Z");

describe("local break-glass login", () => {
  it("is off unless enabled", async () => {
    const { login, store } = await setup({ enabled: false });
    expect(await login.login({ username: "breakglass", password: PW, ip: "192.0.2.1" })).toEqual({ ok: false, reason: "disabled" });
    expect(store.audits).toHaveLength(0);
  });

  it("logs in (case-insensitive username) and audits every attempt", async () => {
    const { login, store } = await setup();
    const r = await login.login({ username: " BreakGlass ", password: PW, ip: "192.0.2.1", now: T0 });
    expect(r).toEqual({ ok: true, user: { id: "u1", username: "breakglass" } });
    expect(store.audits.at(-1)).toMatchObject({ actor: "local:breakglass", action: "local.login.success", details: { ip: "192.0.2.1" } });
    expect((await login.login({ username: "nobody", password: PW, ip: "192.0.2.1" })).ok).toBe(false);
    expect(store.audits.at(-1)).toMatchObject({ action: "local.login.failure", details: { reason: "unknown user" } });
  });

  it("locks the account after maxFailures and refuses even the right password until it expires", async () => {
    const { login, store } = await setup();
    const at = (min: number) => new Date(T0.getTime() + min * 60_000);
    expect(await login.login({ username: "breakglass", password: "wrong-password-1", ip: "a", now: at(0) })).toEqual({ ok: false, reason: "invalid" });
    await login.login({ username: "breakglass", password: "wrong-password-2", ip: "a", now: at(1) });
    expect(await login.login({ username: "breakglass", password: "wrong-password-3", ip: "a", now: at(2) })).toEqual({ ok: false, reason: "locked" });
    expect(store.users.get("breakglass")!.lockedUntil?.toISOString()).toBe(at(17).toISOString());
    expect(await login.login({ username: "breakglass", password: PW, ip: "a", now: at(10) })).toEqual({ ok: false, reason: "locked" });
    expect(store.audits.at(-1)?.action).toBe("local.login.locked");
    // after the lockout a fresh count starts, and the right password works
    expect((await login.login({ username: "breakglass", password: PW, ip: "a", now: at(18) })).ok).toBe(true);
    expect(store.users.get("breakglass")).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it("refuses disabled accounts", async () => {
    const { login, store } = await setup();
    store.users.get("breakglass")!.disabled = true;
    expect((await login.login({ username: "breakglass", password: PW, ip: "a" })).ok).toBe(false);
    expect(store.audits.at(-1)?.details.reason).toBe("account disabled");
  });

  it("rate-limits per IP", async () => {
    const { login, store } = await setup({ ipMaxAttempts: 2, maxFailures: 100 });
    await login.login({ username: "x", password: "y", ip: "198.51.100.7", now: T0 });
    await login.login({ username: "x", password: "y", ip: "198.51.100.7", now: T0 });
    expect(await login.login({ username: "breakglass", password: PW, ip: "198.51.100.7", now: T0 })).toEqual({ ok: false, reason: "rate_limited" });
    expect(store.audits.at(-1)?.action).toBe("local.login.rate_limited");
    expect((await login.login({ username: "breakglass", password: PW, ip: "198.51.100.8", now: T0 })).ok).toBe(true);
    const lim = new IpRateLimiter(1, 1000);
    expect(lim.hit("a", 0)).toBe(true);
    expect(lim.hit("a", 500)).toBe(false);
    expect(lim.hit("a", 1500)).toBe(true);
  });

  it("takes the client IP from X-Forwarded-For", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "192.0.2.9, 10.0.0.1" }))).toBe("192.0.2.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("automatic Entra sign-in", () => {
  it("defaults to on when Entra is the only provider", () => {
    expect(autoSignInEnabled({ setting: undefined, entraConfigured: true, devLogin: false })).toBe(true);
    expect(autoSignInEnabled({ setting: undefined, entraConfigured: true, devLogin: true })).toBe(false);
    expect(autoSignInEnabled({ setting: undefined, entraConfigured: false, devLogin: false })).toBe(false);
    expect(autoSignInEnabled({ setting: "false", entraConfigured: true, devLogin: false })).toBe(false);
    expect(autoSignInEnabled({ setting: "1", entraConfigured: true, devLogin: true })).toBe(true);
    expect(autoSignInEnabled({ setting: "true", entraConfigured: false, devLogin: false })).toBe(false);
  });

  it("redirects only a plain signed-out visit", () => {
    const base = { enabled: true, params: {} };
    expect(shouldAutoSignIn(base)).toBe(true);
    expect(shouldAutoSignIn({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoSignIn({ ...base, params: { local: "1" } })).toBe(false);
    expect(shouldAutoSignIn({ ...base, params: { signedout: "1" } })).toBe(false);
    // Entra errors (e.g. AccessDenied for an unassigned user) and not-an-admin sessions: no loop
    expect(shouldAutoSignIn({ ...base, params: { error: "AccessDenied" } })).toBe(false);
    expect(shouldAutoSignIn({ ...base, authError: "not assigned" })).toBe(false);
    // came back within a minute of an automatic attempt
    expect(shouldAutoSignIn({ ...base, guardCookie: "1" })).toBe(false);
  });
});
