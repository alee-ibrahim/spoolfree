/**
 * Bulk printers, OU assignments and OU default printers.
 *
 *   printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments]
 *   printers export [--format yaml|csv]
 *
 * Idempotent: printers are matched by name (case-insensitive) and only changed fields are written;
 * assignments are added (and with --prune-assignments, assignments of the listed printers that are not
 * in the file are removed). Every change is audit-logged with actor "cli". "-" reads stdin.
 *
 * Development:  npx tsx scripts/printers.ts import printers.yaml --dry-run   (DATABASE_URL from env/.env)
 * In the image: kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- node cli/spoolfree-cli.mjs printers import - --dry-run < printers.yaml
 */
import { readFileSync } from "node:fs";
import { apply, describe, exportCsv, exportYaml, loadState, parseInput, plan } from "../src/lib/bulk";
import { sqlClient } from "../src/lib/db";

const USAGE = `usage:
  printers import <file.yaml|file.csv|-> [--format yaml|csv] [--dry-run] [--prune-assignments]
  printers export [--format yaml|csv]`;

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
  const specs = parseInput(text, fmt);
  const steps = plan(specs, await loadState(), { pruneAssignments: flag("prune-assignments") });
  const changes = steps.filter((s) => s.kind !== "unchanged");
  for (const s of steps) console.log(describe(s));
  console.log(`${specs.length} printer(s) in the file, ${changes.length} change(s)${flag("dry-run") ? " (dry run: nothing written)" : ""}.`);
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
