import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { PRINTER_NAME_RE, PRINTER_NAME_RULE } from "@/lib/printer-name";
import { printerNameError } from "@/lib/printer-lifecycle";
import { parseInput } from "@/lib/bulk";

describe("printer names (L1)", () => {
  it("rejects double quotes and control characters, as well as \\ / , !", () => {
    for (const bad of ['X" /if /b "Y', "Finance\nLaser", "Tab\there", "Del\x7f", "a\\b", "a/b", "a,b", "a!b"]) {
      expect(PRINTER_NAME_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["Finance Laser", "3F Office Brother HL-L5100DN", "Bob's printer", "Room 2 -Legal (colour)", "ފައިނޭންސް"]) {
      expect(PRINTER_NAME_RE.test(good), good).toBe(true);
    }
    expect(printerNameError('Evil" /m "x')).toBe(PRINTER_NAME_RULE);
    expect(printerNameError("ok name")).toBeNull();
  });

  it("refuses such names in bulk import", () => {
    expect(() => parseInput('printers:\n  - name: "Bad \\" name"\n    host: 192.0.2.1\n', "yaml")).toThrow(/control characters/);
  });

  it("migration 0008 renames existing names with quotes or control characters, avoiding clashes, audited", async () => {
    const pg = new PGlite();
    const d = drizzle(pg, { schema });
    await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    await d.insert(schema.printers).values([
      { name: 'Finance "Main"', host: "192.0.2.10" },
      { name: "Finance 'Main'", host: "192.0.2.11" },
      { name: "Line\nbreak", host: "192.0.2.12" },
      { name: "Plain", host: "192.0.2.13" },
    ]);
    // The migration is idempotent: run it again on the rows inserted after it.
    await pg.exec(readFileSync(path.resolve(import.meta.dirname, "../drizzle/0008_printer_name_quotes.sql"), "utf8"));
    const names = (await d.select().from(schema.printers)).map((p) => p.name).sort();
    expect(names).toEqual(["Finance 'Main'", "Finance 'Main' (2)", "Line break", "Plain"]);
    for (const n of names) expect(PRINTER_NAME_RE.test(n)).toBe(true);
    const audits = await d.select().from(schema.auditLog);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actor === "migration" && a.action === "printer.update")).toBe(true);
  });
});
