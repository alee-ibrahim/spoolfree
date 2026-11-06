import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { FakeDirectory, fakeGuid } from "@/lib/directory/fake";
import { planOuChanges, printerReach } from "@/lib/printer-ous";
import type { Policy } from "@/lib/resolve";

/*
 * savePrinter with OU assignments, against a real Postgres (PGlite in-process) with the repo's migrations.
 */

const pg = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ email: "admin@example.org" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/directory", async () => {
  const { FakeDirectory: FD } = await import("@/lib/directory/fake");
  const dir = new FD();
  return { directory: () => dir, baseDn: () => dir.baseDn };
});

const ADM = "OU=Administration,OU=Workstations,DC=example,DC=org";
const FIN = "OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org";
const LAB = "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org";
const LIB = "OU=Library,OU=Workstations,DC=example,DC=org";

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ host: "192.0.2.10", ippPathOverride: "/ipp/print", ...fields })) fd.set(k, v);
  return fd;
}

async function actions() {
  return import("@/app/(admin)/actions");
}

async function auditRows() {
  return (await d.select().from(schema.auditLog)).sort((a, b) => a.id - b.id);
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
});

describe("savePrinter with OU assignments", () => {
  it("creates the printer and its assignments in one go, with audit rows", async () => {
    const { savePrinter } = await actions();
    const r = await savePrinter(null, form({ name: "Front Office", ous: JSON.stringify([{ ouDn: ADM, isDefault: true }, { ouDn: LAB, isDefault: false }]) }));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain("2 OUs added");

    const [p] = await d.select().from(schema.printers);
    const assigned = await d.select().from(schema.ouAssignments);
    expect(assigned.map((a) => a.ouDn).sort()).toEqual([ADM, LAB].sort());
    expect(assigned.every((a) => a.printerId === p.id)).toBe(true);
    const settings = await d.select().from(schema.ouSettings);
    expect(settings).toMatchObject([{ ouDn: ADM, defaultPrinterId: p.id }]);

    const log = await auditRows();
    expect(log.map((a) => [a.action, a.entityId])).toEqual([
      ["printer.create", p.id],
      ["assignment.add", ADM],
      ["assignment.add", LAB],
      ["ou.default", ADM],
    ]);
    expect(log[1].details).toMatchObject({ printerId: p.id, via: "printer-form" });
  });

  it("edits by diff: adds, removes, flips defaults and leaves unchanged OUs alone", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Copier", ous: JSON.stringify([{ ouDn: ADM, isDefault: true }, { ouDn: LAB, isDefault: false }]) }));
    const [p] = await d.select().from(schema.printers);
    await d.delete(schema.auditLog);

    // Different case for ADM must count as the same OU.
    const r = await savePrinter(
      null,
      form({ id: p.id, name: "Copier", ous: JSON.stringify([{ ouDn: ADM.toUpperCase(), isDefault: false }, { ouDn: LIB, isDefault: true }]) }),
    );
    expect(r).toMatchObject({ ok: true });
    const assigned = (await d.select().from(schema.ouAssignments)).map((a) => a.ouDn).sort();
    expect(assigned).toEqual([ADM, LIB].sort());
    const settings = await d.select().from(schema.ouSettings);
    expect(settings.find((s) => s.ouDn === ADM)?.defaultPrinterId).toBeNull();
    expect(settings.find((s) => s.ouDn === LIB)?.defaultPrinterId).toBe(p.id);

    const log = await auditRows();
    expect(log.map((a) => [a.action, a.entityId, (a.details as { printerId?: string | null })?.printerId])).toEqual([
      ["printer.update", p.id, undefined],
      ["assignment.add", LIB, p.id],
      ["assignment.remove", LAB, p.id],
      ["ou.default", ADM, null],
      ["ou.default", LIB, p.id],
    ]);
  });

  it("keeps assignments when the form has no OU field and writes no assignment audit", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Lab", ous: JSON.stringify([{ ouDn: LAB, isDefault: false }]) }));
    const [p] = await d.select().from(schema.printers);
    await d.delete(schema.auditLog);
    expect(await savePrinter(null, form({ id: p.id, name: "Lab 2" }))).toMatchObject({ ok: true });
    expect(await d.select().from(schema.ouAssignments)).toHaveLength(1);
    expect((await auditRows()).map((a) => a.action)).toEqual(["printer.update"]);
  });

  it("replaces another printer's default and records the previous one", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Old", ous: JSON.stringify([{ ouDn: FIN, isDefault: true }]) }));
    const [old] = await d.select().from(schema.printers);
    await savePrinter(null, form({ name: "New", host: "192.0.2.11", ous: JSON.stringify([{ ouDn: FIN, isDefault: true }]) }));
    const neu = (await d.select().from(schema.printers)).find((p) => p.name === "New")!;
    const [s] = await d.select().from(schema.ouSettings);
    expect(s.defaultPrinterId).toBe(neu.id);
    const last = (await auditRows()).at(-1)!;
    expect(last).toMatchObject({ action: "ou.default", entityId: FIN, details: { printerId: neu.id, previous: old.id } });
  });

  it("rejects OUs that are not in the directory and saves nothing", async () => {
    const { savePrinter } = await actions();
    const r = await savePrinter(null, form({ name: "Ghost", ous: JSON.stringify([{ ouDn: "OU=Nope,DC=example,DC=org", isDefault: false }]) }));
    expect(r).toMatchObject({ ok: false });
    expect(await d.select().from(schema.printers)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("rolls back the assignments when the printer insert fails (duplicate name)", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Dup" }));
    await d.delete(schema.auditLog);
    const r = await savePrinter(null, form({ name: "Dup", ous: JSON.stringify([{ ouDn: LAB, isDefault: false }]) }));
    expect(r).toEqual({ ok: false, error: "A printer with that name already exists" });
    expect(await d.select().from(schema.ouAssignments)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("rejects a malformed OU list", async () => {
    const { savePrinter } = await actions();
    expect(await savePrinter(null, form({ name: "Bad", ous: "{not json" }))).toMatchObject({ ok: false });
  });

  it("previewPrinterReach counts computers in the OUs and their children", async () => {
    const { previewPrinterReach } = await actions();
    // Workstations > Administration (ADM-01, ADM-02) + Finance (2) + HR (1).
    expect(await previewPrinterReach(null, [ADM])).toEqual({ ok: true, computers: 5 });
    expect(await previewPrinterReach(null, [ADM, FIN])).toEqual({ ok: true, computers: 5 });
  });
});

describe("planOuChanges", () => {
  it("diffs assignments and defaults case-insensitively", () => {
    expect(planOuChanges([ADM, LAB], [ADM], [{ ouDn: ADM.toLowerCase(), isDefault: true }, { ouDn: LIB, isDefault: true }])).toEqual({
      added: [LIB],
      removed: [LAB],
      defaultSet: [LIB],
      defaultCleared: [],
    });
    expect(planOuChanges([ADM], [ADM], [])).toEqual({ added: [], removed: [ADM], defaultSet: [], defaultCleared: [ADM] });
  });
});

describe("printerReach", () => {
  it("honours blocked inheritance, disabled computers and overrides", async () => {
    const computers = await new FakeDirectory().listComputers();
    const pid = "11111111-1111-4111-8111-111111111111";
    const base: Policy = { baseDn: "DC=example,DC=org", assignments: [], ouSettings: [], overrides: [] };
    const all = printerReach(base, computers, pid, ["DC=example,DC=org"]).computers;
    expect(all).toBe(computers.filter((c) => !c.disabled).length);
    const blocked: Policy = {
      ...base,
      ouSettings: [{ ouDn: "OU=Kiosks,OU=Library,OU=Workstations,DC=example,DC=org", blockInheritance: true, blockedPrinterIds: [], defaultPrinterId: null }],
    };
    expect(printerReach(blocked, computers, pid, [LIB]).computers).toBe(1); // LIB-01 only; kiosks block
    const override: Policy = { ...base, overrides: [{ computerGuid: fakeGuid("HR-01"), printerId: pid, action: "add", makeDefault: false }] };
    expect(printerReach(override, computers, pid, [LAB]).computers).toBe(3);
  });
});
