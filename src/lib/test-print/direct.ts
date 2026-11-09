import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import type { Printer, TestPrint } from "../db/schema";
import { getJobAttributes, getPrinterAttributes, IppStatusError, printJob } from "../ipp/client";
import { Tag, type IppRequestAttribute, type IppValue } from "../ipp/encoding";
import { printerUri } from "../ipp/interpret";
import { A4, assertRasterSize, choosePageSize, MAX_RENDER_DPI, rasterPixels, MAX_RASTER_PIXELS, renderPdf, renderPwgRaster, renderUrf, type PageSize, type RasterType, type TestPageInfo } from "./page";
import { reserveTestPrint, TestPrintError, transitionTestPrint } from "./service";

/**
 * "Direct to printer (from server)": the server renders the test page and sends it with IPP Print-Job, in a format the
 * printer lists, then follows the job with Get-Job-Attributes. Needs a driverless printer (IPP 2.x and PWG raster, URF or
 * PDF); IPP 1.x-only printers are tested "from a PC" instead.
 */

export const FORMAT_ATTRIBUTES = [
  "document-format-supported",
  "pwg-raster-document-resolution-supported",
  "pwg-raster-document-type-supported",
  "urf-supported",
  "media-default",
  "media-supported",
  "sides-supported",
  "print-color-mode-supported",
  "ipp-versions-supported",
  "printer-is-accepting-jobs",
  "printer-make-and-model",
];

export const JOB_ATTRIBUTES = ["job-id", "job-uri", "job-state", "job-state-reasons", "job-state-message", "job-impressions-completed"];

export interface DirectCapability {
  enabled: boolean;
  /** Why the mode is off (shown in the UI). */
  reason: string | null;
}

/** Whether "Direct to printer" is possible, from the printer's last Test. */
export function directCapability(p: Pick<Printer, "lastTest" | "lastTestAt">): DirectCapability {
  const t = p.lastTest;
  if (!t || !p.lastTestAt) return { enabled: false, reason: "Run Test (IPP) first, so Spoolfree knows which formats the printer takes." };
  if (t.error) return { enabled: false, reason: `The last Test failed (${t.error}). Run Test (IPP) again when the printer is reachable.` };
  if (!(t.ippVersions ?? []).some((v) => v.startsWith("2.")))
    return { enabled: false, reason: "The printer speaks IPP 1.x only, so it cannot take a driverless job from the server. Test it from a PC (its vendor driver) instead." };
  if (!(t.driverlessFormats ?? []).length)
    return { enabled: false, reason: "The printer is not driverless: it lists no PWG raster, URF or PDF. Test it from a PC (its vendor driver) instead." };
  return { enabled: true, reason: null };
}

export type DocumentChoice =
  | { format: "image/pwg-raster"; type: RasterType; dpi: number }
  | { format: "image/urf"; color: "W8" | "SRGB24"; dpi: number }
  | { format: "application/pdf" };

function strings(v: IppValue[] | undefined): string[] {
  return (v ?? []).filter((x): x is string => typeof x === "string").map((s) => s.toLowerCase());
}

/**
 * Pick 300 dpi when offered, else the lowest from 300 up to MAX_RENDER_DPI (600), else the highest offered below 300
 * (at least 72), else 300 when the printer lists nothing. Null when it lists only resolutions above 600 dpi: the server
 * never renders above that (M1), so the caller falls back to another format.
 */
export function pickDpi(offered: number[]): number | null {
  const valid = offered.filter((d) => Number.isFinite(d) && d > 0);
  if (!valid.length) return 300;
  const ok = [...new Set(valid.filter((d) => d >= 72 && d <= MAX_RENDER_DPI))].sort((a, b) => a - b);
  if (!ok.length) return null;
  if (ok.includes(300)) return 300;
  return ok.find((d) => d > 300) ?? ok.at(-1)!;
}

function pwgDpis(v: IppValue[] | undefined): number[] {
  const out: number[] = [];
  for (const r of v ?? []) {
    if (r && typeof r === "object" && "x" in r && typeof r.x === "number") out.push(r.units === 4 ? Math.round(r.x * 2.54) : r.x);
  }
  return out;
}

/**
 * The document format for a printer, in the order that is safest across Brother, HP and Toshiba: PWG raster (the IPP
 * Everywhere format) in grey, URF in grey, then PDF. Null when none is listed.
 */
export function chooseDocument(attrs: Record<string, IppValue[]>): DocumentChoice | null {
  const formats = strings(attrs["document-format-supported"]);
  if (formats.includes("image/pwg-raster")) {
    const types = strings(attrs["pwg-raster-document-type-supported"]);
    const type: RasterType | null = !types.length || types.includes("sgray_8") ? "sgray_8" : types.includes("black_1") ? "black_1" : types.includes("srgb_8") ? "srgb_8" : null;
    const dpi = pickDpi(pwgDpis(attrs["pwg-raster-document-resolution-supported"]));
    if (type && dpi !== null) return { format: "image/pwg-raster", type, dpi };
  }
  if (formats.includes("image/urf")) {
    const urf = strings(attrs["urf-supported"]).map((s) => s.toUpperCase());
    const color = urf.includes("W8") || !urf.some((s) => s === "SRGB24") ? "W8" : "SRGB24";
    const rs = urf.find((s) => s.startsWith("RS"));
    const dpis = rs ? rs.slice(2).split("-").map(Number).filter(Number.isFinite) : [];
    const dpi = pickDpi(dpis);
    if (dpi !== null) return { format: "image/urf", color, dpi };
  }
  if (formats.includes("application/pdf")) return { format: "application/pdf" };
  return null;
}

/** Job template attributes, only those the printer lists: one-sided and monochrome. */
export function jobAttributesFor(attrs: Record<string, IppValue[]>): IppRequestAttribute[] {
  const out: IppRequestAttribute[] = [];
  if (strings(attrs["sides-supported"]).includes("one-sided")) out.push({ tag: Tag.keyword, name: "sides", values: ["one-sided"] });
  const modes = strings(attrs["print-color-mode-supported"]);
  if (modes.includes("monochrome")) out.push({ tag: Tag.keyword, name: "print-color-mode", values: ["monochrome"] });
  return out;
}

/**
 * The page size to render: A4 or Letter when the printer takes them (choosePageSize); a raster page that would still
 * exceed the pixel cap is rendered on A4 instead, and throws when even that does not fit (never allocates it).
 */
export function pageSizeForChoice(choice: DocumentChoice, attrs: Record<string, IppValue[]>): PageSize {
  const def = (attrs["media-default"]?.[0] as string | undefined) ?? null;
  const supported = (attrs["media-supported"] ?? []).filter((x): x is string => typeof x === "string");
  const size = choosePageSize(def, supported);
  if (choice.format === "application/pdf") return size;
  if (rasterPixels(size, choice.dpi) <= MAX_RASTER_PIXELS) return size;
  assertRasterSize(A4, choice.dpi);
  return A4;
}

export function renderDocument(choice: DocumentChoice, info: TestPageInfo, size: PageSize): Buffer {
  if (choice.format === "image/pwg-raster") return renderPwgRaster(info, size, choice.dpi, choice.type);
  if (choice.format === "image/urf") return renderUrf(info, size, choice.dpi, choice.color);
  return renderPdf(info, size);
}

export function describeChoice(c: DocumentChoice): string {
  if (c.format === "image/pwg-raster") return `PWG raster ${c.type} ${c.dpi} dpi`;
  if (c.format === "image/urf") return `URF ${c.color} ${c.dpi} dpi`;
  return "PDF";
}

const JOB_STATES: Record<number, string> = { 3: "pending", 4: "pending-held", 5: "processing", 6: "processing-stopped", 7: "canceled", 8: "aborted", 9: "completed" };

/** Job state text: "processing (job-printing)". */
export function jobStatusText(attrs: Record<string, IppValue[]>): { state: number | null; text: string } {
  const s = attrs["job-state"]?.[0];
  const state = typeof s === "number" ? s : null;
  const reasons = strings(attrs["job-state-reasons"]).filter((r) => r !== "none");
  const msg = attrs["job-state-message"]?.[0];
  const parts = [state !== null ? (JOB_STATES[state] ?? `state ${state}`) : "unknown"];
  if (reasons.length) parts.push(`(${reasons.join(", ")})`);
  if (typeof msg === "string" && msg.trim()) parts.push(`- ${msg.trim()}`);
  return { state, text: parts.join(" ").slice(0, 300) };
}

async function addressesOf(host: string): Promise<string[]> {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return [];
  try {
    return [...new Set((await lookup(host, { all: true })).map((a) => a.address))].slice(0, 4);
  } catch {
    return [];
  }
}

export interface DirectDeps {
  getPrinterAttributes: typeof getPrinterAttributes;
  printJob: typeof printJob;
}

/** Sends a direct test print. Throws TestPrintError (rate limit) before anything is sent. */
export async function sendDirectTestPrint(printer: Printer, actor: string, driverMode: string, deps: DirectDeps = { getPrinterAttributes, printJob }): Promise<TestPrint> {
  const cap = directCapability(printer);
  if (!cap.enabled) throw new TestPrintError(cap.reason!);
  let row = await reserveTestPrint({ printer, mode: "direct", actor });
  const uri = printerUri(printer);
  const timeout = Math.max(config().POLL_TIMEOUT_MS, 8000);
  try {
    const attrs = await deps.getPrinterAttributes(uri, FORMAT_ATTRIBUTES, timeout);
    if (attrs["printer-is-accepting-jobs"]?.[0] === false) throw new Error("the printer is not accepting jobs (printer-is-accepting-jobs = false)");
    const choice = chooseDocument(attrs);
    if (!choice) throw new Error("the printer lists no PWG raster, URF or PDF format the server can render (raster resolutions above 600 dpi only)");
    const model = (attrs["printer-make-and-model"]?.[0] as string | undefined) ?? printer.model;
    const info: TestPageInfo = {
      printerName: printer.name,
      host: printer.host,
      addresses: await addressesOf(printer.host),
      model: model ?? null,
      driverMode,
      route: "Spoolfree server, IPP Print-Job (direct)",
      time: new Date(),
      timeZone: config().ANALYTICS_TIME_ZONE,
      id: row.id,
    };
    const doc = renderDocument(choice, info, pageSizeForChoice(choice, attrs));
    const version: [number, number] = strings(attrs["ipp-versions-supported"]).some((v) => v.startsWith("2.")) ? [2, 0] : [1, 1];
    const job = await deps.printJob(uri, { documentFormat: choice.format, jobName: "Spoolfree test page", userName: "spoolfree", jobAttributes: jobAttributesFor(attrs), document: doc, version }, 60_000);
    const jobId = typeof job["job-id"]?.[0] === "number" ? (job["job-id"][0] as number) : null;
    const st = jobStatusText(job);
    row = await transitionTestPrint(row, "sent", {
      format: describeChoice(choice),
      jobId,
      jobUri: typeof job["job-uri"]?.[0] === "string" ? (job["job-uri"][0] as string) : null,
      jobStatus: st.text,
      message: `IPP Print-Job accepted${jobId !== null ? ` (job ${jobId})` : ""}: ${describeChoice(choice)}, ${Math.round(doc.length / 1024)} KB`,
    });
    if (st.state === 9) row = await transitionTestPrint(row, "printed", { message: "the printer reports the job completed" });
    return row;
  } catch (e) {
    const msg = (e as Error).message;
    return transitionTestPrint(row, "failed", { error: msg.slice(0, 1000), message: msg });
  }
}

/** Follows a direct job (Get-Job-Attributes) and records its state. Gives up after 10 minutes without a final state. */
export async function refreshDirectTestPrint(row: TestPrint, printer: Printer, getJob: typeof getJobAttributes = getJobAttributes, now = new Date()): Promise<TestPrint> {
  if (row.mode !== "direct" || !["sent", "printing"].includes(row.state)) return row;
  // Honest results (0.8.1): a job that cannot be followed is "unknown", never "printed".
  if (row.jobId === null) return transitionTestPrint(row, "unknown", { message: "the printer accepted the job but returned no job id to follow: check the paper" }, "system", now);
  if (now.getTime() - row.createdAt.getTime() > 10 * 60_000)
    return transitionTestPrint(row, "failed", { error: "no final job state from the printer after 10 minutes", message: `last state: ${row.jobStatus ?? "unknown"}` }, "system", now);
  try {
    const attrs = await getJob(printerUri(printer), row.jobId, JOB_ATTRIBUTES, Math.max(config().POLL_TIMEOUT_MS, 5000));
    const st = jobStatusText(attrs);
    if (st.state === 9) return transitionTestPrint(row, "printed", { jobStatus: st.text, message: st.text }, "system", now);
    if (st.state === 7 || st.state === 8) return transitionTestPrint(row, "failed", { jobStatus: st.text, error: st.text, message: st.text }, "system", now);
    if (st.state === 5 || st.state === 6) {
      if (row.state !== "printing") return transitionTestPrint(row, "printing", { jobStatus: st.text, message: st.text }, "system", now);
    }
    if (st.text !== row.jobStatus) {
      await db().update(schema.testPrints).set({ jobStatus: st.text }).where(eq(schema.testPrints.id, row.id));
      return { ...row, jobStatus: st.text };
    }
    return row;
  } catch (e) {
    // Most printers drop finished jobs from their list quickly: "not found" (0x0406) after acceptance means done.
    if (e instanceof IppStatusError && e.status === 0x0406)
      return transitionTestPrint(row, "printed", { jobStatus: "no longer listed by the printer", message: "the printer no longer lists the job (finished jobs are dropped)" }, "system", now);
    return row;
  }
}
