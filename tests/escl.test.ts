import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCapabilities, readScannerStatus, runScanJob, ScanError, type HttpResult, type ScanDeps } from "@/lib/escl/client";
import {
  chooseScan,
  esclBase,
  esclCandidates,
  parseCapabilities,
  parseScannerStatus,
  pickScanDpi,
  scanSettingsXml,
  sniffImageType,
  type ScanChoice,
  type ScannerInfo,
} from "@/lib/escl/escl";
import { pollScanner } from "@/lib/escl/service";
import { SIMS, startSim } from "../scripts/fake-printers";

const NS = 'xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"';

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities ${NS}>
  <pwg:Version>2.63</pwg:Version>
  <pwg:MakeAndModel>HP Color LaserJet MFP M480f &amp; friends</pwg:MakeAndModel>
  <scan:Platen>
    <scan:PlatenInputCaps>
      <scan:MaxWidth>2550</scan:MaxWidth>
      <scan:MaxHeight>3300</scan:MaxHeight>
      <scan:SettingProfiles><scan:SettingProfile>
        <scan:ColorModes><scan:ColorMode>BlackAndWhite1</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode><scan:ColorMode>RGB24</scan:ColorMode></scan:ColorModes>
        <scan:DocumentFormats><pwg:DocumentFormat>application/pdf</pwg:DocumentFormat><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat></scan:DocumentFormats>
        <scan:SupportedResolutions><scan:DiscreteResolutions>
          <scan:DiscreteResolution><scan:XResolution>75</scan:XResolution><scan:YResolution>75</scan:YResolution></scan:DiscreteResolution>
          <scan:DiscreteResolution><scan:XResolution>200</scan:XResolution><scan:YResolution>200</scan:YResolution></scan:DiscreteResolution>
          <scan:DiscreteResolution><scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution></scan:DiscreteResolution>
        </scan:DiscreteResolutions></scan:SupportedResolutions>
      </scan:SettingProfile></scan:SettingProfiles>
    </scan:PlatenInputCaps>
  </scan:Platen>
  <scan:Adf>
    <scan:AdfSimplexInputCaps>
      <scan:MaxWidth>2550</scan:MaxWidth>
      <scan:SettingProfiles><scan:SettingProfile>
        <scan:ColorModes><scan:ColorMode>RGB24</scan:ColorMode></scan:ColorModes>
        <scan:DocumentFormats><scan:DocumentFormatExt>application/pdf</scan:DocumentFormatExt></scan:DocumentFormats>
        <scan:SupportedResolutions><scan:ResolutionRange><scan:XResolutionRange><scan:Min>100</scan:Min><scan:Max>600</scan:Max></scan:XResolutionRange></scan:ResolutionRange></scan:SupportedResolutions>
      </scan:SettingProfile></scan:SettingProfiles>
    </scan:AdfSimplexInputCaps>
  </scan:Adf>
</scan:ScannerCapabilities>`;

describe("eSCL documents", () => {
  it("parses ScannerStatus with any namespace prefix", () => {
    expect(parseScannerStatus(`<scan:ScannerStatus ${NS}><pwg:Version>2.6</pwg:Version><pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfEmpty</scan:AdfState></scan:ScannerStatus>`)).toEqual({
      state: "idle",
      adfState: "Empty",
    });
    expect(parseScannerStatus(`<ScannerStatus><State>Down</State></ScannerStatus>`)).toEqual({ state: "down", adfState: null });
    expect(parseScannerStatus(`<ScannerStatus><State>Warming</State></ScannerStatus>`).state).toBe("unknown");
    expect(() => parseScannerStatus("<html>login</html>")).toThrow();
  });

  it("parses capabilities of the glass and the feeder", () => {
    const c = parseCapabilities(CAPS);
    expect(c.version).toBe("2.63");
    expect(c.makeAndModel).toBe("HP Color LaserJet MFP M480f & friends");
    expect(c.platen).toEqual({
      colorModes: ["BlackAndWhite1", "Grayscale8", "RGB24"],
      resolutions: [75, 200, 300],
      formats: ["application/pdf", "image/jpeg"],
      maxWidth: 2550,
      maxHeight: 3300,
    });
    expect(c.feeder?.colorModes).toEqual(["RGB24"]);
    expect(c.feeder?.resolutions).toEqual([100, 150, 300, 600]);
    expect(c.feeder?.formats).toEqual(["application/pdf"]);
    expect(c.feeder?.maxHeight).toBe(0);
    expect(parseCapabilities(`<ScannerCapabilities><Version>2.0</Version></ScannerCapabilities>`)).toMatchObject({ platen: null, feeder: null });
  });

  it("picks greyscale, about 150 dpi and the friendliest format", () => {
    const info = parseCapabilities(CAPS);
    expect(chooseScan(info, "platen", "gray")).toEqual({ source: "platen", colorMode: "Grayscale8", dpi: 200, format: "image/jpeg", width: 2480, height: 3300 });
    expect(chooseScan(info, "platen", "color")).toMatchObject({ colorMode: "RGB24" });
    expect(chooseScan(info, "feeder", "color")).toMatchObject({ source: "feeder", dpi: 150, format: "application/pdf", height: 3508 });
    expect(chooseScan(info, "feeder", "gray")).toMatch(/no greyscale/);
    expect(chooseScan({ platen: null, feeder: null }, "platen", "gray")).toMatch(/no glass/);
    expect(chooseScan({ platen: { colorModes: ["Grayscale8"], resolutions: [], formats: ["image/tiff"], maxWidth: 0, maxHeight: 0 }, feeder: null }, "platen", "gray")).toMatch(/offers none/);
    expect(pickScanDpi([75, 150, 300])).toBe(150);
    expect(pickScanDpi([75, 100])).toBe(100);
    expect(pickScanDpi([600, 1200])).toBe(600);
    expect(pickScanDpi([])).toBe(150);
  });

  it("writes ScanSettings with escaped values", () => {
    const xml = scanSettingsXml({ source: "feeder", colorMode: "RGB24", dpi: 150, format: "image/jpeg", width: 2480, height: 3508 }, "2.63");
    expect(xml).toContain("<pwg:InputSource>Feeder</pwg:InputSource>");
    expect(xml).toContain("<scan:XResolution>150</scan:XResolution>");
    expect(xml).toContain("<pwg:Version>2.63</pwg:Version>");
    expect(scanSettingsXml({ source: "platen", colorMode: "<x>", dpi: 150, format: "image/jpeg", width: 1, height: 1 }, "2.0'><evil")).toContain("<scan:ColorMode>&lt;x&gt;</scan:ColorMode>");
    expect(scanSettingsXml({ source: "platen", colorMode: "Grayscale8", dpi: 150, format: "image/jpeg", width: 1, height: 1 }, "2.0'><evil")).toContain("<pwg:Version>2.0</pwg:Version>");
  });

  it("lists the usual eSCL endpoints and builds base URLs", () => {
    expect(esclCandidates({ port: 631 }).map((e) => `${e.scheme}:${e.port}`)).toEqual(["https:443", "http:80", "http:8080", "http:631"]);
    expect(esclCandidates({ port: 443, useTls: true }).map((e) => `${e.scheme}:${e.port}`)).toEqual(["https:443", "http:80", "http:8080"]);
    expect(esclBase("2001:db8::5", { scheme: "https", port: 443, path: "/eSCL" })).toBe("https://[2001:db8::5]:443/eSCL");
  });

  it("recognises image data by its signature", () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffImageType(Buffer.from("<html>"))).toBeNull();
  });
});

describe("scan jobs", () => {
  const scanner: ScannerInfo = { scheme: "http", port: 80, path: "/eSCL", version: "2.6", makeAndModel: null, platen: null, feeder: null };
  const choice: ScanChoice = { source: "platen", colorMode: "Grayscale8", dpi: 150, format: "image/jpeg", width: 2480, height: 3508 };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const opts = { requestTimeoutMs: 1000, totalTimeoutMs: 10_000, maxBytes: 1e6 };

  function fakeDeps(answers: ((url: string, method: string) => Partial<HttpResult>)[]) {
    const calls: string[] = [];
    let t = 0;
    const deps: ScanDeps = {
      request: async (url, o) => {
        calls.push(`${o.method ?? "GET"} ${url}`);
        const next = answers.shift();
        if (!next) throw new Error(`unexpected request ${url}`);
        return { status: 200, headers: {}, body: Buffer.alloc(0), ...next(url, o.method ?? "GET") };
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
    return { deps, calls };
  }

  it("posts the job, waits out 503 and deletes the job afterwards", async () => {
    const { deps, calls } = fakeDeps([
      () => ({ status: 201, headers: { location: "/eSCL/ScanJobs/42" } }),
      () => ({ status: 503 }),
      () => ({ status: 200, body: jpeg }),
      () => ({ status: 200 }),
    ]);
    const r = await runScanJob("192.0.2.9", scanner, choice, opts, deps);
    expect(r).toEqual({ format: "image/jpeg", data: jpeg });
    expect(calls).toEqual([
      "POST http://192.0.2.9:80/eSCL/ScanJobs",
      "GET http://192.0.2.9/eSCL/ScanJobs/42/NextDocument",
      "GET http://192.0.2.9/eSCL/ScanJobs/42/NextDocument",
      "DELETE http://192.0.2.9/eSCL/ScanJobs/42",
    ]);
  });

  it("never follows a job address on another host", async () => {
    const { deps, calls } = fakeDeps([() => ({ status: 201, headers: { location: "http://10.0.0.1/eSCL/ScanJobs/1" } })]);
    await expect(runScanJob("192.0.2.9", scanner, choice, opts, deps)).rejects.toThrow(/another host/);
    expect(calls).toHaveLength(1);
  });

  it("reports a busy scanner, an empty feeder and data that is not an image", async () => {
    await expect(runScanJob("h", scanner, choice, opts, fakeDeps([() => ({ status: 503 })]).deps)).rejects.toThrow(/busy/);
    const feeder = { ...choice, source: "feeder" as const };
    await expect(
      runScanJob("h", scanner, feeder, opts, fakeDeps([() => ({ status: 201, headers: { location: "/eSCL/ScanJobs/1" } }), () => ({ status: 404 }), () => ({})]).deps),
    ).rejects.toThrow(/no page in the document feeder/);
    await expect(
      runScanJob("h", scanner, choice, opts, fakeDeps([() => ({ status: 201, headers: { location: "/eSCL/ScanJobs/1" } }), () => ({ status: 200, body: Buffer.from("<html>") }), () => ({})]).deps),
    ).rejects.toBeInstanceOf(ScanError);
  });

  it("gives up after the total timeout", async () => {
    const answers = [() => ({ status: 201, headers: { location: "/eSCL/ScanJobs/1" } }), ...Array.from({ length: 20 }, () => () => ({ status: 503 }))];
    await expect(runScanJob("h", scanner, choice, { ...opts, totalTimeoutMs: 5000 }, fakeDeps(answers).deps)).rejects.toThrow(/within 5 s/);
  });

  it("reads no status for a printer without a scanner, and keeps a read error", async () => {
    expect(await pollScanner({ host: "h", scanner: null })).toEqual({ scannerState: null, scannerAdfState: null, scannerError: null });
    expect(await pollScanner({ host: "h", scanner }, async () => ({ state: "stopped", adfState: "Jam" }))).toEqual({ scannerState: "stopped", scannerAdfState: "Jam", scannerError: null });
    expect(await pollScanner({ host: "h", scanner }, async () => Promise.reject(new Error("timeout after 5000 ms")))).toMatchObject({ scannerState: null, scannerError: "timeout after 5000 ms" });
  });
});

describe("eSCL against the simulator", () => {
  const mfp: (typeof SIMS)[number] = { ...SIMS[0], port: 0, scanJobs: undefined };
  const printerOnly = { ...SIMS[1], port: 0 };
  const servers: ReturnType<typeof startSim>[] = [];
  let mfpPort = 0;
  let printerPort = 0;
  beforeAll(async () => {
    for (const s of [mfp, printerOnly]) {
      const server = startSim(s);
      servers.push(server);
      await new Promise((r) => server.once("listening", r));
    }
    mfpPort = (servers[0].address() as AddressInfo).port;
    printerPort = (servers[1].address() as AddressInfo).port;
    mfp.port = mfpPort;
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it("finds the MFP's scanner, reads its status and scans a page", async () => {
    const info = await readCapabilities("127.0.0.1", { scheme: "http", port: mfpPort, path: "/eSCL" }, 2000);
    expect(info).toMatchObject({ makeAndModel: "Brother MFC-L8900CDW", version: "2.63" });
    expect(info!.platen?.formats).toContain("image/png");
    expect(info!.feeder).not.toBeNull();
    expect(await readScannerStatus("127.0.0.1", info!, 2000)).toEqual({ state: "idle", adfState: "Empty" });

    const choice = chooseScan(info!, "platen", "gray");
    if (typeof choice === "string") throw new Error(choice);
    expect(choice).toMatchObject({ dpi: 150, format: "image/png", width: 2480, height: 3508 });
    const r = await runScanJob("127.0.0.1", info!, choice, { requestTimeoutMs: 2000, totalTimeoutMs: 20_000, maxBytes: 25e6 }, { request: (await import("@/lib/escl/client")).esclRequest, sleep: async () => undefined, now: Date.now });
    expect(r.format).toBe("image/png");
    expect(r.data.readUInt32BE(16)).toBe(1240); // PNG width: A4 at 150 dpi
    expect(r.data.readUInt32BE(20)).toBe(1754);
    expect(mfp.scanJobs?.size).toBe(0); // job deleted afterwards

    // The feeder is empty: the scanner ends the job without a page.
    const feeder = chooseScan(info!, "feeder", "gray");
    if (typeof feeder === "string") throw new Error(feeder);
    await expect(runScanJob("127.0.0.1", info!, feeder, { requestTimeoutMs: 2000, totalTimeoutMs: 20_000, maxBytes: 25e6 })).rejects.toThrow(/no page in the document feeder/);
  });

  it("finds no scanner on a printer without one", async () => {
    expect(await readCapabilities("127.0.0.1", { scheme: "http", port: printerPort, path: "/eSCL" }, 2000)).toBeNull();
  });
});
