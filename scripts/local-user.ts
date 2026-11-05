/**
 * Break-glass local admin users (only used when LOCAL_LOGIN_ENABLED=1; sign in at /login?local=1).
 *
 *   npx tsx scripts/local-user.ts add <username>       create; password from stdin or a hidden prompt
 *   npx tsx scripts/local-user.ts reset <username>     new password; also clears a lockout
 *   npx tsx scripts/local-user.ts unlock <username>
 *   npx tsx scripts/local-user.ts disable|enable <username>
 *   npx tsx scripts/local-user.ts delete <username>
 *   npx tsx scripts/local-user.ts list
 *   In the image: kubectl exec -i ... -- node cli/spoolfree-cli.mjs local-user add <username>   (password on stdin)
 *
 * The password is never taken from the command line. Piped: the first line of stdin
 * (e.g. `your-secret-manager read ... | npx tsx scripts/local-user.ts add breakglass`).
 * Interactive: asked twice, not echoed. Needs DATABASE_URL (from the environment or .env).
 * Every change is written to the audit log as actor "cli".
 */
import { readFileSync } from "node:fs";
import { db, schema, sqlClient } from "../src/lib/db";
import { USERNAME_RE } from "../src/lib/local-auth/login";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/lib/local-auth/password";
import { deleteLocalUser, listLocalUsers, updateLocalUser, upsertLocalUser } from "../src/lib/local-auth/store-db";

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("aborted"));
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const first = readFileSync(0, "utf8").split(/\r?\n/)[0] ?? "";
    return first;
  }
  const a = await promptHidden("New password: ");
  const b = await promptHidden("Repeat password: ");
  if (a !== b) throw new Error("passwords do not match");
  return a;
}

async function audit(action: string, username: string) {
  await db().insert(schema.auditLog).values({ actor: "cli", action, entityType: "local_user", entityId: username });
}

export async function localUserCli(argv: string[]): Promise<number> {
  const [cmd, rawName] = argv;
  const usage = "usage: local-user.ts add|reset|unlock|disable|enable|delete <username> | list";
  if (cmd === "list") {
    for (const u of await listLocalUsers()) {
      const state = u.disabled ? "disabled" : u.lockedUntil && u.lockedUntil > new Date() ? `locked until ${u.lockedUntil.toISOString()}` : "active";
      console.log(`${u.username}\t${state}\tlast login ${u.lastLoginAt?.toISOString() ?? "never"}\tpassword set ${u.passwordChangedAt.toISOString()}`);
    }
    return 0;
  }
  if (!cmd || !rawName) throw new Error(usage);
  const username = rawName.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("username: 1-64 characters a-z 0-9 . _ - (starting with a letter or digit)");

  switch (cmd) {
    case "add":
    case "reset": {
      const password = await readPassword();
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      const r = await upsertLocalUser(username, await hashPassword(password), cmd === "add");
      await audit(r === "created" ? "local_user.create" : "local_user.reset_password", username);
      console.log(`${username}: ${r === "created" ? "created" : "password reset, lockout cleared"}`);
      break;
    }
    case "unlock":
      await updateLocalUser(username, { failedAttempts: 0, lockedUntil: null });
      await audit("local_user.unlock", username);
      console.log(`${username}: unlocked`);
      break;
    case "disable":
    case "enable":
      await updateLocalUser(username, { disabled: cmd === "disable" });
      await audit(`local_user.${cmd}`, username);
      console.log(`${username}: ${cmd}d`);
      break;
    case "delete":
      await deleteLocalUser(username);
      await audit("local_user.delete", username);
      console.log(`${username}: deleted`);
      break;
    default:
      throw new Error(usage);
  }
  return 0;
}

// Run directly (tsx) unless bundled into the combined CLI, which calls localUserCli itself.
if (process.argv[1] && /local-user\.(ts|js|mjs)$/.test(process.argv[1])) {
  localUserCli(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => sqlClient().end({ timeout: 5 }));
}
