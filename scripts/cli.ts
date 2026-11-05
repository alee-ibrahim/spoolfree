/**
 * Single entry point bundled into the image as cli/spoolfree-cli.mjs (no tsx or scripts/ in production):
 *   node cli/spoolfree-cli.mjs printers import - --dry-run < printers.yaml
 *   node cli/spoolfree-cli.mjs printers export --format csv
 *   node cli/spoolfree-cli.mjs local-user add breakglass        (password on stdin)
 * DATABASE_URL comes from the container environment.
 */
import { sqlClient } from "../src/lib/db";
import { localUserCli } from "./local-user";
import { printersCli } from "./printers";

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd === "printers" ? printersCli : cmd === "local-user" ? localUserCli : null;
if (!run) {
  console.error("usage: spoolfree-cli printers <import|export> ... | local-user <add|reset|unlock|disable|enable|delete|list> ...");
  process.exitCode = 2;
} else {
  run(rest)
    .then((code) => (process.exitCode = code))
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => sqlClient().end({ timeout: 5 }));
}
