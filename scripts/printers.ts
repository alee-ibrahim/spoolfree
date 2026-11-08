/**
 * Bulk printers, OU assignments, OU default printers and per-computer overrides.
 *
 *   printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments] [--prune-overrides]
 *   printers export [--format yaml|csv]
 *   printers delete <name> [--dry-run]
 *   printers rename <old-name> <new-name> [--dry-run]
 *
 * Idempotent: printers are matched by name (case-insensitive) and only changed fields are written;
 * assignments are added (and with --prune-assignments, assignments of the listed printers that are not
 * in the file are removed). A YAML `computers:` list sets per-computer overrides (computers by name or
 * DN, looked up in the directory; --prune-overrides removes overrides of the listed computers that the
 * file does not mention). Every change is audit-logged with actor "cli". "-" reads stdin.
 *
 * delete and rename do what the admin UI's Delete and rename (Edit, name only) do, through the same code
 * (src/lib/printer-lifecycle.ts): delete removes the printer with its OU assignments, OU defaults, OU blocks and
 * per-computer overrides; rename keeps the id, assignments and history. Names match case-insensitively.
 *
 * Development:  npx tsx scripts/printers.ts import printers.yaml --dry-run   (DATABASE_URL from env/.env)
 * In the image: kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- node cli/spoolfree-cli.mjs printers import - --dry-run < printers.yaml
 */
import { readFileSync } from "node:fs";
import { apply, describe, exportCsv, exportYaml, loadState, parseDocument, plan, planComputers, type DirectoryComputer } from "../src/lib/bulk";
import { config, directoryMode } from "../src/lib/config";
import { db, schema, sqlClient } from "../src/lib/db";
import { checkPrinterRename, deletePrinterWithReferences, findPrinterByName, planPrinterDelete, renamePrinter } from "../src/lib/printer-lifecycle";

const USAGE = `usage:
  printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments] [--prune-overrides]
  printers export [--format yaml|csv]
  printers delete <name> [--dry-run]
  printers rename <old-name> <new-name> [--dry-run]
Quote names that contain spaces. Audit actor: "cli". PCs follow at their next agent sync.`;

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
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "delete" || argv[0] === "rename") return deleteOrRename(argv);
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

async function deleteOrRename(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const unknown = rest.filter((a) => a.startsWith("--") && a !== "--dry-run");
  const args = rest.filter((a) => !a.startsWith("--"));
  const want = cmd === "delete" ? 1 : 2;
  if (unknown.length || args.length !== want) {
    if (unknown.length) console.error(`unknown option: ${unknown.join(" ")}`);
    console.error(USAGE);
    return 2;
  }
  const dryRun = rest.includes("--dry-run");
  const d = db();
  const printer = await findPrinterByName(d, args[0]);
  if (!printer) {
    console.error(`error: no printer named "${args[0]}"`);
    return 1;
  }

  if (cmd === "delete") {
    const p = await planPrinterDelete(d, printer);
    const lines = [
      `delete   ${p.printer.name} (${p.printer.id})`,
      ...p.assignments.map((ou) => `unassign ${ou}`),
      ...p.defaults.map((ou) => `default  ${ou}: cleared`),
      ...p.blockedIn.map((ou) => `unblock  ${ou}`),
      ...p.overrides.map((o) => `unset    ${o.computerName}: ${o.action} override`),
    ];
    for (const l of lines) console.log(l);
    console.log(
      `${p.assignments.length} assignment(s), ${p.defaults.length} OU default(s), ${p.blockedIn.length} OU block(s), ${p.overrides.length} override(s)${dryRun ? " (dry run: nothing written)" : ""}.`,
    );
    if (dryRun) return 0;
    const removed = await deletePrinterWithReferences(d, "cli", printer.id);
    if (!removed) {
      console.error(`error: printer "${printer.name}" was deleted meanwhile`);
      return 1;
    }
    console.log("deleted. PCs remove the queue at their next sync.");
    return 0;
  }

  const check = await checkPrinterRename(d, printer.id, args[1]);
  if (!check.ok) {
    console.error(`error: ${check.error}`);
    return 1;
  }
  if (check.unchanged) {
    console.log(`unchanged ${check.from}: already named "${check.to}".`);
    return 0;
  }
  console.log(`rename   ${check.from} -> ${check.to} (${printer.id})${dryRun ? " (dry run: nothing written)" : ""}`);
  if (dryRun) return 0;
  const r = await renamePrinter(d, "cli", printer.id, args[1]);
  if (!r.ok) {
    console.error(`error: ${r.error}`);
    return 1;
  }
  console.log("renamed. PCs re-create the queue under the new name at their next sync; users' defaults follow.");
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
