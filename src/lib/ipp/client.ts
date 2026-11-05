import http from "node:http";
import https from "node:https";
import { decodeResponse, getPrinterAttributesRequest, isSuccess, printerAttributes, type IppValue } from "./encoding";

/**
 * Sends a Get-Printer-Attributes request over HTTP(S).
 * `ipps://` uses TLS without certificate validation: printer certificates are
 * almost always self-signed, and the request only reads public status data.
 */
export async function getPrinterAttributes(
  uri: string,
  requested: string[],
  timeoutMs: number,
): Promise<Record<string, IppValue[]>> {
  const url = new URL(uri);
  const secure = url.protocol === "ipps:" || url.protocol === "https:";
  const body = getPrinterAttributesRequest(uri, requested, Math.floor(Math.random() * 0x7fffffff) || 1);
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
          reject(new Error(`HTTP ${res.statusCode} from ${url.host}${url.pathname}`));
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
    throw new Error(`IPP status 0x${res.statusCode.toString(16).padStart(4, "0")}`);
  }
  return printerAttributes(res);
}
