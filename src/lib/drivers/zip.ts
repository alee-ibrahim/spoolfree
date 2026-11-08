import { inflateRawSync } from "node:zlib";
import { open, type FileHandle } from "node:fs/promises";

/**
 * Minimal, dependency-free ZIP reader for driver packages: lists the central directory and reads single entries
 * (stored or deflated). Only what upload validation needs; the bytes themselves are stored as uploaded and agents
 * extract them with .NET's ZipFile. ZIP64 archives (> 4 GiB or > 65535 entries) are refused.
 */

export interface ZipSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ZipEntry {
  /** Path inside the zip with "/" separators. */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
  directory: boolean;
}

export class ZipError extends Error {}

export function bufferSource(buf: Buffer): ZipSource {
  return { size: buf.length, read: async (o, l) => buf.subarray(o, Math.min(buf.length, o + l)) };
}

/** A ZipSource over a file. Call close() when done. */
export async function fileSource(path: string): Promise<ZipSource & { close(): Promise<void> }> {
  const fh: FileHandle = await open(path, "r");
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const b = Buffer.alloc(len);
      if (len) await fh.read(b, 0, len, offset);
      return b;
    },
    close: () => fh.close(),
  };
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export async function listEntries(src: ZipSource, maxEntries = 20000): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError("not a zip file (too small)");
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file (no end of central directory)");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (count > maxEntries) throw new ZipError(`too many entries (${count} > ${maxEntries})`);
  if (cdOffset + cdSize > src.size) throw new ZipError("corrupt zip (central directory out of range)");
  const cd = await src.read(cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new ZipError("corrupt zip (bad central directory entry)");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    // Bit 11: UTF-8 names; otherwise CP437, which is ASCII for the names drivers use.
    const name = (flags & 0x800 ? rawName.toString("utf8") : rawName.toString("latin1")).replace(/\\/g, "/");
    out.push({ name, method, compressedSize, size, localHeaderOffset, encrypted: (flags & 1) === 1, directory: name.endsWith("/") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Reads and decompresses one entry (stored or deflate), refusing anything larger than maxBytes. */
export async function readEntry(src: ZipSource, e: ZipEntry, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  if (e.encrypted) throw new ZipError(`${e.name}: encrypted entries are not supported`);
  if (e.size > maxBytes) throw new ZipError(`${e.name}: larger than ${maxBytes} bytes`);
  const loc = await src.read(e.localHeaderOffset, 30);
  if (loc.length < 30 || loc.readUInt32LE(0) !== LOC_SIG) throw new ZipError(`${e.name}: bad local header`);
  const start = e.localHeaderOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  const data = await src.read(start, e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) {
    const out = inflateRawSync(data, { maxOutputLength: maxBytes });
    if (out.length !== e.size) throw new ZipError(`${e.name}: size mismatch after inflate`);
    return out;
  }
  throw new ZipError(`${e.name}: unsupported compression method ${e.method}`);
}

/** A path that would escape the extraction directory (absolute, drive letter, "..", empty segments). */
export function unsafeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\0")) return true;
  return name.split("/").some((seg, i, all) => seg === ".." || (seg === "" && i !== all.length - 1));
}
