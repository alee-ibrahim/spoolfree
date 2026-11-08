import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import type { db as dbFn } from "../db";
import * as schema from "../db/schema";
import { driverNames, inspectDriverPackage, type PackageInspection } from "./package";
import { fileSource } from "./zip";
import type { PackageForMatch } from "./auto";

/**
 * Driver package storage: the zip goes to a temporary file first (hashed and size-checked while it streams in), is
 * inspected there, and is then copied into Postgres (driver_packages + driver_package_chunks, 4 MiB per row). Used by
 * the admin upload route and the CLI (drivers upload), so both validate and audit the same way.
 */

type Db = ReturnType<typeof dbFn>;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const PACKAGE_NAME_RE = /^[^\\/<>:"|?*\x00-\x1f]{1,100}$/;

export class UploadTooLargeError extends Error {}

export interface ReceivedFile {
  path: string;
  size: number;
  sha256: string;
}

/** Streams bytes to a new temporary file, hashing them; throws UploadTooLargeError past maxBytes (the file is removed). */
export async function receiveToTempFile(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<ReceivedFile> {
  const file = path.join(tmpdir(), `spoolfree-driver-${randomBytes(8).toString("hex")}.zip`);
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new UploadTooLargeError(`the package is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (e) {
    out.destroy();
    await rm(file, { force: true });
    throw e;
  }
  return { path: file, size, sha256: hash.digest("hex") };
}

export interface IngestInput {
  name: string;
  file: ReceivedFile;
  fileName?: string | null;
  uploadedBy: string;
  universal?: boolean;
  /** Universal packages: the driver auto mode uses (default: the first model). */
  universalDriver?: string | null;
}

export type IngestResult =
  | { ok: true; package: schema.DriverPackage; inspection: PackageInspection; duplicateOf: string | null }
  | { ok: false; error: string };

export function packageNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (!PACKAGE_NAME_RE.test(n)) return "Name must be 1-100 characters without \\ / < > : \" | ? *";
  return null;
}

/** Inspects the received zip and stores it. The temporary file is always removed. */
export async function ingestDriverPackage(d: Db, input: IngestInput): Promise<IngestResult> {
  try {
    const name = input.name.trim();
    const invalid = packageNameError(name);
    if (invalid) return { ok: false, error: invalid };
    const src = await fileSource(input.file.path);
    let inspection: PackageInspection;
    try {
      inspection = await inspectDriverPackage(src);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      await src.close();
    }
    const names = driverNames(inspection.infs);
    let universalDriver: string | null = null;
    if (input.universal) {
      const want = input.universalDriver?.trim();
      universalDriver = want ? (names.find((n) => n.toLowerCase() === want.toLowerCase()) ?? null) : names[0];
      if (!universalDriver) return { ok: false, error: `"${want}" is not a driver in this package (${names.join("; ")})` };
    }
    const [clash] = await d.select({ id: schema.driverPackages.id }).from(schema.driverPackages).where(sql`lower(${schema.driverPackages.name}) = lower(${name})`);
    if (clash) return { ok: false, error: `A driver package named "${name}" already exists` };
    const [dup] = await d.select({ name: schema.driverPackages.name }).from(schema.driverPackages).where(eq(schema.driverPackages.sha256, input.file.sha256));

    const fh = await open(input.file.path, "r");
    try {
      const row = await d.transaction(async (tx) => {
        const [pkg] = await tx
          .insert(schema.driverPackages)
          .values({
            name,
            fileName: input.fileName?.slice(0, 255) ?? null,
            size: input.file.size,
            sha256: input.file.sha256,
            architecture: "x64",
            universal: !!input.universal,
            universalDriver,
            manufacturer: inspection.manufacturer,
            infs: inspection.infs,
            uploadedBy: input.uploadedBy,
          })
          .returning();
        // Copy the file in 4 MiB rows, re-hashing to be sure the stored bytes are the inspected ones.
        const hash = createHash("sha256");
        const buf = Buffer.alloc(CHUNK_BYTES);
        let seq = 0;
        let offset = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, offset);
          if (!bytesRead) break;
          const data = Buffer.from(buf.subarray(0, bytesRead));
          hash.update(data);
          await tx.insert(schema.driverPackageChunks).values({ packageId: pkg.id, seq: seq++, data });
          offset += bytesRead;
        }
        if (offset !== input.file.size || hash.digest("hex") !== input.file.sha256) throw new Error("the package changed while it was stored");
        await tx.insert(schema.auditLog).values({
          actor: input.uploadedBy,
          action: "driver.upload",
          entityType: "driver_package",
          entityId: pkg.id,
          details: {
            name,
            fileName: input.fileName ?? null,
            size: input.file.size,
            sha256: input.file.sha256,
            universal: !!input.universal,
            universalDriver,
            manufacturer: inspection.manufacturer,
            drivers: names,
          },
        });
        return pkg;
      });
      return { ok: true, package: row, inspection, duplicateOf: dup?.name ?? null };
    } finally {
      await fh.close();
    }
  } finally {
    await rm(input.file.path, { force: true });
  }
}

/** Packages without their bytes, newest first. */
export async function listDriverPackages(d: Executor): Promise<schema.DriverPackage[]> {
  return d.select().from(schema.driverPackages).orderBy(sql`${schema.driverPackages.uploadedAt} desc`);
}

export function toPackageForMatch(p: schema.DriverPackage): PackageForMatch {
  return {
    id: p.id,
    name: p.name,
    sha256: p.sha256,
    size: p.size,
    universal: p.universal,
    universalDriver: p.universalDriver,
    manufacturer: p.manufacturer,
    infs: p.infs,
    uploadedAt: p.uploadedAt,
  };
}

export async function findDriverPackageByName(d: Executor, name: string): Promise<schema.DriverPackage | null> {
  const [row] = await d.select().from(schema.driverPackages).where(sql`lower(${schema.driverPackages.name}) = lower(${name.trim()})`);
  return row ?? null;
}

export type DeleteResult = { ok: true; name: string } | { ok: false; error: string };

/** Deletes a package unless a printer is set to it manually (auto mode re-matches at the next manifest). */
export async function deleteDriverPackage(d: Db, actor: string, id: string): Promise<DeleteResult> {
  return d.transaction(async (tx) => {
    const [pkg] = await tx.select().from(schema.driverPackages).where(eq(schema.driverPackages.id, id));
    if (!pkg) return { ok: false, error: "Driver package not found" };
    const users = await tx.select({ name: schema.printers.name }).from(schema.printers).where(eq(schema.printers.driverPackageId, id));
    if (users.length) return { ok: false, error: `In use by ${users.map((u) => u.name).join(", ")}: set those printers to another driver first` };
    await tx.delete(schema.driverPackages).where(eq(schema.driverPackages.id, id));
    await tx.insert(schema.auditLog).values({
      actor,
      action: "driver.delete",
      entityType: "driver_package",
      entityId: id,
      details: { name: pkg.name, sha256: pkg.sha256, size: pkg.size },
    });
    return { ok: true, name: pkg.name };
  });
}

/** The package bytes, one stored chunk at a time (for streaming responses). */
export async function* packageChunks(d: Executor, id: string): AsyncGenerator<Buffer> {
  const [{ n }] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.driverPackageChunks).where(eq(schema.driverPackageChunks.packageId, id));
  for (let seq = 0; seq < n; seq++) {
    const [row] = await d
      .select({ data: schema.driverPackageChunks.data })
      .from(schema.driverPackageChunks)
      .where(sql`${schema.driverPackageChunks.packageId} = ${id} and ${schema.driverPackageChunks.seq} = ${seq}`)
      .orderBy(asc(schema.driverPackageChunks.seq));
    if (!row) throw new Error(`driver package ${id}: chunk ${seq} is missing`);
    yield row.data;
  }
}
