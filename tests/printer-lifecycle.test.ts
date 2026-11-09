import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

/*
 * printers delete / rename (CLI) and the admin UI's Delete, against a real Postgres (PGlite in-process) with the
 * repo's migrations. Both go through src/lib/printer-lifecycle.ts.
 */

const pg = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ email: "admin@example.org" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ADM = "OU=Administration,OU=Workstations,DC=example,DC=org";
const LAB = "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org";
const LIB = "OU=Library,OU=Workstations,DC=example,DC=org";

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;
let out: string[];
let err: string[];

async function cli(...argv: string[]) {
  const { printersCli } = await import("../scripts/printers");
  return printersCli(argv);
}

async function auditRows() {
  return (await d.select().from(schema.auditLog)).sort((a, b) => a.id - b.id);
}

async function addPrinter(name: string, host = "192.0.2.10") {
  const [row] = await d.insert(schema.printers).values({ name, host }).returning();
  return row;
}

/** Copier: assigned to ADM and LAB, ADM's default, blocked in LIB, one add and one block override. Other: LAB's default. */
async function seed() {
  const copier = await addPrinter("Copier");
  const other = await addPrinter("Other", "192.0.2.11");
  await d.insert(schema.ouAssignments).values([
    { ouDn: ADM, printerId: copier.id },
    { ouDn: LAB, printerId: copier.id },
    { ouDn: LAB, printerId: other.id },
  ]);
  await d.insert(schema.ouSettings).values([
    { ouDn: ADM, defaultPrinterId: copier.id },
    { ouDn: LAB, defaultPrinterId: other.id },
    { ouDn: LIB, blockedPrinterIds: [copier.id, other.id] },
  ]);
  await d.insert(schema.computerOverrides).values([
    { computerGuid: "g-hr-01", computerName: "HR-01", printerId: copier.id, action: "add", makeDefault: true },
    { computerGuid: "g-lib-01", computerName: "LIB-01", printerId: copier.id, action: "block" },
    { computerGuid: "g-lib-01", computerName: "LIB-01", printerId: other.id, action: "add" },
  ]);
  return { copier, other };
}

beforeAll(async () => {
  const client = new PGlite();
  d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  pg.db = d;
});

beforeEach(async () => {
  await d.delete(schema.auditLog);
  await d.delete(schema.ouSettings);
  await d.delete(schema.printers);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("printers delete", () => {
  it("--dry-run lists what would go and writes nothing", async () => {
    const { copier } = await seed();
    expect(await cli("delete", "copier", "--dry-run")).toBe(0);
    expect(out.join("\n")).toContain(`delete   Copier (${copier.id})`);
    expect(out).toContain(`unassign ${ADM}`);
    expect(out).toContain(`default  ${ADM}: cleared`);
    expect(out).toContain(`unblock  ${LIB}`);
    expect(out).toContain("unset    HR-01: add override");
    expect(out.at(-1)).toBe("2 assignment(s), 1 OU default(s), 1 OU block(s), 2 override(s) (dry run: nothing written).");
    expect(await d.select().from(schema.printers)).toHaveLength(2);
    expect(await d.select().from(schema.computerOverrides)).toHaveLength(3);
    expect(await auditRows()).toHaveLength(0);
  });

  it("removes the printer, assignments, defaults, blocks and overrides; leaves other printers alone", async () => {
    const { copier, other } = await seed();
    expect(await cli("delete", "Copier")).toBe(0);
    expect((await d.select().from(schema.printers)).map((p) => p.name)).toEqual(["Other"]);
    expect(await d.select().from(schema.ouAssignments)).toEqual([expect.objectContaining({ ouDn: LAB, printerId: other.id })]);
    const settings = Object.fromEntries((await d.select().from(schema.ouSettings)).map((s) => [s.ouDn, s]));
    expect(settings[ADM].defaultPrinterId).toBeNull();
    expect(settings[LAB].defaultPrinterId).toBe(other.id);
    expect(settings[LIB].blockedPrinterIds).toEqual([other.id]);
    expect(await d.select().from(schema.computerOverrides)).toEqual([expect.objectContaining({ computerName: "LIB-01", printerId: other.id })]);

    const log = await auditRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "cli", action: "printer.delete", entityType: "printer", entityId: copier.id });
    expect(log[0].details).toMatchObject({
      name: "Copier",
      host: "192.0.2.10",
      removed: { assignments: [ADM, LAB], defaults: [ADM], blockedIn: [LIB], overrides: [{ computer: "HR-01" }, { computer: "LIB-01" }] },
    });
  });

  it("fails cleanly on an unknown name or bad arguments", async () => {
    await seed();
    expect(await cli("delete", "Nope")).toBe(1);
    expect(err).toEqual(['error: no printer named "Nope"']);
    expect(await cli("delete")).toBe(2);
    expect(await cli("delete", "Copier", "--force")).toBe(2);
    expect(err.join("\n")).toContain("unknown option: --force");
    expect(await d.select().from(schema.printers)).toHaveLength(2);
    expect(await auditRows()).toHaveLength(0);
  });

  it("--help prints the usage", async () => {
    expect(await cli("delete", "--help")).toBe(0);
    expect(out.join("\n")).toContain("printers delete <name> [--dry-run]");
    expect(out.join("\n")).toContain("printers rename <old-name> <new-name> [--dry-run]");
  });
});

describe("printers rename", () => {
  it("--dry-run prints the rename and writes nothing", async () => {
    const { copier } = await seed();
    expect(await cli("rename", "COPIER", "Front Copier", "--dry-run")).toBe(0);
    expect(out).toEqual([`rename   Copier -> Front Copier (${copier.id}) (dry run: nothing written)`]);
    expect((await d.select().from(schema.printers)).map((p) => p.name).sort()).toEqual(["Copier", "Other"]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("keeps the id, revision, assignments, defaults and overrides; audits with actor cli", async () => {
    const { copier } = await seed();
    await d.insert(schema.auditLog).values({ actor: "admin@example.org", action: "printer.create", entityType: "printer", entityId: copier.id });
    expect(await cli("rename", "Copier", "Front Copier")).toBe(0);
    const [p] = await d.select().from(schema.printers).where(eq(schema.printers.name, "Front Copier"));
    expect(p).toMatchObject({ id: copier.id, revision: copier.revision, host: copier.host });
    expect((await d.select().from(schema.ouAssignments)).filter((a) => a.printerId === copier.id)).toHaveLength(2);
    expect((await d.select().from(schema.ouSettings)).find((s) => s.ouDn === ADM)?.defaultPrinterId).toBe(copier.id);
    expect((await d.select().from(schema.computerOverrides)).filter((o) => o.printerId === copier.id)).toHaveLength(2);

    const log = await auditRows();
    expect(log.map((a) => [a.actor, a.action, a.entityId])).toEqual([
      ["admin@example.org", "printer.create", copier.id],
      ["cli", "printer.update", copier.id],
    ]);
    expect(log[1].details).toMatchObject({ before: { name: "Copier", host: "192.0.2.10" }, after: { name: "Front Copier", host: "192.0.2.10" } });
  });

  it("allows a change of case only", async () => {
    await seed();
    expect(await cli("rename", "Copier", "COPIER")).toBe(0);
    expect((await d.select().from(schema.printers)).map((p) => p.name).sort()).toEqual(["COPIER", "Other"]);
  });

  it("fails cleanly on unknown, duplicate or invalid names", async () => {
    await seed();
    expect(await cli("rename", "Nope", "X")).toBe(1);
    expect(await cli("rename", "Copier", "other")).toBe(1);
    expect(await cli("rename", "Copier", "a/b")).toBe(1);
    expect(await cli("rename", "Copier", "x".repeat(101))).toBe(1);
    // 0.8.1 (L1): a double quote could add printui arguments on PCs.
    expect(await cli("rename", "Copier", 'X" /if /b "Y')).toBe(1);
    expect(await cli("rename", "Copier")).toBe(2);
    expect(err.slice(0, 5)).toEqual([
      'error: no printer named "Nope"',
      'error: A printer named "Other" already exists',
      'error: Name cannot contain \\ / , ! " or control characters',
      "error: Name is longer than 100 characters",
      'error: Name cannot contain \\ / , ! " or control characters',
    ]);
    expect((await d.select().from(schema.printers)).map((p) => p.name).sort()).toEqual(["Copier", "Other"]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("is a no-op when the name is the same", async () => {
    await seed();
    expect(await cli("rename", "copier", "Copier")).toBe(0);
    expect(out).toEqual(['unchanged Copier: already named "Copier".']);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("UI deletePrinter", () => {
  it("removes the same references through the shared code, audited as the admin", async () => {
    const { copier } = await seed();
    const { deletePrinter } = await import("@/app/(admin)/actions");
    expect(await deletePrinter(copier.id)).toEqual({ ok: true, message: "Deleted Copier" });
    expect((await d.select().from(schema.ouSettings)).find((s) => s.ouDn === LIB)?.blockedPrinterIds).not.toContain(copier.id);
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor: "admin@example.org", action: "printer.delete", entityId: copier.id, details: { removed: { defaults: [ADM] } } });
    expect(await deletePrinter(copier.id)).toEqual({ ok: false, error: "Printer not found" });
  });
});
