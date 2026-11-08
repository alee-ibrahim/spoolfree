import http from "node:http";
import https from "node:https";
import { decodeResponse, getJobsRequest, getPrinterAttributesRequest, isSuccess, printerAttributes, Tag, type IppResponse, type IppValue } from "./encoding";

/**
 * Sends a Get-Printer-Attributes request over HTTP(S).
 * `ipps://` uses TLS without certificate validation: printer certificates are
 * almost always self-signed, and the request only reads public status data.
 */
export async function getPrinterAttributes(
  uri: string,
  requested: string[],
  timeoutMs: number,
  version: [number, number] = [2, 0],
): Promise<Record<string, IppValue[]>> {
  const body = getPrinterAttributesRequest(uri, requested, Math.floor(Math.random() * 0x7fffffff) || 1, version);
  return printerAttributes(await ippPost(uri, body, timeoutMs));
}

/** Completed jobs (Get-Jobs which-jobs=completed): one attribute record per job, newest first as the printer lists them. */
export async function getCompletedJobs(uri: string, requested: string[], timeoutMs: number, limit = 20): Promise<Record<string, IppValue[]>[]> {
  const body = getJobsRequest(uri, requested, "completed", limit, Math.floor(Math.random() * 0x7fffffff) || 1);
  const res = await ippPost(uri, body, timeoutMs);
  return res.groups.filter((g) => g.tag === Tag.jobAttributes).map((g) => g.attributes);
}

/** POSTs an IPP request and returns the decoded response; throws on HTTP or IPP errors. */
export async function ippPost(uri: string, body: Buffer, timeoutMs: number): Promise<IppResponse> {
  const url = new URL(uri);
  const secure = url.protocol === "ipps:" || url.protocol === "https:";
  const port = url.port ? Number(url.port) : 631;
  const lib = secure ? https : http;

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const req = lib.request(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: url.pathname || "/ipp/print",
        method: "POST",
        headers: { "Content-Type": "application/ipp", "Content-Length": body.length },
        timeout: timeoutMs,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new IppHttpError(res.statusCode ?? 0, `HTTP ${res.statusCode} from ${url.host}${url.pathname}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error("IPP response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });

  const res = decodeResponse(buf);
  if (!isSuccess(res.statusCode)) {
    throw new IppStatusError(res.statusCode, `IPP status 0x${res.statusCode.toString(16).padStart(4, "0")}`);
  }
  return res;
}

/** The device answered HTTP, but not with 200 (wrong path, IPP not served there). */
export class IppHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The device answered IPP with an error status (e.g. 0x0503 version not supported, 0x0400 bad request). */
export class IppStatusError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
