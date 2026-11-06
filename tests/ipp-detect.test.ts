import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrinterAttributes, IppHttpError, IppStatusError } from "@/lib/ipp/client";
import { detectIppPath, IPP_PATH_CANDIDATES, IppDetectError, isWrongPathError, type AttributeProbe } from "@/lib/ipp/detect";
import { decodeRequest, encodeMessage, Tag } from "@/lib/ipp/encoding";

const endpoint = { host: "192.0.2.13", port: 631, useTls: false };
const ok = { "printer-uri-supported": [] };

/** A probe that answers only at `path`, and only for the listed versions. */
function probeAt(path: string, versions = ["2.0", "1.1"]) {
  const calls: string[] = [];
  const probe: AttributeProbe = async (uri, _req, _t, version) => {
    const v = version.join(".");
    const p = new URL(uri).pathname;
    calls.push(`${p}@${v}`);
    if (p !== path) throw new IppHttpError(404, `HTTP 404 from ${p}`);
    if (!versions.includes(v)) throw new IppStatusError(0x0503, "IPP status 0x0503");
    return ok;
  };
  return { probe, calls };
}

describe("IPP path detection", () => {
  it("tries the candidates in order and keeps the first that answers (IPP 2.0)", async () => {
    const { probe, calls } = probeAt("/ipp/printer");
    const r = await detectIppPath(endpoint, ["printer-uri-supported"], 1000, probe);
    expect(r).toMatchObject({ path: "/ipp/printer", version: "2.0", uri: "ipp://192.0.2.13:631/ipp/printer" });
    expect(calls).toEqual(["/ipp/print@2.0", "/ipp@2.0", "/ipp/printer@2.0"]);
  });

  it("falls back to IPP 1.1 when no path answers 2.0", async () => {
    const { probe, calls } = probeAt("/printers/lp1", ["1.1"]);
    const r = await detectIppPath(endpoint, [], 1000, probe);
    expect(r).toMatchObject({ path: "/printers/lp1", version: "1.1" });
    expect(calls.filter((c) => c.endsWith("@2.0"))).toHaveLength(IPP_PATH_CANDIDATES.length);
    expect(calls.at(-1)).toBe("/printers/lp1@1.1");
  });

  it("tries the root path last", async () => {
    const { probe } = probeAt("/");
    expect((await detectIppPath(endpoint, [], 1000, probe)).path).toBe("/");
  });

  it("stops at the first network error instead of waiting out every candidate", async () => {
    let n = 0;
    const probe: AttributeProbe = async () => {
      n++;
      throw new Error("connect ECONNREFUSED 192.0.2.13:631");
    };
    await expect(detectIppPath(endpoint, [], 1000, probe)).rejects.toBeInstanceOf(IppDetectError);
    expect(n).toBe(1);
  });

  it("reports every attempt when nothing answers", async () => {
    const { probe } = probeAt("/nowhere");
    const e = await detectIppPath(endpoint, [], 1000, probe).catch((x) => x as IppDetectError);
    expect(e).toBeInstanceOf(IppDetectError);
    expect(e.tried).toHaveLength(IPP_PATH_CANDIDATES.length * 2);
  });

  it("tests only the manual path when one is given", async () => {
    const { probe, calls } = probeAt("/custom");
    const r = await detectIppPath(endpoint, [], 1000, probe, ["/custom"]);
    expect(r.path).toBe("/custom");
    expect(calls).toEqual(["/custom@2.0"]);
  });

  it("classifies wrong-path errors", () => {
    expect(isWrongPathError(new IppHttpError(404, "x"))).toBe(true);
    expect(isWrongPathError(new IppStatusError(0x0400, "x"))).toBe(true);
    expect(isWrongPathError(new Error("timeout after 1000 ms"))).toBe(false);
  });
});

describe("IPP path detection against a device", () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    // Answers Get-Printer-Attributes only at /ipp and only for IPP 1.1 requests.
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const r = decodeRequest(Buffer.concat(chunks));
        seen.push(`${req.url}@${r.version.join(".")}`);
        if (req.url !== "/ipp") {
          res.writeHead(404).end();
          return;
        }
        const status = r.version[0] === 1 ? 0x0000 : 0x0503;
        const body = encodeMessage({
          version: [1, 1],
          code: status,
          requestId: r.requestId,
          groups: [
            { tag: Tag.operationAttributes, attributes: [{ tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] }, { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] }] },
            ...(status === 0 ? [{ tag: Tag.printerAttributes, attributes: [{ tag: Tag.uri, name: "printer-uri-supported", values: [`ipp://127.0.0.1:${port}/ipp`] }] }] : []),
          ],
        });
        res.writeHead(200, { "Content-Type": "application/ipp" }).end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("finds /ipp with IPP 1.1 over HTTP", async () => {
    const r = await detectIppPath({ host: "127.0.0.1", port, useTls: false }, ["printer-uri-supported"], 2000, getPrinterAttributes);
    expect(r).toMatchObject({ path: "/ipp", version: "1.1" });
    expect(seen).toContain("/ipp@2.0");
    expect(seen.at(-1)).toBe("/ipp@1.1");
  });
});
