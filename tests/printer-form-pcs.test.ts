import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { fakeGuid } from "@/lib/directory/fake";
import { planComputerChanges, PrinterComputersField } from "@/lib/printer-computers";

/*
 * savePrinter with "Assign to specific PCs" (per-computer add overrides), against a real Postgres (PGlite in-process)
 * with the repo's migrations, plus the DEFAULT_LEGACY_TAKEOVER default and the hidden share list.
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
const ADM01 = fakeGuid("ADM-01");
const LAB01 = fakeGuid("LAB-01");
const LIB01 = fakeGuid("LIB-01");
const TCH01 = fakeGuid("TCH-01");

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

async function overrides() {
  return (await d.select().from(schema.computerOverrides)).sort((a, b) => a.computerName.localeCompare(b.computerName));
}

beforeAll(async () => {
  const client = new PGlite();
  d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  pg.db = d;
});

beforeEach(async () => {
  delete process.env.DEFAULT_LEGACY_TAKEOVER;
  await d.delete(schema.auditLog);
  await d.delete(schema.ouSettings);
  await d.delete(schema.printers);
});

describe("savePrinter with specific PCs", () => {
  it("creates the printer and its per-PC overrides in one go, with audit rows", async () => {
    const { savePrinter } = await actions();
    const r = await savePrinter(
      null,
      form({ name: "Front Office", ous: JSON.stringify([{ ouDn: ADM, isDefault: false }]), computers: JSON.stringify([LAB01, LIB01.toUpperCase(), LAB01]) }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain("1 OU added, 2 PCs added");

    const [p] = await d.select().from(schema.printers);
    expect((await overrides()).map((o) => [o.computerName, o.computerGuid, o.action, o.makeDefault, o.printerId])).toEqual([
      ["LAB-01", LAB01, "add", false, p.id],
      ["LIB-01", LIB01, "add", false, p.id],
    ]);
    const log = await auditRows();
    expect(log.map((a) => [a.action, a.entityType, a.entityId])).toEqual([
      ["printer.create", "printer", p.id],
      ["assignment.add", "ou", ADM],
      ["override.add", "computer", LAB01],
      ["override.add", "computer", LIB01],
    ]);
    expect(log[2].details).toMatchObject({ computer: "LAB-01", printerId: p.id, printer: "Front Office", via: "printer-form" });
  });

  it("edits by diff: adds, removes, keeps unchanged PCs (and their default flag) and never touches blocks", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Copier", computers: JSON.stringify([LAB01, LIB01]) }));
    const [p] = await d.select().from(schema.printers);
    await d.update(schema.computerOverrides).set({ makeDefault: true }).where((await import("drizzle-orm")).eq(schema.computerOverrides.computerGuid, LAB01));
    await d.insert(schema.computerOverrides).values({ computerGuid: TCH01, computerName: "TCH-01", printerId: p.id, action: "block" });
    await d.delete(schema.auditLog);

    const r = await savePrinter(null, form({ id: p.id, name: "Copier", computers: JSON.stringify([LAB01, ADM01]) }));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain("1 PC added, 1 PC removed");
    expect((await overrides()).map((o) => [o.computerName, o.action, o.makeDefault])).toEqual([
      ["ADM-01", "add", false],
      ["LAB-01", "add", true],
      ["TCH-01", "block", false],
    ]);
    const log = await auditRows();
    expect(log.map((a) => [a.action, a.entityId, (a.details as { computer?: string })?.computer])).toEqual([
      ["printer.update", p.id, undefined],
      ["override.add", ADM01, "ADM-01"],
      ["override.remove", LIB01, "LIB-01"],
    ]);
  });

  it("keeps overrides when the form has no computers field", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Lab", computers: JSON.stringify([LAB01]) }));
    const [p] = await d.select().from(schema.printers);
    await d.delete(schema.auditLog);
    expect(await savePrinter(null, form({ id: p.id, name: "Lab 2" }))).toMatchObject({ ok: true });
    expect(await overrides()).toHaveLength(1);
    expect((await auditRows()).map((a) => a.action)).toEqual(["printer.update"]);
  });

  it("refuses a PC that blocks this printer and saves nothing", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Blocked" }));
    const [p] = await d.select().from(schema.printers);
    await d.insert(schema.computerOverrides).values({ computerGuid: TCH01, computerName: "TCH-01", printerId: p.id, action: "block" });
    await d.delete(schema.auditLog);
    const r = await savePrinter(null, form({ id: p.id, name: "Renamed", computers: JSON.stringify([TCH01]) }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("TCH-01") });
    expect((await d.select().from(schema.printers))[0].name).toBe("Blocked");
    expect(await auditRows()).toHaveLength(0);
  });

  it("rejects computers that are not in the directory and saves nothing", async () => {
    const { savePrinter } = await actions();
    const r = await savePrinter(null, form({ name: "Ghost", computers: JSON.stringify(["00000000-0000-4000-8000-000000000000"]) }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("not in the directory") });
    expect(await d.select().from(schema.printers)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("rolls back the overrides when the printer insert fails (duplicate name)", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Dup" }));
    await d.delete(schema.auditLog);
    const r = await savePrinter(null, form({ name: "Dup", computers: JSON.stringify([LAB01]) }));
    expect(r).toEqual({ ok: false, error: "A printer with that name already exists" });
    expect(await overrides()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("rejects a malformed computer list", async () => {
    const { savePrinter } = await actions();
    expect(await savePrinter(null, form({ name: "Bad", computers: "[\"not-a-guid\"]" }))).toMatchObject({ ok: false });
    expect(await savePrinter(null, form({ name: "Bad", computers: "{" }))).toMatchObject({ ok: false });
  });

  it("previewPrinterReach counts OUs plus PCs, each computer once", async () => {
    const { previewPrinterReach } = await actions();
    // Administration and its child OUs: 5 computers.
    expect(await previewPrinterReach(null, [ADM], [])).toEqual({ ok: true, computers: 5 });
    expect(await previewPrinterReach(null, [ADM], [ADM01])).toEqual({ ok: true, computers: 5 });
    expect(await previewPrinterReach(null, [ADM], [ADM01, LAB01, LIB01])).toEqual({ ok: true, computers: 7 });
    expect(await previewPrinterReach(null, [], [LAB01])).toEqual({ ok: true, computers: 1 });
    expect(await previewPrinterReach(null, [], [])).toEqual({ ok: true, computers: 0 });
  });

  it("previewPrinterReach replaces the printer's stored PCs with the form's list", async () => {
    const { savePrinter, previewPrinterReach } = await actions();
    await savePrinter(null, form({ name: "Stored", computers: JSON.stringify([LAB01, LIB01]) }));
    const [p] = await d.select().from(schema.printers);
    expect(await previewPrinterReach(p.id, [], [LAB01])).toEqual({ ok: true, computers: 1 });
    // No list: the stored overrides count.
    expect(await previewPrinterReach(p.id, [ADM])).toEqual({ ok: true, computers: 7 });
  });
});

describe("legacy takeover default and hidden share list", () => {
  it("new printers get DEFAULT_LEGACY_TAKEOVER (on unless set); edits keep the stored value when the field is absent", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Default on" }));
    await savePrinter(null, form({ name: "Explicit off", host: "192.0.2.11", legacyTakeover: "off" }));
    const rows = await d.select().from(schema.printers);
    expect(rows.find((p) => p.name === "Default on")?.legacyTakeover).toBe("on");
    expect(rows.find((p) => p.name === "Explicit off")?.legacyTakeover).toBe("off");

    const on = rows.find((p) => p.name === "Default on")!;
    await savePrinter(null, form({ id: on.id, name: "Default on" }));
    expect((await d.select().from(schema.printers)).find((p) => p.id === on.id)?.legacyTakeover).toBe("on");
  });

  it("DEFAULT_LEGACY_TAKEOVER accepts on, dry-run and off and defaults to on", async () => {
    for (const [env, want] of [[undefined, "on"], ["dry-run", "dry-run"], ["OFF", "off"]] as const) {
      vi.resetModules();
      if (env) process.env.DEFAULT_LEGACY_TAKEOVER = env;
      else delete process.env.DEFAULT_LEGACY_TAKEOVER;
      const { config } = await import("@/lib/config");
      expect(config().DEFAULT_LEGACY_TAKEOVER).toBe(want);
    }
    vi.resetModules();
    process.env.DEFAULT_LEGACY_TAKEOVER = "maybe";
    const { config } = await import("@/lib/config");
    expect(() => config()).toThrow();
    delete process.env.DEFAULT_LEGACY_TAKEOVER;
    vi.resetModules();
  });

  it("keeps stored share names when the form does not send the field, and clears them when it sends an empty one", async () => {
    const { savePrinter } = await actions();
    await savePrinter(null, form({ name: "Shared", legacyShares: "StaffRoom, StaffRoom2" }));
    const [p] = await d.select().from(schema.printers);
    expect(p.legacyShares).toEqual(["StaffRoom", "StaffRoom2"]);
    await savePrinter(null, form({ id: p.id, name: "Shared" }));
    expect((await d.select().from(schema.printers))[0].legacyShares).toEqual(["StaffRoom", "StaffRoom2"]);
    await savePrinter(null, form({ id: p.id, name: "Shared", legacyShares: "" }));
    expect((await d.select().from(schema.printers))[0].legacyShares).toEqual([]);
  });
});

describe("planComputerChanges", () => {
  it("diffs add overrides case-insensitively and reports blocked picks", () => {
    const cur = [
      { computerGuid: LAB01, computerName: "LAB-01", action: "add" as const, makeDefault: false },
      { computerGuid: LIB01, computerName: "LIB-01", action: "add" as const, makeDefault: true },
      { computerGuid: TCH01, computerName: "TCH-01", action: "block" as const, makeDefault: false },
    ];
    expect(planComputerChanges(cur, [LAB01, ADM01, TCH01])).toEqual({
      added: [ADM01],
      removed: [{ computerGuid: LIB01, computerName: "LIB-01" }],
      blocked: [{ computerGuid: TCH01, computerName: "TCH-01" }],
    });
    expect(planComputerChanges(cur, [LAB01, LIB01])).toEqual({ added: [], removed: [], blocked: [] });
  });

  it("parses the form field into unique lower-case GUIDs", () => {
    expect(PrinterComputersField.parse(JSON.stringify([LAB01.toUpperCase(), LAB01]))).toEqual([LAB01]);
    expect(PrinterComputersField.safeParse("[1]").success).toBe(false);
  });
});
