import * as crypto from "node:crypto";

/**
 * argon2id password hashing with Node's built-in crypto.argon2 (Node 24.7+), stored as a PHC string:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt b64>$<hash b64>
 * Parameters follow the OWASP minimum (19 MiB, 2 passes, 1 lane).
 */

type Argon2Params = { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number };
type Argon2Fn = (alg: "argon2id", params: Argon2Params, cb: (err: Error | null, key: Buffer) => void) => void;

const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
export const MIN_PASSWORD_LENGTH = 12;

function argon2(): Argon2Fn {
  const fn = (crypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (!fn) throw new Error("argon2 needs Node.js 24.7 or later (crypto.argon2)");
  return fn;
}

function derive(password: string, salt: Buffer, p: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2()("argon2id", { message: Buffer.from(password, "utf8"), nonce: salt, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC_RE.exec(phc);
  if (!m) return false;
  const [memory, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (memory < 8 * parallelism || memory > 1 << 21 || passes < 1 || passes > 10 || parallelism < 1 || parallelism > 16) return false;
  const salt = Buffer.from(m[4], "base64");
  const expected = Buffer.from(m[5], "base64");
  if (expected.length < 16 || expected.length > 64) return false;
  const got = await derive(password, salt, { memory, passes, parallelism, tagLength: expected.length });
  return crypto.timingSafeEqual(got, expected);
}

/** Verified against when the username is unknown, so response time does not reveal which users exist. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(crypto.randomBytes(24).toString("base64"));
  return dummy;
}
