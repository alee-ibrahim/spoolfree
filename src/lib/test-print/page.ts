import { asciiText, GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from "./font";

/**
 * The Spoolfree test page, generated on the server for "Direct to printer" test prints. One layout (in millimetres)
 * is rendered to whichever driverless format the printer takes: PWG raster (IPP Everywhere), Apple raster (URF) or PDF.
 * Mono, one page, no fonts or images to embed: every printer that does driverless printing can print it.
 */

export interface TestPageInfo {
  printerName: string;
  host: string;
  /** Resolved IP addresses of host (empty when host is an IP or DNS failed). */
  addresses: string[];
  model: string | null;
  driverMode: string;
  /** How the page reached the printer, e.g. "Direct from the Spoolfree server (IPP Print-Job)". */
  route: string;
  time: Date;
  timeZone: string;
  /** Document format and resolution, filled in by the renderer. */
  format?: string;
  id?: string;
}

export interface PageSize {
  /** PWG media name, e.g. iso_a4_210x297mm. */
  name: string;
  widthMm: number;
  heightMm: number;
}

export const A4: PageSize = { name: "iso_a4_210x297mm", widthMm: 210, heightMm: 297 };
export const LETTER: PageSize = { name: "na_letter_8.5x11in", widthMm: 215.9, heightMm: 279.4 };

/** Page size from a PWG media name (media-default); unknown, tiny or huge sizes give A4. */
export function pageSizeFor(media: string | null | undefined): PageSize {
  const m = /_([\d.]+)x([\d.]+)(mm|in)$/.exec(media ?? "");
  if (!m) return A4;
  const f = m[3] === "in" ? 25.4 : 1;
  const w = Number(m[1]) * f;
  const h = Number(m[2]) * f;
  if (!(w >= 140 && w <= 300 && h >= 200 && h <= 432)) return A4;
  return { name: media!, widthMm: Math.round(w * 10) / 10, heightMm: Math.round(h * 10) / 10 };
}

type El =
  | { kind: "text"; x: number; y: number; h: number; text: string }
  | { kind: "box"; x: number; y: number; w: number; h: number; line: number }
  | { kind: "fill"; x: number; y: number; w: number; h: number; gray: number };

/** Width of text in mm at cap height h with the bitmap font's proportions. */
export function textWidth(text: string, h: number): number {
  return (asciiText(text).length * GLYPH_ADVANCE - 1) * (h / GLYPH_HEIGHT);
}

function formatTime(d: Date, timeZone: string): string {
  try {
    const s = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(d);
    return `${s} (${timeZone})`;
  } catch {
    return d.toISOString();
  }
}

/** Fits a line into maxChars, cutting with "...". */
function fit(s: string, maxChars: number): string {
  const a = asciiText(s);
  return a.length <= maxChars ? a : `${a.slice(0, maxChars - 3)}...`;
}

/** The page layout in millimetres, origin top-left. */
export function layoutTestPage(info: TestPageInfo, size: PageSize): El[] {
  const W = size.widthMm;
  const H = size.heightMm;
  const els: El[] = [];
  // Alignment box 10 mm inside the edges, and corner ticks at 5 mm: the box should be complete and centred.
  els.push({ kind: "box", x: 10, y: 10, w: W - 20, h: H - 20, line: 0.5 });
  for (const [cx, cy] of [
    [5, 5],
    [W - 5, 5],
    [5, H - 5],
    [W - 5, H - 5],
  ]) {
    els.push({ kind: "fill", x: cx - 2, y: cy - 0.15, w: 4, h: 0.3, gray: 0 });
    els.push({ kind: "fill", x: cx - 0.15, y: cy - 2, w: 0.3, h: 4, gray: 0 });
  }

  els.push({ kind: "text", x: 20, y: 22, h: 9, text: "Spoolfree test page" });
  els.push({ kind: "fill", x: 20, y: 36, w: W - 40, h: 0.6, gray: 0 });

  const charsIn = (width: number, h: number) => Math.floor(width / ((h / GLYPH_HEIGHT) * GLYPH_ADVANCE));
  const ip = info.addresses.length ? info.addresses.join(", ") : info.host;
  const rows: [string, string][] = [
    ["Printer", info.printerName],
    ["Host", info.host],
    ["IP address", ip],
    ["Model", info.model ?? "unknown"],
    ["Driver mode", info.driverMode],
    ["Sent", info.route],
    ["Time", formatTime(info.time, info.timeZone)],
    ["Format", info.format ?? ""],
    ...(info.id ? ([["Reference", info.id]] as [string, string][]) : []),
  ];
  let y = 44;
  for (const [k, v] of rows) {
    els.push({ kind: "text", x: 20, y, h: 3.6, text: fit(`${k}:`, 12) });
    els.push({ kind: "text", x: 58, y, h: 3.6, text: fit(v, charsIn(W - 15 - 58, 3.6)) });
    y += 7.5;
  }

  // 100 mm ruler: 1 mm ticks, longer every 5 and 10 mm. Measure it to check the scale.
  y += 6;
  els.push({ kind: "text", x: 20, y, h: 3, text: "Ruler: 100 mm" });
  y += 7;
  for (let i = 0; i <= 100; i++) {
    const len = i % 10 === 0 ? 6 : i % 5 === 0 ? 4 : 2.5;
    els.push({ kind: "fill", x: 20 + i - 0.1, y, w: 0.2, h: len, gray: 0 });
    if (i % 10 === 0) els.push({ kind: "text", x: 20 + i - textWidth(String(i), 2.2) / 2, y: y + 7.5, h: 2.2, text: String(i) });
  }
  els.push({ kind: "fill", x: 20, y, w: 100, h: 0.2, gray: 0 });

  // Grey steps: 0-100 % black.
  y += 18;
  els.push({ kind: "text", x: 20, y, h: 3, text: "Grey steps (0 to 100 %)" });
  y += 6;
  [255, 191, 128, 64, 0].forEach((g, i) => {
    els.push({ kind: "fill", x: 20 + i * 20, y, w: 18, h: 12, gray: g });
    els.push({ kind: "box", x: 20 + i * 20, y, w: 18, h: 12, line: 0.2 });
  });

  y += 24;
  const notes = [
    "Check: the box 10 mm from the edges is complete, the text is",
    "sharp, the ruler measures 100 mm and the grey steps differ.",
    "Pages of random characters mean the printer did not understand",
    "the format: check the driver mode / vendor driver in Spoolfree.",
  ];
  for (const n of notes) {
    els.push({ kind: "text", x: 20, y, h: 2.8, text: fit(n, charsIn(W - 35, 2.8)) });
    y += 5;
  }
  els.push({ kind: "text", x: 20, y: H - 18, h: 2.8, text: "github.com/alee-ibrahim/spoolfree" });
  return els;
}

// --- Raster -----------------------------------------------------------------------------------------------------

/** An 8-bit grey canvas (255 = white). */
export class GrayCanvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height).fill(255);
  }
  fill(x0: number, y0: number, x1: number, y1: number, v: number) {
    const ax = Math.max(0, Math.round(x0));
    const bx = Math.min(this.width, Math.round(x1));
    const ay = Math.max(0, Math.round(y0));
    const by = Math.min(this.height, Math.round(y1));
    for (let y = ay; y < by; y++) this.data.fill(v, y * this.width + ax, y * this.width + bx);
  }
  row(y: number): Uint8Array {
    return this.data.subarray(y * this.width, (y + 1) * this.width);
  }
}

/** Draws the layout at dpi into a grey canvas of the page size. */
export function rasterize(els: El[], size: PageSize, dpi: number): GrayCanvas {
  const px = (mm: number) => (mm / 25.4) * dpi;
  const c = new GrayCanvas(Math.round(px(size.widthMm)), Math.round(px(size.heightMm)));
  const minLine = Math.max(1, Math.round(dpi / 300));
  for (const e of els) {
    if (e.kind === "fill") {
      const w = Math.max(minLine, px(e.w));
      const h = Math.max(minLine, px(e.h));
      c.fill(px(e.x), px(e.y), px(e.x) + w, px(e.y) + h, e.gray);
    } else if (e.kind === "box") {
      const t = Math.max(minLine, px(e.line));
      const [x, y, w, h] = [px(e.x), px(e.y), px(e.w), px(e.h)];
      c.fill(x, y, x + w, y + t, 0);
      c.fill(x, y + h - t, x + w, y + h, 0);
      c.fill(x, y, x + t, y + h, 0);
      c.fill(x + w - t, y, x + w, y + h, 0);
    } else {
      // Round down: the text never gets wider than the layout planned.
      const scale = Math.max(1, Math.floor(px(e.h) / GLYPH_HEIGHT));
      let x = Math.round(px(e.x));
      const y = Math.round(px(e.y));
      for (const ch of asciiText(e.text)) {
        const g = glyph(ch);
        for (let r = 0; r < g.length; r++)
          for (let col = 0; col < GLYPH_WIDTH; col++)
            if (g[r] & (1 << (GLYPH_WIDTH - 1 - col))) c.fill(x + col * scale, y + r * scale, x + (col + 1) * scale, y + (r + 1) * scale, 0);
        x += GLYPH_ADVANCE * scale;
      }
    }
  }
  return c;
}

/**
 * PWG/URF run-length encoding of one line (PWG 5102.4 / Apple raster): a byte n 0-127 repeats the next pixel n+1
 * times; a byte 257-n (n 2-128) is followed by n literal pixels. `unit` is the pixel size in bytes.
 */
export function packLine(line: Uint8Array, unit: number): Buffer {
  const out: number[] = [];
  const n = line.length / unit;
  const same = (a: number, b: number) => {
    for (let k = 0; k < unit; k++) if (line[a * unit + k] !== line[b * unit + k]) return false;
    return true;
  };
  const push = (i: number) => {
    for (let k = 0; k < unit; k++) out.push(line[i * unit + k]);
  };
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && same(i, i + run)) run++;
    if (run >= 2) {
      out.push(run - 1);
      push(i);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < n && lit < 128 && !(i + lit + 1 < n && same(i + lit, i + lit + 1))) lit++;
    if (lit === 1) out.push(0);
    else out.push(257 - lit);
    for (let k = 0; k < lit; k++) push(i + k);
    i += lit;
  }
  return Buffer.from(out);
}

export type RasterType = "sgray_8" | "srgb_8" | "black_1";

/** One canvas row in the output pixel format. */
function convertRow(row: Uint8Array, type: RasterType): Uint8Array {
  if (type === "sgray_8") return row;
  if (type === "srgb_8") {
    const out = new Uint8Array(row.length * 3);
    for (let i = 0; i < row.length; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = row[i];
    return out;
  }
  // black_1: 1 = black, 50 % threshold (the grey steps print as white or black).
  const out = new Uint8Array(Math.ceil(row.length / 8));
  for (let i = 0; i < row.length; i++) if (row[i] < 128) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

function encodeLines(c: GrayCanvas, type: RasterType, unit: number): Buffer {
  const parts: Buffer[] = [];
  let y = 0;
  while (y < c.height) {
    const line = convertRow(c.row(y), type);
    let rep = 1;
    while (y + rep < c.height && rep < 256 && Buffer.compare(c.row(y + rep), c.row(y)) === 0) rep++;
    parts.push(Buffer.from([rep - 1]), packLine(line, unit));
    y += rep;
  }
  return Buffer.concat(parts);
}

/** PWG raster (image/pwg-raster), one page. */
export function renderPwgRaster(info: TestPageInfo, size: PageSize, dpi: number, type: RasterType): Buffer {
  const c = rasterize(layoutTestPage({ ...info, format: `image/pwg-raster ${type} ${dpi} dpi` }, size), size, dpi);
  const h = Buffer.alloc(1796);
  const str = (off: number, s: string) => h.write(s, off, 63, "ascii");
  const u32 = (off: number, v: number) => h.writeUInt32BE(v >>> 0, off);
  str(0, "PwgRaster");
  u32(272, 0); // Duplex: one-sided
  u32(276, dpi);
  u32(280, dpi);
  u32(340, 1); // NumCopies
  u32(352, Math.round((size.widthMm / 25.4) * 72));
  u32(356, Math.round((size.heightMm / 25.4) * 72));
  u32(372, c.width);
  u32(376, c.height);
  const bits = type === "black_1" ? 1 : 8;
  const bpp = type === "srgb_8" ? 24 : bits;
  u32(384, bits);
  u32(388, bpp);
  u32(392, type === "black_1" ? Math.ceil(c.width / 8) : (c.width * bpp) / 8);
  u32(396, 0); // chunky
  u32(400, type === "srgb_8" ? 19 : type === "sgray_8" ? 18 : 3);
  u32(420, type === "srgb_8" ? 3 : 1); // NumColors
  u32(452, 1); // TotalPageCount
  u32(456, 1); // CrossFeedTransform
  u32(460, 1); // FeedTransform
  u32(480, 0xffffff); // AlternatePrimary
  str(1732, size.name);
  const unit = type === "srgb_8" ? 3 : 1;
  return Buffer.concat([Buffer.from("RaS2", "ascii"), h, encodeLines(c, type, unit)]);
}

/** Apple raster (image/urf), one page, W8 (sGray) or SRGB24. */
export function renderUrf(info: TestPageInfo, size: PageSize, dpi: number, color: "W8" | "SRGB24"): Buffer {
  const c = rasterize(layoutTestPage({ ...info, format: `image/urf ${color} ${dpi} dpi` }, size), size, dpi);
  const file = Buffer.alloc(12);
  file.write("UNIRAST\0", 0, "ascii");
  file.writeUInt32BE(1, 8);
  const page = Buffer.alloc(32);
  page[0] = color === "W8" ? 8 : 24;
  page[1] = color === "W8" ? 0 : 1; // 0 sGray, 1 sRGB
  page[2] = 1; // one-sided
  page[3] = 4; // normal quality
  page.writeUInt32BE(c.width, 12);
  page.writeUInt32BE(c.height, 16);
  page.writeUInt32BE(dpi, 20);
  const type: RasterType = color === "W8" ? "sgray_8" : "srgb_8";
  return Buffer.concat([file, page, encodeLines(c, type, color === "W8" ? 1 : 3)]);
}

// --- PDF ----------------------------------------------------------------------------------------------------------

function pdfString(s: string): string {
  return `(${asciiText(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;
}

/** A one-page PDF 1.4 with Helvetica (a standard font: nothing embedded). */
export function renderPdf(info: TestPageInfo, size: PageSize): Buffer {
  const pt = (mm: number) => Math.round((mm / 25.4) * 72 * 100) / 100;
  const W = pt(size.widthMm);
  const H = pt(size.heightMm);
  const ops: string[] = [];
  for (const e of layoutTestPage({ ...info, format: "application/pdf" }, size)) {
    if (e.kind === "fill") ops.push(`${(e.gray / 255).toFixed(3)} g ${pt(e.x)} ${H - pt(e.y + e.h)} ${pt(e.w)} ${pt(e.h)} re f`);
    else if (e.kind === "box") ops.push(`0 G ${pt(e.line)} w ${pt(e.x)} ${H - pt(e.y + e.h)} ${pt(e.w)} ${pt(e.h)} re S`);
    else {
      // Helvetica cap height is 0.718 em.
      const fs = Math.round((pt(e.h) / 0.718) * 100) / 100;
      ops.push(`0 g BT /F1 ${fs} Tf ${pt(e.x)} ${H - pt(e.y + e.h)} Td ${pdfString(e.text)} Tj ET`);
    }
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
