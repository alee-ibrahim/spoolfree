/**
 * Vendor driver packages (driver mode "vendor" and "auto"; docs/drivers.md).
 *
 *   drivers upload <name> <file.zip|-> [--universal] [--universal-driver "<driver name>"]
 *   drivers list
 *   drivers delete <name> [--dry-run]
 *   drivers decide [<printer name> ...]      the driver each printer gets (auto mode's decision and reason)
 *
 * A package is a zip of a driver's INF/CAT/files tree (x64). Upload checks that every printer INF it uses names a
 * CatalogFile that is in the zip; agents check the catalog's Authenticode signature before installing. Audit actor:
 * "cli". "-" reads the zip from stdin:
 *   kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- node cli/spoolfree-cli.mjs drivers upload "Brother HL-3150CDN" - < brother.zip
 */
import { createReadStream } from "node:fs";
import { config, autoSettings } from "../src/lib/config";
import { db, schema, sqlClient } from "../src/lib/db";
import { decideDriver } from "../src/lib/drivers/auto";
import { driverNames } from "../src/lib/drivers/package";
import { deleteDriverPackage, findDriverPackageByName, ingestDriverPackage, listDriverPackages, receiveToTempFile, toPackageForMatch } from "../src/lib/drivers/store";

const USAGE = `usage:
  drivers upload <name> <file.zip|-> [--universal] [--universal-driver "<driver name>"]
  drivers list
  drivers delete <name> [--dry-run]
  drivers decide [<printer name> ...]
Quote names that contain spaces. Audit actor: "cli".`;

/** Positional arguments and --flags (--universal-driver takes a value). */
function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--universal-driver") values["universal-driver"] = argv[++i] ?? "";
    else if (a.startsWith("--")) flags.add(a.slice(2));
    else pos.push(a);
  }
  return { pos, flags, values };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function driversCli(argv: string[]): Promise<number> {
  const { pos, flags, values } = parseArgs(argv);
  const [cmd, ...args] = pos;
  if (flags.has("help") || flags.has("h") || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const d = db();

  if (cmd === "upload") {
    const unknown = [...flags].filter((f) => f !== "universal");
    if (args.length !== 2 || unknown.length) {
      if (unknown.length) console.error(`unknown option: --${unknown.join(" --")}`);
      console.error(USAGE);
      return 2;
    }
    const [name, file] = args;
    const maxBytes = config().DRIVER_PACKAGE_MAX_MB * 1024 * 1024;
    const received = await receiveToTempFile(file === "-" ? process.stdin : createReadStream(file), maxBytes);
    const r = await ingestDriverPackage(d, {
      name,
      file: received,
      fileName: file === "-" ? null : file.split(/[\\/]/).pop(),
      uploadedBy: "cli",
      universal: flags.has("universal"),
      universalDriver: values["universal-driver"] ?? null,
    });
    if (!r.ok) {
      console.error(`error: ${r.error}`);
      return 1;
    }
    const p = r.package;
    console.log(`uploaded ${p.name} (${p.id})`);
    console.log(`  sha256       ${p.sha256}`);
    console.log(`  size         ${mb(p.size)}`);
    console.log(`  manufacturer ${p.manufacturer ?? "-"}${p.universal ? ` (universal: ${p.universalDriver})` : ""}`);
    for (const inf of p.infs) {
      console.log(`  inf          ${inf.path} (catalog ${inf.catalog}, DriverVer ${inf.driverVer ?? "-"})`);
      for (const m of inf.models) console.log(`    driver     ${m.name}${m.hardwareIds.length ? `  [${m.hardwareIds.join(", ")}]` : ""}`);
    }
    for (const n of r.inspection.notes) console.log(`  note         ${n}`);
    if (r.duplicateOf) console.log(`  note         same bytes as package "${r.duplicateOf}"`);
    return 0;
  }

  if (cmd === "list") {
    for (const p of await listDriverPackages(d)) {
      const names = driverNames(p.infs);
      console.log(
        `${p.name}\t${p.manufacturer ?? "-"}${p.universal ? " (universal)" : ""}\t${names.length} driver(s)\t${mb(p.size)}\t${p.sha256.slice(0, 16)}\t${p.uploadedBy}\t${p.uploadedAt.toISOString()}`,
      );
    }
    return 0;
  }

  if (cmd === "delete") {
    if (args.length !== 1) {
      console.error(USAGE);
      return 2;
    }
    const pkg = await findDriverPackageByName(d, args[0]);
    if (!pkg) {
      console.error(`error: no driver package named "${args[0]}"`);
      return 1;
    }
    console.log(`delete   ${pkg.name} (${pkg.id})${flags.has("dry-run") ? " (dry run: nothing written)" : ""}`);
    if (flags.has("dry-run")) return 0;
    const r = await deleteDriverPackage(d, "cli", pkg.id);
    if (!r.ok) {
      console.error(`error: ${r.error}`);
      return 1;
    }
    console.log("deleted. Printers in auto mode match again at the next agent sync.");
    return 0;
  }

  if (cmd === "decide") {
    const packages = (await listDriverPackages(d)).map(toPackageForMatch);
    const printers = await d.select().from(schema.printers).orderBy(schema.printers.name);
    const want = new Set(args.map((a) => a.toLowerCase()));
    const missing = args.filter((a) => !printers.some((p) => p.name.toLowerCase() === a.toLowerCase()));
    if (missing.length) {
      console.error(`error: no printer named ${missing.map((m) => `"${m}"`).join(", ")}`);
      return 1;
    }
    for (const p of printers.filter((x) => !want.size || want.has(x.name.toLowerCase()))) {
      const dec = decideDriver(p, packages, autoSettings());
      const what =
        dec.mode === "vendor"
          ? `vendor   ${dec.driverName} from "${dec.package!.name}" (${dec.match}) via ${dec.protocol}`
          : `driverless${dec.needed ? ` (${dec.needed})` : ""}`;
      console.log(`${p.name}\t[${p.driverMode}] ${what}\t${dec.reason}`);
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

// Run directly (tsx) unless bundled into the combined CLI, which calls driversCli itself.
if (process.argv[1] && /drivers\.(ts|js|mjs)$/.test(process.argv[1])) {
  driversCli(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => sqlClient().end({ timeout: 5 }));
}
