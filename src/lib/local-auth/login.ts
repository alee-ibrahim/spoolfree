import { dummyHash, verifyPassword } from "./password";

/**
 * Break-glass local admin login (LOCAL_LOGIN_ENABLED=1, shown only at /login?local=1).
 * - per-account lockout: maxFailures wrong passwords lock the account for lockoutMinutes;
 * - per-IP rate limit: ipMaxAttempts attempts per ipWindowMinutes (in memory, per replica);
 * - unknown and disabled users cost the same argon2 verification as real ones;
 * - every attempt is written to the audit log.
 */

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface LocalUserRow {
  id: string;
  username: string;
  passwordHash: string;
  disabled: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface LocalLoginStore {
  findUser(username: string): Promise<LocalUserRow | null>;
  recordFailure(id: string, failedAttempts: number, lockedUntil: Date | null): Promise<void>;
  recordSuccess(id: string, at: Date): Promise<void>;
  audit(actor: string, action: string, details: Record<string, unknown>): Promise<void>;
}

export interface LocalLoginOptions {
  enabled: boolean;
  maxFailures: number;
  lockoutMinutes: number;
  ipMaxAttempts: number;
  ipWindowMinutes: number;
}

export type LocalLoginResult =
  | { ok: true; user: { id: string; username: string } }
  | { ok: false; reason: "disabled" | "rate_limited" | "invalid" | "locked" };

export class IpRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** Counts an attempt; false when the IP is over the limit. */
  hit(ip: string, now: number): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}

export class LocalLogin {
  private limiter: IpRateLimiter;
  constructor(
    private store: LocalLoginStore,
    private opts: LocalLoginOptions,
  ) {
    this.limiter = new IpRateLimiter(opts.ipMaxAttempts, opts.ipWindowMinutes * 60_000);
  }

  async login(input: { username: string; password: string; ip: string; now?: Date }): Promise<LocalLoginResult> {
    const now = input.now ?? new Date();
    if (!this.opts.enabled) return { ok: false, reason: "disabled" };
    const username = input.username.trim().toLowerCase();
    const actor = `local:${USERNAME_RE.test(username) ? username : "(invalid)"}`;
    const details = { ip: input.ip };

    if (!this.limiter.hit(input.ip, now.getTime())) {
      await this.store.audit(actor, "local.login.rate_limited", details);
      return { ok: false, reason: "rate_limited" };
    }
    const user = USERNAME_RE.test(username) && input.password.length <= 1024 ? await this.store.findUser(username) : null;
    if (!user || user.disabled) {
      await verifyPassword(input.password.slice(0, 1024), await dummyHash());
      await this.store.audit(actor, "local.login.failure", { ...details, reason: user ? "account disabled" : "unknown user" });
      return { ok: false, reason: "invalid" };
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      await this.store.audit(actor, "local.login.locked", { ...details, lockedUntil: user.lockedUntil.toISOString() });
      return { ok: false, reason: "locked" };
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      // A lock that has expired starts a fresh count.
      const prior = user.lockedUntil ? 0 : user.failedAttempts;
      const attempts = prior + 1;
      const lock = attempts >= this.opts.maxFailures ? new Date(now.getTime() + this.opts.lockoutMinutes * 60_000) : null;
      await this.store.recordFailure(user.id, lock ? 0 : attempts, lock);
      await this.store.audit(actor, "local.login.failure", {
        ...details,
        reason: "wrong password",
        attempt: attempts,
        ...(lock ? { lockedUntil: lock.toISOString() } : {}),
      });
      return { ok: false, reason: lock ? "locked" : "invalid" };
    }
    await this.store.recordSuccess(user.id, now);
    await this.store.audit(actor, "local.login.success", details);
    return { ok: true, user: { id: user.id, username: user.username } };
  }
}

/** First address of X-Forwarded-For (set by the ingress/gateway), else "unknown". */
export function clientIp(headers: Headers | undefined): string {
  const xff = headers?.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || headers?.get("x-real-ip")?.trim();
  return ip && ip.length <= 64 ? ip : "unknown";
}
