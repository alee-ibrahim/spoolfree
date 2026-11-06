/**
 * Bulk printers, OU assignments, OU default printers and per-computer overrides.
 *
 *   printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments] [--prune-overrides]
 *   printers export [--format yaml|csv]
 *
 * Idempotent: printers are matched by name (case-insensitive) and only changed fields are written;
 * assignments are added (and with --prune-assignments, assignments of the listed printers that are not
 * in the file are removed). A YAML `computers:` list sets per-computer overrides (computers by name or
 * DN, looked up in the directory; --prune-overrides removes overrides of the listed computers that the
 * file does not mention). Every change is audit-logged with actor "cli". "-" reads stdin.
 *
 * Development:  npx tsx scripts/printers.ts import printers.yaml --dry-run   (DATABASE_URL from env/.env)
 * In the image: kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- node cli/spoolfree-cli.mjs printers import - --dry-run < printers.yaml
 */
import { readFileSync } from "node:fs";
import { apply, describe, exportCsv, exportYaml, loadState, parseDocument, plan, planComputers, type DirectoryComputer } from "../src/lib/bulk";
import { config, directoryMode } from "../src/lib/config";
import { db, schema, sqlClient } from "../src/lib/db";

const USAGE = `usage:
  printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments] [--prune-overrides]
  printers export [--format yaml|csv]`;

/**
 * Computers for name/DN lookup. Snapshot mode reads the snapshot tables directly (the app's snapshot store
 * is server-only); LDAP and the development fake directory go through their Directory implementation.
 */
async function directoryComputers(): Promise<DirectoryComputer[]> {
  const mode = directoryMode();
  if (mode === "snapshot") {
    const rows = await db()
      .select({ objectGuid: schema.directoryComputers.objectGuid, dn: schema.directoryComputers.dn, name: schema.directoryComputers.name })
      .from(schema.directoryComputers);
    if (rows.length === 0) throw new Error("no directory snapshot yet: computers cannot be looked up");
    return rows;
  }
  if (mode === "fake") {
    const { FakeDirectory, loadFakeDirectoryFile } = await import("../src/lib/directory/fake");
    const file = config().DEV_FAKE_AD_FILE;
    return (file ? loadFakeDirectoryFile(file) : new FakeDirectory()).listComputers();
  }
  const { LdapDirectory } = await import("../src/lib/directory/ldap");
  return new LdapDirectory().listComputers();
}

export async function printersCli(argv: string[]): Promise<number> {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flag = (f: string) => argv.includes(`--${f}`);
  const fmtIdx = argv.indexOf("--format");
  const format = fmtIdx >= 0 ? argv[fmtIdx + 1] : undefined;
  if (format && format !== "yaml" && format !== "csv") throw new Error("--format must be yaml or csv");
  const [cmd, file] = args.filter((a) => a !== format);

  if (cmd === "export") {
    const state = await loadState();
    process.stdout.write(format === "csv" ? exportCsv(state) : exportYaml(state));
    return 0;
  }
  if (cmd !== "import" || !file) {
    console.error(USAGE);
    return 2;
  }
  const text = readFileSync(file === "-" ? 0 : file, "utf8");
  const fmt = (format ?? (/\.csv$/i.test(file) ? "csv" : "yaml")) as "yaml" | "csv";
  const doc = parseDocument(text, fmt);
  const state = await loadState();
  const steps = plan(doc.printers, state, { pruneAssignments: flag("prune-assignments") });
  if (doc.computers.length) {
    const newPrinters = steps.flatMap((s) => (s.kind === "create" ? [s.name] : []));
    steps.push(...planComputers(doc.computers, state, await directoryComputers(), { pruneOverrides: flag("prune-overrides"), newPrinters }));
  }
  const changes = steps.filter((s) => s.kind !== "unchanged");
  for (const s of steps) console.log(describe(s));
  console.log(
    `${doc.printers.length} printer(s) and ${doc.computers.length} computer(s) in the file, ${changes.length} change(s)${flag("dry-run") ? " (dry run: nothing written)" : ""}.`,
  );
  if (!flag("dry-run") && changes.length) {
    await apply(changes);
    console.log("applied.");
  }
  return 0;
}

// Run directly (tsx) unless bundled into the combined CLI, which calls printersCli itself.
if (process.argv[1] && /printers\.(ts|js|mjs)$/.test(process.argv[1])) {
  printersCli(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => sqlClient().end({ timeout: 5 }));
}
