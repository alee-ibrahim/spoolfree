import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { ouShortName } from "@/lib/format";
import { filterPrinters, parsePrinterFilters } from "@/lib/list-filters/printers";

/* The printers list's OU and PC badges: one aggregated query for every printer, and the OU filter they link to. */

const pg = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});

const FIN = "OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org";
const LAB = "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org";
const L1 = "OU=L1,OU=Floors,DC=example,DC=org";

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;

beforeAll(async () => {
  d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  pg.db = d;
});

describe("printer assignments for the list", () => {
  it("returns each printer's OUs (with OU defaults) and PC overrides in one query", async () => {
    const [copier, laser, idle] = await d
      .insert(schema.printers)
      .values([
        { name: "Copier", host: "192.0.2.10" },
        { name: "Laser", host: "192.0.2.11" },
        { name: "Idle", host: "192.0.2.12" },
      ])
      .returning();
    await d.insert(schema.ouAssignments).values([
      { ouDn: FIN, printerId: copier.id },
      { ouDn: LAB, printerId: copier.id },
      { ouDn: L1, printerId: copier.id },
      { ouDn: LAB, printerId: laser.id },
    ]);
    await d.insert(schema.ouSettings).values([{ ouDn: FIN.toLowerCase(), defaultPrinterId: copier.id }]);
    await d.insert(schema.computerOverrides).values([
      { computerGuid: "g-hr-01", computerName: "HR-01", printerId: copier.id, action: "add", makeDefault: true },
      { computerGuid: "g-lib-01", computerName: "LIB-01", printerId: copier.id, action: "block" },
      { computerGuid: "g-fin-02", computerName: "fin-02", printerId: laser.id, action: "add" },
    ]);

    const { loadPrinterAssignments } = await import("@/lib/printer-assignments");
    const spy = vi.spyOn(d, "execute");
    const selectSpy = vi.spyOn(d, "select");
    const map = await loadPrinterAssignments();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(selectSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    selectSpy.mockRestore();

    expect(map.get(copier.id)!.ous).toEqual([
      { ouDn: FIN, isDefault: true },
      { ouDn: L1, isDefault: false },
      { ouDn: LAB, isDefault: false },
    ]);
    expect(map.get(copier.id)!.pcs).toEqual([
      { computerGuid: "g-hr-01", computerName: "HR-01", action: "add", makeDefault: true },
      { computerGuid: "g-lib-01", computerName: "LIB-01", action: "block", makeDefault: false },
    ]);
    expect(map.get(laser.id)).toEqual({ ous: [{ ouDn: LAB, isDefault: false }], pcs: [{ computerGuid: "g-fin-02", computerName: "fin-02", action: "add", makeDefault: false }] });
    expect(map.get(idle.id)).toEqual({ ous: [], pcs: [] });

    // An OU badge links to ?ou=<dn>; the existing OU filter then keeps exactly the printers assigned to it.
    const rows = [copier, laser, idle].map((p) => ({ ...p, ouDns: map.get(p.id)!.ous.map((o) => o.ouDn), status: null, resolvedDriver: "driverless" as const, driverNeeded: false }));
    const f = parsePrinterFilters({ ou: LAB });
    expect(filterPrinters(rows, f).map((p) => p.name)).toEqual(["Copier", "Laser"]);
    expect(filterPrinters(rows, parsePrinterFilters({ ou: L1.toUpperCase() })).map((p) => p.name)).toEqual(["Copier"]);
  });

  it("shortens an OU DN to its own name", () => {
    expect(ouShortName(FIN)).toBe("Finance");
    expect(ouShortName("OU=Sales\\, East,OU=Branches,DC=example,DC=org")).toBe("Sales, East");
    expect(ouShortName("CN=Computers,DC=example,DC=org")).toBe("Computers");
  });
});
