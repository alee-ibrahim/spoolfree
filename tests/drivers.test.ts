import { describe, expect, it } from "vitest";
import { decideDriver, hardwareIdMatches, matchPackage, medianSecondsPerPage, mergeSpeedSamples, newStickyReason, parseDeviceId, vendorReason, type PackageForMatch, type PrinterForDecision } from "@/lib/drivers/auto";
import { decodeInf, parseInf } from "@/lib/drivers/inf";
import { DriverPackageError, driverNames, inspectDriverPackage } from "@/lib/drivers/package";
import { bufferSource, listEntries, readEntry, unsafeEntryName } from "@/lib/drivers/zip";
import { buildManifest, manifestNamesPackage } from "@/lib/manifest";
import { brotherInf, makeZip } from "./helpers/zip";

const DEVICE_ID = "MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:HL-3150CDN series;CLS:PRINTER;CID:Brother Laser Type1;";

describe("zip reader", () => {
  it("lists and reads stored and deflated entries", async () => {
    const zip = makeZip([
      { name: "a/b.txt", data: "hello" },
      { name: "c.bin", data: Buffer.from([1, 2, 3]), store: true },
    ]);
    const src = bufferSource(zip);
    const entries = await listEntries(src);
    expect(entries.map((e) => e.name)).toEqual(["a/b.txt", "c.bin"]);
    expect((await readEntry(src, entries[0])).toString()).toBe("hello");
    expect([...(await readEntry(src, entries[1]))]).toEqual([1, 2, 3]);
  });

  it("refuses non-zips and unsafe paths", async () => {
    await expect(listEntries(bufferSource(Buffer.from("not a zip at all, no really")))).rejects.toThrow(/not a zip/);
    for (const bad of ["../x.inf", "/abs.inf", "C:/x.inf", "a//b", "a/../b"]) expect(unsafeEntryName(bad)).toBe(true);
    for (const ok of ["x.inf", "amd64/x.dll", "dir/"]) expect(unsafeEntryName(ok)).toBe(false);
  });
});

describe("INF parser", () => {
  it("reads version, catalog, NTamd64 models and hardware IDs (UTF-16 and ANSI)", () => {
    for (const utf16 of [false, true]) {
      const inf = parseInf(decodeInf(brotherInf({ utf16 })));
      expect(inf.isPrinterClass).toBe(true);
      expect(inf.catalogFile).toBe("BROCH12A.CAT");
      expect(inf.driverVer).toBe("02/28/2014,1.15.0.0");
      expect(inf.provider).toBe("Brother");
      expect(inf.manufacturers).toEqual(["Brother"]);
      expect(inf.models).toEqual([
        { name: "Brother HL-3150CDN series", hardwareIds: ["USBPRINT\\BROTHERHL-3150CDN_SEED27", "BROTHERHL-3150CDN_SEED27"] },
        { name: "Brother HL-3170CDW series", hardwareIds: ["USBPRINT\\BROTHERHL-3170CDW_SE1234"] },
      ]);
    }
  });

  it("prefers CatalogFile.NTamd64", () => {
    const inf = parseInf("[Version]\nClass=Printer\nCatalogFile=x86.cat\nCatalogFile.NTamd64=\"x64.cat\"\n");
    expect(inf.catalogFile).toBe("x64.cat");
  });
});

describe("driver package inspection", () => {
  it("accepts a printer INF with its catalog", async () => {
    const zip = makeZip([
      { name: "BROCH12A.INF", data: brotherInf() },
      { name: "BROCH12A.cat", data: "signed catalog" },
      { name: "amd64/BRPRC12A.DL_", data: "x" },
      { name: "readme.inf", data: "[Version]\nClass=Image\n" },
    ]);
    const r = await inspectDriverPackage(bufferSource(zip));
    expect(r.manufacturer).toBe("Brother");
    expect(r.infs).toHaveLength(1);
    expect(r.infs[0]).toMatchObject({ path: "BROCH12A.INF", catalog: "BROCH12A.cat" });
    expect(driverNames(r.infs)).toEqual(["Brother HL-3150CDN series", "Brother HL-3170CDW series"]);
  });

  it("refuses unsigned, catalog-less, x86-only and unsafe packages", async () => {
    const cases: [Parameters<typeof makeZip>[0], RegExp][] = [
      [[{ name: "x.inf", data: brotherInf({ catalog: null }) }], /no CatalogFile/],
      [[{ name: "x.inf", data: brotherInf() }], /catalog BROCH12A.CAT is not in the zip/],
      [[{ name: "x.inf", data: brotherInf({ amd64: false }) }, { name: "BROCH12A.CAT", data: "c" }], /no NTamd64/],
      [[{ name: "../evil.inf", data: brotherInf() }], /unsafe path/],
      [[{ name: "readme.txt", data: "hi" }], /no printer-class/],
    ];
    for (const [files, err] of cases) {
      const p = inspectDriverPackage(bufferSource(makeZip(files)));
      await expect(p).rejects.toBeInstanceOf(DriverPackageError);
      await expect(inspectDriverPackage(bufferSource(makeZip(files)))).rejects.toThrow(err);
    }
  });
});

const exactPkg: PackageForMatch = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Brother HL-3150CDN",
  sha256: "a".repeat(64),
  size: 100,
  universal: false,
  universalDriver: null,
  manufacturer: "Brother",
  uploadedAt: "2026-11-08T00:00:00Z",
  infs: [
    {
      path: "BROCH12A.INF",
      catalog: "BROCH12A.CAT",
      driverVer: "02/28/2014,1.15.0.0",
      provider: "Brother",
      manufacturers: ["Brother"],
      models: [{ name: "Brother HL-3150CDN series", hardwareIds: ["USBPRINT\\BROTHERHL-3150CDN_SEED27", "BROTHERHL-3150CDN_SEED27"] }],
    },
  ],
};
const universalPkg: PackageForMatch = {
  ...exactPkg,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Brother Universal PCL",
  universal: true,
  universalDriver: "Brother Mono Universal Printer (PCL)",
  infs: [{ ...exactPkg.infs[0], path: "BRUPCB0A.INF", catalog: "BRUPCB0A.cat", models: [{ name: "Brother Mono Universal Printer (PCL)", hardwareIds: ["USBPRINT\\BROTHERHL-L6415DW_SEC081"] }] }],
};
const hpUpd: PackageForMatch = { ...universalPkg, id: "33333333-3333-4333-8333-333333333333", name: "HP UPD", manufacturer: "HP", universalDriver: "HP Universal Printing PCL 6", infs: [{ ...universalPkg.infs[0], models: [{ name: "HP Universal Printing PCL 6", hardwareIds: [] }] }] };

function printer(over: Partial<PrinterForDecision> = {}): PrinterForDecision {
  return {
    driverMode: "auto",
    driverPackageId: null,
    driverName: null,
    vendorProtocol: "raw9100",
    lprQueue: null,
    model: null,
    deviceId: null,
    autoVendorReason: null,
    speedSamples: [],
    lastTest: {
      ok: true,
      formats: ["application/octet-stream", "image/urf", "image/pwg-raster", "application/pdf"],
      driverlessFormats: ["image/pwg-raster", "image/urf", "application/pdf"],
      ippVersions: ["1.0", "1.1", "2.0"],
      color: true,
      compression: ["none", "deflate", "gzip"],
      maxRasterDpi: 600,
    },
    ...over,
  };
}

describe("1284 device IDs and package matching", () => {
  it("parses MFG and MDL", () => {
    expect(parseDeviceId(DEVICE_ID)).toEqual({ mfg: "Brother", mdl: "HL-3150CDN series" });
    expect(parseDeviceId(null)).toEqual({ mfg: null, mdl: null });
  });

  it("matches truncated hardware IDs with checksum, not other models", () => {
    expect(hardwareIdMatches("USBPRINT\\BROTHERHL-3150CDN_SEED27", "Brother", "HL-3150CDN series")).toBe(true);
    expect(hardwareIdMatches("WSDPRINT\\BrotherHL-3150CDN_seri8E9A", "Brother", "HL-3150CDN series")).toBe(true);
    expect(hardwareIdMatches("USBPRINT\\BROTHERHL-3150CDN_SEED27", "Brother", "HL-3150CDW series")).toBe(false);
    expect(hardwareIdMatches("USBPRINT\\BROTHERHL-3150CDN_SEED27", "Brother", null)).toBe(false);
  });

  it("prefers the exact model, then a universal driver whose INF lists the device", () => {
    const hl3150 = printer({ deviceId: DEVICE_ID });
    expect(matchPackage(hl3150, [universalPkg, exactPkg])).toMatchObject({ match: "exact", driverName: "Brother HL-3150CDN series" });
    const l6415 = printer({ deviceId: "MFG:Brother;MDL:HL-L6415DW series;", lastTest: { color: false } });
    expect(matchPackage(l6415, [universalPkg, exactPkg, hpUpd])).toMatchObject({ match: "universal", driverName: "Brother Mono Universal Printer (PCL)" });
    const listedByName: PackageForMatch = { ...hpUpd, infs: [{ ...hpUpd.infs[0], models: [...hpUpd.infs[0].models, { name: "HP LaserJet P2055dn", hardwareIds: [] }] }] };
    expect(matchPackage(printer({ lastTest: { model: "HP LaserJet P2055dn" } }), [universalPkg, listedByName])).toMatchObject({ match: "universal", driverName: "HP LaserJet P2055dn" });
  });

  it("never picks a universal driver by brand alone (HL-2250DN printed a PCL XL stream as text)", () => {
    const hl2250 = printer({ deviceId: "MFG:Brother;CMD:PJL,PCL,PCLXL;MDL:HL-2250DN series;", lastTest: { color: false } });
    expect(matchPackage(hl2250, [universalPkg, exactPkg, hpUpd])).toBeNull();
    expect(matchPackage(printer({ lastTest: { model: "HP LaserJet P2055dn" } }), [universalPkg, hpUpd])).toBeNull();
    expect(matchPackage(printer({ model: "Hewlett-Packard LaserJet 4250" }), [hpUpd])).toBeNull();
    expect(matchPackage(printer({ model: "Canon iR-ADV C5535" }), [universalPkg, exactPkg, hpUpd])).toBeNull();
    const d = decideDriver(printer({ deviceId: "MFG:Brother;MDL:HL-2250DN series;", lastTest: { ok: true, formats: ["application/octet-stream"], ippVersions: ["1.1"], color: false, model: "Brother HL-2250DN series" } }), [universalPkg, hpUpd]);
    expect(d).toMatchObject({ mode: "driverless", wantVendor: true, needed: "vendor driver needed: upload one for Brother HL-2250DN series" });
  });

  it("never gives a colour printer a monochrome universal driver", () => {
    const colourL6415: PackageForMatch = { ...universalPkg, infs: [{ ...universalPkg.infs[0], models: [{ name: "Brother Mono Universal Printer (PCL)", hardwareIds: ["USBPRINT\BROTHERHL-3170CDW_SER1234"] }] }] };
    const colourBrother = printer({ deviceId: "MFG:Brother;MDL:HL-3170CDW series;" });
    expect(matchPackage(colourBrother, [colourL6415])).toBeNull();
    const monoBrother = printer({ deviceId: "MFG:Brother;MDL:HL-L6415DW series;", lastTest: { color: false } });
    expect(matchPackage(monoBrother, [universalPkg])).toMatchObject({ match: "universal" });
  });

  it("matches by make and model when there is no device ID", () => {
    expect(matchPackage(printer({ model: "Brother HL-3150CDN" }), [exactPkg])).toMatchObject({ match: "exact" });
  });
});

describe("auto driver mode", () => {
  it("stays driverless for driverless-capable printers", () => {
    const d = decideDriver(printer(), [exactPkg]);
    expect(d).toMatchObject({ mode: "driverless", source: "auto", wantVendor: false });
    expect(d.reason).toMatch(/driverless-capable \(IPP 2.0, pwg-raster, urf, pdf\)/);
  });

  it("wants a vendor driver for IPP 1.x only, no driverless format, slow, or the raster-only hint", () => {
    expect(vendorReason(printer({ lastTest: { ok: true, formats: ["image/urf"], ippVersions: ["1.0", "1.1"] } }))).toBe("IPP 1.0/1.1 only");
    expect(vendorReason(printer({ lastTest: { ok: false, formats: ["application/vnd.hp-pcl"], ippVersions: ["2.0"] } }))).toMatch(/no driverless format/);
    const hint = { ok: true, formats: ["image/urf", "image/pwg-raster"], ippVersions: ["1.1", "2.0"], color: true, compression: ["none"], maxRasterDpi: 600 };
    expect(vendorReason(printer({ lastTest: hint }))).toMatch(/raster only, no compression/);
    expect(vendorReason(printer({ lastTest: { ...hint, color: false } }))).toBeNull();
    // A 300-dpi colour inkjet (Brother MFC-J3530DW) is not the slow-raster case.
    expect(vendorReason(printer({ lastTest: { ...hint, maxRasterDpi: 300 } }))).toBeNull();
    expect(vendorReason(printer({ lastTest: { ...hint, maxRasterDpi: null } }))).toBeNull();
    const at = "2026-11-08T00:00:00Z";
    const slow = [
      { jobId: 1, pages: 6, seconds: 300, at },
      { jobId: 2, pages: 2, seconds: 60, at },
      { jobId: 3, pages: 4, seconds: 100, at },
      { jobId: 4, pages: 1, seconds: 90, at },
    ];
    expect(medianSecondsPerPage(slow, { slowMinJobs: 3, slowMinPages: 2 })).toEqual({ median: 30, jobs: 3 });
    expect(vendorReason(printer({ speedSamples: slow }))).toBe("slow: median 30 s/page over 3 jobs");
    expect(vendorReason(printer({ speedSamples: slow.slice(0, 2) }))).toBeNull();
  });

  it("uses a matching package, or says which one is needed", () => {
    const hl = printer({ deviceId: DEVICE_ID, lastTest: { ok: true, formats: ["image/urf"], ippVersions: ["1.1"], model: "Brother HL-3150CDN series" } });
    expect(decideDriver(hl, [exactPkg])).toMatchObject({ mode: "vendor", source: "auto", match: "exact", driverName: "Brother HL-3150CDN series", protocol: "raw9100" });
    expect(decideDriver(hl, [])).toMatchObject({ mode: "driverless", wantVendor: true, needed: "vendor driver needed: upload one for Brother HL-3150CDN series" });
  });

  it("is sticky: a stored vendor decision is kept even when the device looks driverless now", () => {
    const p = printer({ autoVendorReason: "slow: median 50 s/page over 3 jobs", deviceId: DEVICE_ID });
    expect(decideDriver(p, [exactPkg])).toMatchObject({ mode: "vendor", reason: "slow: median 50 s/page over 3 jobs" });
    expect(newStickyReason(p)).toBeNull();
    expect(newStickyReason(printer({ lastTest: { ippVersions: ["1.1"] } }))).toBe("IPP 1.1 only");
    expect(newStickyReason(printer({ driverMode: "driverless", lastTest: { ippVersions: ["1.1"] } }))).toBeNull();
  });

  it("honours manual modes", () => {
    expect(decideDriver(printer({ driverMode: "driverless", lastTest: { ippVersions: ["1.1"] } }), [exactPkg])).toMatchObject({ mode: "driverless", source: "manual" });
    const v = decideDriver(printer({ driverMode: "vendor", driverPackageId: exactPkg.id, driverName: "Brother HL-3150CDN series", vendorProtocol: "lpr", lprQueue: "BINARY_P1" }), [exactPkg]);
    expect(v).toMatchObject({ mode: "vendor", source: "manual", protocol: "lpr", lprQueue: "BINARY_P1" });
    expect(decideDriver(printer({ driverMode: "vendor", driverPackageId: exactPkg.id, driverName: "Nope" }), [exactPkg])).toMatchObject({ mode: "driverless", needed: "choose a driver package" });
  });

  it("merges Get-Jobs records into speed samples", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    const jobs = [
      { "job-id": [7], "job-state": [9], "time-at-processing": [1000], "time-at-completed": [1300], "job-impressions-completed": [6] },
      { "job-id": [8], "job-state": [8], "time-at-processing": [1000], "time-at-completed": [1300], "job-impressions-completed": [6] },
      { "job-id": [9], "job-state": [9], "time-at-processing": [0], "time-at-completed": [10], "job-impressions-completed": [1] },
    ];
    const s = mergeSpeedSamples([], jobs, now);
    expect(s).toEqual([{ jobId: 7, pages: 6, seconds: 300, at: now.toISOString() }]);
    expect(mergeSpeedSamples(s, jobs, now)).toHaveLength(1);
  });
});

describe("manifest", () => {
  it("carries the vendor driver of vendor printers only", () => {
    const base = { id: "p1", name: "Bureau", host: "192.0.2.12", port: 631, ippPath: "/ipp/print", useTls: false, model: null, location: null, revision: 1 };
    const vendor = decideDriver(printer({ deviceId: DEVICE_ID, lastTest: { ippVersions: ["1.1"] } }), [exactPkg]);
    const m = buildManifest({
      resolution: { printers: [{ printerId: "p1", source: [] } as never, { printerId: "p2", source: [] } as never], defaultPrinterId: null } as never,
      printers: new Map([
        ["p1", { ...base, driver: vendor }],
        ["p2", { ...base, id: "p2", name: "Other", driver: decideDriver(printer(), [exactPkg]) }],
      ]),
      computer: { objectGuid: "g", dn: "CN=PC", name: "PC" },
      now: new Date("2026-11-08T00:00:00Z"),
      ttlHours: 1,
    });
    expect(m.printers[0].driverMode).toBe("vendor");
    expect(m.printers[0].driver).toEqual({
      mode: "vendor",
      packageId: exactPkg.id,
      packageName: "Brother HL-3150CDN",
      sha256: "a".repeat(64),
      size: 100,
      url: `/api/agent/drivers/${exactPkg.id}`,
      driverName: "Brother HL-3150CDN series",
      inf: "BROCH12A.INF",
      catalog: "BROCH12A.CAT",
      protocol: "raw9100",
      lprQueue: null,
    });
    expect(m.printers[1].driverMode).toBe("driverless");
    expect(m.printers[1].driver).toBeUndefined();
  });
});

describe("per-PC vendor fallback (0.8.1)", () => {
  const base = { id: "p1", name: "Bureau", host: "192.0.2.12", port: 631, ippPath: "/ipp/print", useTls: false, model: null, location: null, revision: 1 };
  const build = (driver: ReturnType<typeof decideDriver>) =>
    buildManifest({
      resolution: { printers: [{ printerId: "p1", source: [] } as never], defaultPrinterId: null } as never,
      printers: new Map([["p1", { ...base, driver }]]),
      computer: { objectGuid: "g", dn: "CN=PC", name: "PC" },
      now: new Date("2026-11-08T00:00:00Z"),
      ttlHours: 1,
    }).printers[0];

  it("a driverless auto printer carries the exact package as fallbackDriver; PCs still get driverless", () => {
    const d = decideDriver(printer({ deviceId: DEVICE_ID }), [universalPkg, exactPkg]);
    expect(d).toMatchObject({ mode: "driverless", source: "auto", wantVendor: false });
    expect(d.fallback).toMatchObject({ match: "exact", driverName: "Brother HL-3150CDN series" });
    const m = build(d);
    expect(m.driverMode).toBe("driverless");
    expect(m.driver).toBeUndefined();
    expect(m.fallbackDriver).toEqual({
      mode: "vendor",
      packageId: exactPkg.id,
      packageName: "Brother HL-3150CDN",
      sha256: "a".repeat(64),
      size: 100,
      url: `/api/agent/drivers/${exactPkg.id}`,
      driverName: "Brother HL-3150CDN series",
      inf: "BROCH12A.INF",
      catalog: "BROCH12A.CAT",
      protocol: "raw9100",
      lprQueue: null,
    });
  });

  it("uses a universal package only when its INF lists the device, never by brand alone", () => {
    const listed = decideDriver(printer({ deviceId: "MFG:Brother;MDL:HL-L6415DW series;", lastTest: { ...printer().lastTest, color: false } }), [universalPkg]);
    expect(listed.fallback).toMatchObject({ match: "universal", driverName: "Brother Mono Universal Printer (PCL)" });
    const unlisted = decideDriver(printer({ deviceId: "MFG:Brother;MDL:HL-2250DN series;" }), [universalPkg, hpUpd]);
    expect(unlisted.fallback).toBeNull();
    expect(build(unlisted).fallbackDriver).toBeUndefined();
  });

  it("has no fallback for vendor printers, manual driverless printers or without a matching package", () => {
    expect(decideDriver(printer({ deviceId: DEVICE_ID, lastTest: { ippVersions: ["1.1"] } }), [exactPkg]).fallback).toBeUndefined();
    const manual = decideDriver(printer({ driverMode: "driverless", deviceId: DEVICE_ID }), [exactPkg]);
    expect(manual.fallback).toBeUndefined();
    expect(build(manual).fallbackDriver).toBeUndefined();
    expect(decideDriver(printer({ deviceId: DEVICE_ID }), []).fallback).toBeNull();
  });
});

describe("agent driver download allow-list", () => {
  const pkg = (packageId: string) => ({ packageId }) as never;
  it("serves vendor drivers and per-PC vendor fallback drivers named in the manifest", () => {
    const printers = [{ driver: pkg("a") }, { fallbackDriver: pkg("b") }, {}];
    expect(manifestNamesPackage(printers, "a")).toBe(true);
    expect(manifestNamesPackage(printers, "b")).toBe(true);
  });
  it("refuses packages the manifest does not name", () => {
    expect(manifestNamesPackage([{ driver: pkg("a") }, { fallbackDriver: pkg("b") }], "c")).toBe(false);
    expect(manifestNamesPackage([], "a")).toBe(false);
  });
});
