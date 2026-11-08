import { crc32, deflateRawSync } from "node:zlib";

/** Minimal ZIP writer for tests (deflate or store, no ZIP64). */
export function makeZip(files: { name: string; data: Buffer | string; store?: boolean; encrypted?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = f.store ? data : deflateRawSync(data);
    const method = f.store ? 0 : 8;
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const flags = 0x800 | (f.encrypted ? 1 : 0);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A Brother-style printer INF (UTF-16LE with BOM when utf16 is set). */
export function brotherInf(opts: { catalog?: string | null; utf16?: boolean; amd64?: boolean } = {}): Buffer {
  const cat = opts.catalog === undefined ? "BROCH12A.CAT" : opts.catalog;
  const text = [
    "; Brother printer driver",
    "[Version]",
    'Signature="$Windows NT$"',
    "Class=Printer",
    "ClassGUID={4D36E979-E325-11CE-BFC1-08002BE10318}",
    "Provider=%Brother%",
    ...(cat ? [`CatalogFile=${cat}`] : []),
    "DriverVer=02/28/2014,1.15.0.0",
    "",
    "[Manufacturer]",
    `%Brother%=Brother${opts.amd64 === false ? "" : ",NTamd64"}`,
    "",
    "[Brother.NTamd64]",
    '"Brother HL-3150CDN series" = BRHL3150, USBPRINT\\BROTHERHL-3150CDN_SEED27, BROTHERHL-3150CDN_SEED27 ; comment',
    "%HL3170% = BRHL3170, \\",
    "   USBPRINT\\BROTHERHL-3170CDW_SE1234",
    "",
    "[Brother]",
    '"Brother X86 Only" = X86',
    "",
    "[Strings]",
    'Brother="Brother"',
    'HL3170="Brother HL-3170CDW series"',
  ].join("\r\n");
  if (opts.utf16) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  return Buffer.from(text, "latin1");
}
