import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { CHUNK_BYTES, deleteDriverPackage, ingestDriverPackage, packageChunks, receiveToTempFile, UploadTooLargeError } from "@/lib/drivers/store";
import { exportYaml, loadState, parseInput, plan } from "@/lib/bulk";
import { brotherInf, makeZip } from "./helpers/zip";

/* Driver package storage (Postgres chunks), the drivers CLI and bulk import of driver settings, against PGlite. */

const pg = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;
let out: string[];
let err: string[];

async function* chunksOf(buf: Buffer, size = 1000) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

function brotherZip(extra = 0) {
  return makeZip([
    { name: "BROCH12A.INF", data: brotherInf({ utf16: true }) },
    { name: "BROCH12A.CAT", data: "catalog" },
    // Incompressible padding so the package spans several 4 MiB chunks.
    ...(extra ? [{ name: "amd64/big.dl_", data: randomish(extra), store: true }] : []),
  ]);
}

function randomish(n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x >> 16;
  }
  return b;
}

async function upload(name: string, zip: Buffer, extra: Partial<Parameters<typeof ingestDriverPackage>[1]> = {}) {
  const file = await receiveToTempFile(chunksOf(zip), 200 * 1024 * 1024);
  return ingestDriverPackage(d as never, { name, file, uploadedBy: "admin@example.org", ...extra });
}

beforeAll(async () => {
  d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  pg.db = d;
});

beforeEach(async () => {
  await d.delete(schema.auditLog);
  await d.delete(schema.printers);
  await d.delete(schema.driverPackages);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("driver package storage", () => {
  it("stores the zip in chunks with its INF facts, and streams the same bytes back", async () => {
    const zip = brotherZip(CHUNK_BYTES + 1234);
    const r = await upload("Brother HL-3150CDN", zip, { fileName: "brother.zip" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.package.sha256).toBe(createHash("sha256").update(zip).digest("hex"));
    expect(r.package.size).toBe(zip.length);
    expect(r.package.manufacturer).toBe("Brother");
    expect(r.package.infs[0].models.map((m) => m.name)).toContain("Brother HL-3150CDN series");
    expect(await d.select().from(schema.driverPackageChunks)).toHaveLength(2);
    const parts: Buffer[] = [];
    for await (const c of packageChunks(d as never, r.package.id)) parts.push(c);
    expect(Buffer.concat(parts).equals(zip)).toBe(true);
    const [a] = await d.select().from(schema.auditLog);
    expect(a).toMatchObject({ action: "driver.upload", actor: "admin@example.org", entityId: r.package.id });
  });

  it("refuses duplicate names, invalid packages and oversized uploads", async () => {
    expect((await upload("Pkg", brotherZip())).ok).toBe(true);
    expect(await upload("pkg", brotherZip())).toEqual({ ok: false, error: 'A driver package named "pkg" already exists' });
    const unsigned = makeZip([{ name: "x.inf", data: brotherInf({ catalog: null }) }]);
    expect(await upload("Unsigned", unsigned)).toMatchObject({ ok: false, error: expect.stringMatching(/no CatalogFile/) });
    await expect(receiveToTempFile(chunksOf(Buffer.alloc(5000)), 4000)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it("universal packages record the driver auto mode uses", async () => {
    const r = await upload("Brother Universal", brotherZip(), { universal: true, universalDriver: "brother hl-3170cdw series" });
    expect(r.ok && r.package.universalDriver).toBe("Brother HL-3170CDW series");
    expect(await upload("Bad", brotherZip(), { universal: true, universalDriver: "Nope" })).toMatchObject({ ok: false });
  });

  it("delete is refused while a printer uses the package manually", async () => {
    const r = await upload("Pkg", brotherZip());
    if (!r.ok) throw new Error(r.error);
    await d.insert(schema.printers).values({ name: "Bureau", host: "192.0.2.12", driverMode: "vendor", driverPackageId: r.package.id, driverName: "Brother HL-3150CDN series" });
    expect(await deleteDriverPackage(d as never, "admin", r.package.id)).toEqual({ ok: false, error: expect.stringMatching(/In use by Bureau/) });
    await d.delete(schema.printers);
    expect(await deleteDriverPackage(d as never, "admin", r.package.id)).toEqual({ ok: true, name: "Pkg" });
    expect(await d.select().from(schema.driverPackageChunks)).toHaveLength(0);
  });
});

describe("drivers CLI", () => {
  async function cli(...argv: string[]) {
    const { driversCli } = await import("../scripts/drivers");
    return driversCli(argv);
  }

  it("uploads from a file, lists, decides and deletes", async () => {
    const file = path.join(tmpdir(), `spoolfree-test-${process.pid}.zip`);
    writeFileSync(file, brotherZip());
    expect(await cli("upload", "Brother HL-3150CDN", file)).toBe(0);
    expect(out.join("\n")).toMatch(/uploaded Brother HL-3150CDN/);
    expect(out.join("\n")).toMatch(/driver +Brother HL-3150CDN series +\[USBPRINT\\BROTHERHL-3150CDN_SEED27/);
    await d.insert(schema.printers).values({
      name: "8F Bureau",
      host: "192.0.2.12",
      deviceId: "MFG:Brother;MDL:HL-3150CDN series;",
      lastTest: { ok: true, formats: ["image/urf"], driverlessFormats: ["image/urf"], ippVersions: ["1.1"], model: null, uuid: null, features: [], color: true, duplex: true, problems: [] },
    });
    out = [];
    expect(await cli("decide")).toBe(0);
    expect(out[0]).toMatch(/^8F Bureau\t\[auto\] vendor +Brother HL-3150CDN series from "Brother HL-3150CDN" \(exact\) via raw9100\tIPP 1.1 only$/);
    expect(await cli("delete", "Brother HL-3150CDN", "--dry-run")).toBe(0);
    expect(await cli("upload", "only-one-arg")).toBe(2);
    expect(await cli("delete", "Brother HL-3150CDN")).toBe(0);
  });
});

describe("bulk import/export of driver settings", () => {
  it("round-trips driverMode, package, driver, protocol and LPR queue", async () => {
    const r = await upload("Brother HL-3150CDN", brotherZip());
    if (!r.ok) throw new Error(r.error);
    const yaml = `
printers:
  - name: Bureau
    host: 192.0.2.12
    driverMode: vendor
    driverPackage: brother hl-3150cdn
    driverName: brother hl-3150cdn series
    protocol: lpr
    lprQueue: BINARY_P1
`;
    const cur = await loadState();
    const steps = plan(parseInput(yaml, "yaml"), cur);
    expect(steps[0]).toMatchObject({ kind: "create", spec: { driverMode: "vendor", driverPackageId: r.package.id, driverName: "Brother HL-3150CDN series", vendorProtocol: "lpr", lprQueue: "BINARY_P1" } });
    const { apply } = await import("@/lib/bulk");
    await apply(steps);
    const after = await loadState();
    expect(exportYaml(after)).toMatch(/driverMode: vendor\n {4}driverPackage: Brother HL-3150CDN\n {4}driverName: Brother HL-3150CDN series\n {4}protocol: lpr\n {4}lprQueue: BINARY_P1/);
    expect(plan(parseInput(exportYaml(after), "yaml"), after).every((s) => s.kind === "unchanged")).toBe(true);
    expect(() => plan(parseInput(yaml.replace("brother hl-3150cdn\n", "nope\n"), "yaml"), after)).toThrow(/unknown driver package "nope"/);
    expect(() => parseInput("- name: X\n  host: h\n  driverMode: vendor\n", "yaml")).toThrow(/needs driverPackage and driverName/);
  });
});
