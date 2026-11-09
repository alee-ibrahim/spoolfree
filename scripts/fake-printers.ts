/**
 * Development IPP printer simulator: answers Get-Printer-Attributes on
 * 127.0.0.1:8631-8635 so the status dashboard and "Test" button can be
 * exercised without hardware. It also takes test prints: Print-Job (the document is kept in memory, never printed)
 * and Get-Job-Attributes (a job is "processing" for a moment, then "completed").
 * Run: pnpm tsx scripts/fake-printers.ts
 */
import http from "node:http";
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
}

export const SIMS: Sim[] = [
  { port: 8631, model: "Brother MFC-L8900CDW", color: true, state: 3, reasons: ["none"], markers: [["Black Toner", "#000000", 72], ["Cyan Toner", "#00FFFF", 64], ["Magenta Toner", "#FF00FF", 58], ["Yellow Toner", "#FFFF00", 81]], pages: 48213 },
  { port: 8632, model: "HP LaserJet Pro M404dn", color: false, state: 3, reasons: ["toner-low-warning"], markers: [["Black Cartridge", "#000000", 8]], pages: 120447 },
  { port: 8633, model: "Canon imageRUNNER ADVANCE DX C3826i", color: true, state: 5, reasons: ["media-jam-error"], markers: [["Black Toner", "#000000", 44], ["Cyan Toner", "#00FFFF", 39], ["Magenta Toner", "#FF00FF", 51], ["Yellow Toner", "#FFFF00", 47]], pages: 301992 },
  { port: 8634, model: "Epson WorkForce Pro WF-C5890", color: true, state: 4, reasons: ["none"], markers: [["Black Ink", "#000000", 55], ["Cyan Ink", "#00FFFF", 12], ["Magenta Ink", "#FF00FF", 9], ["Yellow Ink", "#FFFF00", 66]], pages: 9120 },
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
  ];
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

export function startSim(s: Sim): http.Server {
  s.jobs ??= [];
  let nextJob = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
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
