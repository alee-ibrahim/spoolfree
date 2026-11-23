import http from "node:http";
import https from "node:https";
import {
  esclBase,
  esclCandidates,
  parseCapabilities,
  parseScannerStatus,
  scanSettingsXml,
  sniffImageType,
  type EsclEndpoint,
  type ScanChoice,
  type ScannerInfo,
  type ScannerStatusInfo,
} from "./escl";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One HTTP(S) request to a printer. HTTPS skips certificate validation like the IPP client: printer certificates are
 * almost always self-signed. timeoutMs is both the idle timeout and an overall deadline; bodies above maxBytes abort.
 */
export async function esclRequest(
  url: string,
  opts: { method?: "GET" | "POST" | "DELETE"; body?: string; timeoutMs: number; maxBytes: number },
): Promise<HttpResult> {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const lib = secure ? https : http;
  const body = opts.body !== undefined ? Buffer.from(opts.body, "utf8") : undefined;
  let deadline: NodeJS.Timeout | undefined;
  return new Promise<HttpResult>((resolve, reject) => {
    const req = lib.request(
      {
        host: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port ? Number(u.port) : secure ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: body ? { "Content-Type": "text/xml", "Content-Length": body.length } : {},
        timeout: opts.timeoutMs,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            req.destroy(new Error(`response larger than ${Math.round(opts.maxBytes / 1024 / 1024)} MB`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    deadline = setTimeout(() => {
      const err = new Error(`no complete response within ${opts.timeoutMs} ms`);
      reject(err);
      req.destroy(err);
    }, opts.timeoutMs);
    req.end(body);
  }).finally(() => clearTimeout(deadline));
}

const XML_MAX = 1024 * 1024;

/** GET ScannerCapabilities at one endpoint; null when there is no eSCL scanner there. */
export async function readCapabilities(host: string, e: EsclEndpoint, timeoutMs: number): Promise<ScannerInfo | null> {
  const r = await esclRequest(`${esclBase(host, e)}/ScannerCapabilities`, { timeoutMs, maxBytes: XML_MAX });
  if (r.status !== 200) return null;
  const xml = r.body.toString("utf8");
  if (!/ScannerCapabilities/.test(xml)) return null;
  return { ...e, ...parseCapabilities(xml) };
}

export interface DetectResult {
  scanner: ScannerInfo | null;
  /** Each endpoint tried with what it answered, for the UI. */
  tried: { url: string; result: string }[];
}

/** Looks for an eSCL scanner on the printer's host (esclCandidates, first match wins). */
export async function detectScanner(p: { host: string; port?: number | null; useTls?: boolean | null }, timeoutMs: number): Promise<DetectResult> {
  const tried: DetectResult["tried"] = [];
  for (const e of esclCandidates(p)) {
    const url = esclBase(p.host, e);
    try {
      const s = await readCapabilities(p.host, e, timeoutMs);
      tried.push({ url, result: s ? "eSCL scanner" : "no eSCL service" });
      if (s) return { scanner: s, tried };
    } catch (err) {
      tried.push({ url, result: (err as Error).message });
    }
  }
  return { scanner: null, tried };
}

export async function readScannerStatus(host: string, e: EsclEndpoint, timeoutMs: number): Promise<ScannerStatusInfo> {
  const r = await esclRequest(`${esclBase(host, e)}/ScannerStatus`, { timeoutMs, maxBytes: XML_MAX });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ScannerStatus`);
  return parseScannerStatus(r.body.toString("utf8"));
}

export class ScanError extends Error {}

export interface ScanResult {
  format: string;
  data: Buffer;
}

export interface ScanDeps {
  request: typeof esclRequest;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: ScanDeps = { request: esclRequest, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

/**
 * Runs one scan job: POST ScanJobs, then GET <job>/NextDocument until the first page is ready (503 = not yet), then
 * DELETE the job so the scanner is free again (any further feeder pages are dropped). The job URL the scanner returns
 * must be on the same host and port: the server never follows a scanner elsewhere.
 */
export async function runScanJob(
  host: string,
  scanner: ScannerInfo,
  choice: ScanChoice,
  opts: { requestTimeoutMs: number; totalTimeoutMs: number; maxBytes: number },
  deps: ScanDeps = defaultDeps,
): Promise<ScanResult> {
  const base = esclBase(host, scanner);
  const started = deps.now();
  const post = await deps.request(`${base}/ScanJobs`, { method: "POST", body: scanSettingsXml(choice, scanner.version), timeoutMs: opts.requestTimeoutMs, maxBytes: XML_MAX });
  if (post.status === 409 || post.status === 503) throw new ScanError("the scanner is busy (another scan or copy is running); try again in a moment");
  if (post.status !== 201) throw new ScanError(`the scanner refused the scan job (HTTP ${post.status})`);
  const location = post.headers.location;
  if (!location) throw new ScanError("the scanner accepted the job but returned no job address");
  const job = new URL(location, `${base}/ScanJobs`);
  if (job.origin !== new URL(base).origin) throw new ScanError(`the scanner returned a job address on another host (${job.origin}); not followed`);
  const jobUrl = job.toString().replace(/\/$/, "");
  try {
    for (;;) {
      const left = opts.totalTimeoutMs - (deps.now() - started);
      if (left <= 0) throw new ScanError(`no scanned page within ${Math.round(opts.totalTimeoutMs / 1000)} s`);
      const r = await deps.request(`${jobUrl}/NextDocument`, { timeoutMs: Math.min(left, Math.max(opts.requestTimeoutMs, 60_000)), maxBytes: opts.maxBytes });
      if (r.status === 200) {
        if (!r.body.length) throw new ScanError("the scanner returned an empty document");
        const sniffed = sniffImageType(r.body);
        if (!sniffed) throw new ScanError(`the scanner returned data that is not ${choice.format}`);
        return { format: sniffed, data: r.body };
      }
      if (r.status === 503) {
        await deps.sleep(1000);
        continue;
      }
      if (r.status === 404) throw new ScanError(choice.source === "feeder" ? "no page in the document feeder" : "the scanner ended the job without a page");
      throw new ScanError(`HTTP ${r.status} while fetching the scanned page`);
    }
  } finally {
    await deps.request(jobUrl, { method: "DELETE", timeoutMs: opts.requestTimeoutMs, maxBytes: XML_MAX }).catch(() => undefined);
  }
}
