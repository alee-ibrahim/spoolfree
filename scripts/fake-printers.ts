/**
 * Development IPP printer simulator: answers Get-Printer-Attributes on
 * 127.0.0.1:8631-8635 so the status dashboard and "Test" button can be
 * exercised without hardware. It also takes test prints: Print-Job (the document is kept in memory, never printed)
 * and Get-Job-Attributes (a job is "processing" for a moment, then "completed").
 * The MFPs also answer eSCL (driverless scanning) under /eSCL on the same port: capabilities, status and scan jobs,
 * which return a generated PNG test pattern.
 * Run: pnpm tsx scripts/fake-printers.ts
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import zlib from "node:zlib";
import { decodeRequest, encodeMessage, Operation, Tag, type IppRequestAttribute } from "../src/lib/ipp/encoding";

/** A job the simulator received (tests read these). */
export interface SimJob {
  id: number;
  format: string;
  name: string;
  attributes: Record<string, unknown[]>;
  document: Buffer;
  at: number;
}

interface Sim {
  port: number;
  model: string;
  color: boolean;
  state: 3 | 4 | 5;
  reasons: string[];
  markers: [string, string, number][];
  pages: number;
  /** Default ["1.1", "2.0"]. */
  ippVersions?: string[];
  /** Default PWG raster, URF, PDF and JPEG. */
  formats?: string[];
  /** Received Print-Job documents. */
  jobs?: SimJob[];
  /** How long a job stays "processing" (ms, default 1500). */
  jobMs?: number;
  /** Jobs other clients have queued on the device (default 0); received jobs still processing are added to this. */
  queued?: number;
  /** eSCL scanner (MFPs only). adf: AdfState without "ScannerAdf", undefined = no feeder. */
  scanner?: { adf?: string };
  /** Scan jobs in progress (eSCL), by job id. */
  scanJobs?: Map<string, { settings: string; polls: number; done: boolean }>;
}

export const SIMS: Sim[] = [
  { port: 8631, model: "Brother MFC-L8900CDW", color: true, state: 3, reasons: ["none"], scanner: { adf: "Empty" }, markers: [["Black Toner", "#000000", 72], ["Cyan Toner", "#00FFFF", 64], ["Magenta Toner", "#FF00FF", 58], ["Yellow Toner", "#FFFF00", 81]], pages: 48213 },
  { port: 8632, model: "HP LaserJet Pro M404dn", color: false, state: 3, reasons: ["toner-low-warning"], markers: [["Black Cartridge", "#000000", 8]], pages: 120447 },
  { port: 8633, model: "Canon imageRUNNER ADVANCE DX C3826i", color: true, state: 5, reasons: ["media-jam-error"], queued: 2, scanner: { adf: "Loaded" }, markers: [["Black Toner", "#000000", 44], ["Cyan Toner", "#00FFFF", 39], ["Magenta Toner", "#FF00FF", 51], ["Yellow Toner", "#FFFF00", 47]], pages: 301992 },
  { port: 8634, model: "Epson WorkForce Pro WF-C5890", color: true, state: 4, reasons: ["none"], queued: 3, scanner: {}, markers: [["Black Ink", "#000000", 55], ["Cyan Ink", "#00FFFF", 12], ["Magenta Ink", "#FF00FF", 9], ["Yellow Ink", "#FFFF00", 66]], pages: 9120 },
  { port: 8635, model: "Kyocera ECOSYS P3145dn", color: false, state: 3, reasons: ["none"], markers: [["Black Toner", "#000000", 93]], pages: 23001 },
];

function attrs(s: Sim, uri: string): IppRequestAttribute[] {
  const kw = (name: string, values: string[]) => ({ tag: Tag.keyword, name, values });
  return [
    { tag: Tag.uri, name: "printer-uri-supported", values: [uri] },
    { tag: Tag.nameWithoutLanguage, name: "printer-name", values: [s.model.replace(/\s+/g, "_")] },
    { tag: Tag.textWithoutLanguage, name: "printer-make-and-model", values: [s.model] },
    { tag: Tag.uri, name: "printer-uuid", values: [`urn:uuid:00000000-0000-4000-8000-00000000${s.port}`] },
    { tag: Tag.enum, name: "printer-state", values: [s.state] },
    kw("printer-state-reasons", s.reasons),
    { tag: Tag.boolean, name: "printer-is-accepting-jobs", values: [true] },
    { tag: Tag.mimeMediaType, name: "document-format-supported", values: s.formats ?? ["application/octet-stream", "image/pwg-raster", "image/urf", "application/pdf", "image/jpeg"] },
    kw("ipp-versions-supported", s.ippVersions ?? ["1.1", "2.0"]),
    kw("pwg-raster-document-type-supported", ["black_1", "sgray_8", "srgb_8"]),
    kw("media-default", ["iso_a4_210x297mm"]),
    kw("print-color-mode-supported", s.color ? ["auto", "color", "monochrome"] : ["monochrome"]),
    kw("ipp-features-supported", ["ipp-everywhere", "airprint-1.8"]),
    kw("urf-supported", ["V1.4", "W8", "SRGB24", "RS300-600", "DM1"]),
    { tag: Tag.boolean, name: "color-supported", values: [s.color] },
    kw("sides-supported", ["one-sided", "two-sided-long-edge", "two-sided-short-edge"]),
    { tag: Tag.nameWithoutLanguage, name: "marker-names", values: s.markers.map((m) => m[0]) },
    { tag: Tag.nameWithoutLanguage, name: "marker-colors", values: s.markers.map((m) => m[1]) },
    kw("marker-types", s.markers.map(() => (s.model.includes("Epson") ? "ink-cartridge" : "toner"))),
    { tag: Tag.integer, name: "marker-levels", values: s.markers.map((m) => m[2]) },
    { tag: Tag.integer, name: "marker-low-levels", values: s.markers.map(() => 10) },
    { tag: Tag.integer, name: "marker-high-levels", values: s.markers.map(() => 100) },
    { tag: Tag.integer, name: "printer-impressions-completed", values: [s.pages] },
    { tag: Tag.integer, name: "queued-job-count", values: [queuedJobs(s)] },
  ];
}

/** queued-job-count: the preset queue plus received jobs that are still processing. */
function queuedJobs(s: Sim): number {
  return (s.queued ?? 0) + (s.jobs ?? []).filter((j) => Date.now() - j.at < (s.jobMs ?? 1500)).length;
}

function jobAttrs(s: Sim, j: SimJob): IppRequestAttribute[] {
  const done = Date.now() - j.at >= (s.jobMs ?? 1500);
  return [
    { tag: Tag.integer, name: "job-id", values: [j.id] },
    { tag: Tag.uri, name: "job-uri", values: [`ipp://127.0.0.1:${s.port}/ipp/print/${j.id}`] },
    { tag: Tag.enum, name: "job-state", values: [done ? 9 : 5] },
    { tag: Tag.keyword, name: "job-state-reasons", values: [done ? "job-completed-successfully" : "job-printing"] },
  ];
}

/** Splits a Print-Job request into its attributes and the document after end-of-attributes. */
function splitDocument(buf: Buffer): Buffer {
  // Walk the attribute groups to find the end-of-attributes tag (0x03).
  let pos = 8;
  while (pos < buf.length) {
    const tag = buf[pos];
    if (tag === Tag.endOfAttributes) return buf.subarray(pos + 1);
    if (tag < 0x10) {
      pos += 1;
      continue;
    }
    const nameLen = buf.readUInt16BE(pos + 1);
    const valueLen = buf.readUInt16BE(pos + 3 + nameLen);
    pos += 5 + nameLen + valueLen;
  }
  return Buffer.alloc(0);
}

const ESCL_NS = 'xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"';

function esclSourceCaps(s: Sim): string {
  const modes = ["BlackAndWhite1", "Grayscale8", ...(s.color ? ["RGB24"] : [])].map((m) => `<scan:ColorMode>${m}</scan:ColorMode>`).join("");
  const res = [100, 150, 200, 300]
    .map((d) => `<scan:DiscreteResolution><scan:XResolution>${d}</scan:XResolution><scan:YResolution>${d}</scan:YResolution></scan:DiscreteResolution>`)
    .join("");
  const formats = ["application/pdf", "image/png"];
  return [
    "<scan:MinWidth>16</scan:MinWidth><scan:MaxWidth>2550</scan:MaxWidth><scan:MinHeight>16</scan:MinHeight><scan:MaxHeight>3508</scan:MaxHeight>",
    `<scan:SettingProfiles><scan:SettingProfile><scan:ColorModes>${modes}</scan:ColorModes>`,
    `<scan:DocumentFormats>${formats.map((f) => `<pwg:DocumentFormat>${f}</pwg:DocumentFormat><scan:DocumentFormatExt>${f}</scan:DocumentFormatExt>`).join("")}</scan:DocumentFormats>`,
    `<scan:SupportedResolutions><scan:DiscreteResolutions>${res}</scan:DiscreteResolutions></scan:SupportedResolutions></scan:SettingProfile></scan:SettingProfiles>`,
  ].join("\n");
}

function esclCapabilities(s: Sim): string {
  const adf =
    s.scanner?.adf !== undefined
      ? `<scan:Adf><scan:AdfSimplexInputCaps>${esclSourceCaps(s)}</scan:AdfSimplexInputCaps><scan:FeederCapacity>50</scan:FeederCapacity></scan:Adf>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities ${ESCL_NS}><pwg:Version>2.63</pwg:Version><pwg:MakeAndModel>${s.model}</pwg:MakeAndModel>
<scan:Platen><scan:PlatenInputCaps>${esclSourceCaps(s)}</scan:PlatenInputCaps></scan:Platen>${adf}</scan:ScannerCapabilities>`;
}

function esclStatus(s: Sim): string {
  const busy = [...(s.scanJobs?.values() ?? [])].some((j) => !j.done);
  const adf = s.scanner?.adf !== undefined ? `<scan:AdfState>ScannerAdf${s.scanner.adf}</scan:AdfState>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus ${ESCL_NS}><pwg:Version>2.63</pwg:Version><pwg:State>${busy ? "Processing" : "Idle"}</pwg:State>${adf}</scan:ScannerStatus>`;
}

/** A greyscale or RGB PNG test pattern (border, colour/grey ramp, checkerboard, diagonal) of the scanned area. */
export function testPatternPng(width: number, height: number, rgb: boolean): Buffer {
  const ch = rgb ? 3 : 1;
  const stride = width * ch + 1;
  const rows = Buffer.alloc(stride * height, 0xff);
  const set = (x: number, y: number, c: [number, number, number]) => {
    const o = y * stride + 1 + x * ch;
    if (rgb) [rows[o], rows[o + 1], rows[o + 2]] = c;
    else rows[o] = Math.round((c[0] + c[1] + c[2]) / 3);
  };
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0; // PNG filter: none
    for (let x = 0; x < width; x++) {
      const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      const diagonal = Math.abs(x / width - y / height) < 0.004;
      const inRamp = y > height * 0.1 && y < height * 0.2;
      const inChecker = y > height * 0.3 && y < height * 0.5 && x > width * 0.1 && x < width * 0.9;
      if (border || diagonal) set(x, y, [0, 0, 0]);
      else if (inRamp) {
        const v = Math.round((x / width) * 255);
        set(x, y, [v, 128, 255 - v]);
      } else if (inChecker && (Math.floor(x / 24) + Math.floor(y / 24)) % 2) set(x, y, [0, 0, 0]);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = rgb ? 2 : 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function tagValue(xml: string, tag: string): string | null {
  return new RegExp(`<(?:\\w+:)?${tag}>([^<]*)<`).exec(xml)?.[1] ?? null;
}

/** eSCL under /eSCL: capabilities, status, POST ScanJobs (201 + Location), NextDocument (503 once, then the page, then 404). */
function handleEscl(s: Sim, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) {
  const path = (req.url ?? "").split("?")[0];
  const xml = (code: number, text: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "Content-Type": "text/xml", ...headers });
    res.end(text);
  };
  if (!s.scanner) return xml(404, "");
  s.scanJobs ??= new Map();
  if (req.method === "GET" && path === "/eSCL/ScannerCapabilities") return xml(200, esclCapabilities(s));
  if (req.method === "GET" && path === "/eSCL/ScannerStatus") return xml(200, esclStatus(s));
  if (req.method === "POST" && path === "/eSCL/ScanJobs") {
    if ([...s.scanJobs.values()].some((j) => !j.done)) return xml(503, "");
    const id = randomUUID();
    s.scanJobs.set(id, { settings: body.toString("utf8"), polls: 0, done: false });
    return xml(201, "", { Location: `/eSCL/ScanJobs/${id}` });
  }
  const m = /^\/eSCL\/ScanJobs\/([\w-]+)(\/NextDocument)?$/.exec(path);
  const job = m ? s.scanJobs.get(m[1]) : undefined;
  if (!m || !job) return xml(404, "");
  if (req.method === "DELETE" && !m[2]) {
    s.scanJobs.delete(m[1]);
    return xml(200, "");
  }
  if (req.method !== "GET" || !m[2]) return xml(405, "");
  if (job.done) return xml(404, "");
  if (tagValue(job.settings, "InputSource") === "Feeder" && s.scanner.adf !== "Loaded") {
    job.done = true;
    return xml(404, "");
  }
  // Warm-up: the first poll is "not ready yet", as on real scanners.
  if (job.polls++ === 0) return xml(503, "");
  job.done = true;
  const dpi = Number(tagValue(job.settings, "XResolution")) || 150;
  const w = Math.max(16, Math.round(((Number(tagValue(job.settings, "Width")) || 2480) * dpi) / 300));
  const h = Math.max(16, Math.round(((Number(tagValue(job.settings, "Height")) || 3508) * dpi) / 300));
  const rgb = /^RGB/.test(tagValue(job.settings, "ColorMode") ?? "");
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(testPatternPng(w, h, rgb));
}

export function startSim(s: Sim): http.Server {
  s.jobs ??= [];
  let nextJob = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        if ((req.url ?? "").startsWith("/eSCL")) return handleEscl(s, req, raw, res);
        // decodeRequest stops at end-of-attributes; a Print-Job document follows it.
        const r = decodeRequest(raw);
        const send = (code: number, groups: { tag: number; attributes: IppRequestAttribute[] }[]) => {
          res.writeHead(200, { "Content-Type": "application/ipp" });
          res.end(encodeMessage({ code, requestId: r.requestId, groups: [{ tag: Tag.operationAttributes, attributes: [{ tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] }, { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] }] }, ...groups] }));
        };
        const op = r.groups.find((g) => g.tag === Tag.operationAttributes)?.attributes ?? {};
        if (r.operation === Operation.printJob) {
          if (!(s.ippVersions ?? ["2.0"]).some((v) => v.startsWith("2."))) return send(0x0501, []);
          const format = String(op["document-format"]?.[0] ?? "application/octet-stream");
          if (!(s.formats ?? ["image/pwg-raster", "image/urf", "application/pdf"]).includes(format)) return send(0x040a, []);
          const job: SimJob = {
            id: nextJob++,
            format,
            name: String(op["job-name"]?.[0] ?? ""),
            attributes: (r.groups.find((g) => g.tag === Tag.jobAttributes)?.attributes ?? {}) as Record<string, unknown[]>,
            document: Buffer.from(splitDocument(raw)),
            at: Date.now(),
          };
          s.jobs!.push(job);
          return send(0x0000, [{ tag: Tag.jobAttributes, attributes: jobAttrs(s, job).slice(0, 4).map((a) => (a.name === "job-state" ? { ...a, values: [3] } : a)) }]);
        }
        if (r.operation === Operation.getJobAttributes) {
          const job = s.jobs!.find((j) => j.id === Number(op["job-id"]?.[0]));
          if (!job) return send(0x0406, []);
          return send(0x0000, [{ tag: Tag.jobAttributes, attributes: jobAttrs(s, job) }]);
        }
        const ok = r.operation === Operation.getPrinterAttributes;
        const body = encodeMessage({
          code: ok ? 0x0000 : 0x0501,
          requestId: r.requestId,
          groups: [
            {
              tag: Tag.operationAttributes,
              attributes: [
                { tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] },
                { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] },
              ],
            },
            ...(ok ? [{ tag: Tag.printerAttributes, attributes: attrs(s, `ipp://127.0.0.1:${s.port}/ipp/print`) }] : []),
          ],
        });
        res.writeHead(200, { "Content-Type": "application/ipp" });
        res.end(body);
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  server.listen(s.port, "127.0.0.1");
  return server;
}

if (process.argv[1]?.includes("fake-printers")) {
  for (const s of SIMS) {
    startSim(s);
    console.log(`fake IPP printer ${s.model} on ipp://127.0.0.1:${s.port}/ipp/print`);
  }
}
