import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrinterAttributes } from "@/lib/ipp/client";
import {
  decodeRequest,
  decodeResponse,
  encodeMessage,
  getPrinterAttributesRequest,
  isSuccess,
  Operation,
  printerAttributes,
  Tag,
} from "@/lib/ipp/encoding";
import { checkDriverless, lowMarkers, markersFrom, needsAttention, normalizeLevel, printerUri, statusFromIpp } from "@/lib/ipp/interpret";
import { SIMS, startSim } from "../scripts/fake-printers";

describe("IPP encoder", () => {
  it("encodes Get-Printer-Attributes per RFC 8010", () => {
    const buf = getPrinterAttributesRequest("ipp://192.0.2.10:631/ipp/print", ["printer-state", "marker-levels"], 7);
    // version 2.0, operation 0x000B, request-id 7, operation-attributes tag
    expect(buf.subarray(0, 9).toString("hex")).toBe("0200000b0000000701");
    // first attribute: charset "attributes-charset" = "utf-8"
    const nameLen = buf.readUInt16BE(10);
    expect(buf[9]).toBe(Tag.charset);
    expect(buf.subarray(12, 12 + nameLen).toString()).toBe("attributes-charset");
    expect(buf[buf.length - 1]).toBe(Tag.endOfAttributes);
    // additional value of requested-attributes has zero-length name
    const idx = buf.indexOf(Buffer.from("marker-levels"));
    expect(buf.readUInt16BE(idx - 2)).toBe("marker-levels".length);
    expect(buf.readUInt16BE(idx - 4)).toBe(0);
    expect(buf[idx - 5]).toBe(Tag.keyword);
  });

  it("round-trips through the decoder", () => {
    const buf = getPrinterAttributesRequest("ipp://h/ipp/print", ["a", "b", "c"], 99);
    const r = decodeRequest(buf);
    expect(r.operation).toBe(Operation.getPrinterAttributes);
    expect(r.requestId).toBe(99);
    expect(r.groups[0].attributes["requested-attributes"]).toEqual(["a", "b", "c"]);
    expect(r.groups[0].attributes["printer-uri"]).toEqual(["ipp://h/ipp/print"]);
  });

  it("decodes integers, enums, booleans, ranges, resolutions and dates", () => {
    const res = Buffer.concat([
      Buffer.from("0101000000000001", "hex"),
      Buffer.from([Tag.printerAttributes]),
      attr(Tag.enum, "printer-state", int32(4)),
      attr(Tag.integer, "marker-levels", int32(80)),
      attr(Tag.integer, "", int32(-3)),
      attr(Tag.boolean, "color-supported", Buffer.from([1])),
      attr(Tag.rangeOfInteger, "copies-supported", Buffer.concat([int32(1), int32(99)])),
      attr(Tag.resolution, "printer-resolution-default", Buffer.from("0000012c0000012c03", "hex")),
      attr(Tag.dateTime, "printer-current-time", Buffer.from([0x07, 0xea, 11, 5, 14, 30, 0, 0, "+".charCodeAt(0), 5, 0])),
      attr(Tag.textWithLanguage, "printer-info", Buffer.concat([u16(2), Buffer.from("en"), u16(5), Buffer.from("Hello")])),
      attr(Tag.noValue, "printer-location", Buffer.alloc(0)),
      Buffer.from([Tag.endOfAttributes]),
    ]);
    const r = decodeResponse(res);
    expect(r.version).toEqual([1, 1]);
    expect(isSuccess(r.statusCode)).toBe(true);
    const a = printerAttributes(r);
    expect(a["printer-state"]).toEqual([4]);
    expect(a["marker-levels"]).toEqual([80, -3]);
    expect(a["color-supported"]).toEqual([true]);
    expect(a["copies-supported"]).toEqual([{ lower: 1, upper: 99 }]);
    expect(a["printer-resolution-default"]).toEqual([{ x: 300, y: 300, units: 3 }]);
    expect(a["printer-current-time"]).toEqual(["2026-11-05T09:30:00.000Z"]);
    expect(a["printer-info"]).toEqual(["Hello"]);
    expect(a["printer-location"]).toEqual([null]);
  });

  it("decodes collections", () => {
    const res = Buffer.concat([
      Buffer.from("0200000000000001", "hex"),
      Buffer.from([Tag.printerAttributes]),
      attr(Tag.begCollection, "media-col-default", Buffer.alloc(0)),
      attr(Tag.memberAttrName, "", Buffer.from("media-type")),
      attr(Tag.keyword, "", Buffer.from("stationery")),
      attr(Tag.memberAttrName, "", Buffer.from("media-size")),
      attr(Tag.begCollection, "", Buffer.alloc(0)),
      attr(Tag.memberAttrName, "", Buffer.from("x-dimension")),
      attr(Tag.integer, "", int32(21000)),
      attr(Tag.endCollection, "", Buffer.alloc(0)),
      attr(Tag.endCollection, "", Buffer.alloc(0)),
      attr(Tag.keyword, "sides-default", Buffer.from("one-sided")),
      Buffer.from([Tag.endOfAttributes]),
    ]);
    const a = printerAttributes(decodeResponse(res));
    expect(a["media-col-default"]).toEqual([{ "media-type": "stationery", "media-size": { "x-dimension": 21000 } }]);
    expect(a["sides-default"]).toEqual(["one-sided"]);
  });

  it("encodes responses and rejects truncated messages", () => {
    const buf = encodeMessage({
      code: 0x0400,
      requestId: 3,
      groups: [{ tag: Tag.operationAttributes, attributes: [{ tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] }] }],
    });
    const r = decodeResponse(buf);
    expect(r.statusCode).toBe(0x0400);
    expect(isSuccess(r.statusCode)).toBe(false);
    expect(() => decodeResponse(buf.subarray(0, buf.length - 4))).toThrow(/truncated/);
  });
});

describe("IPP interpretation", () => {
  it("accepts IPP Everywhere / AirPrint printers as driverless", () => {
    const c = checkDriverless({
      "document-format-supported": ["application/octet-stream", "image/pwg-raster", "image/urf"],
      "ipp-versions-supported": ["1.1", "2.0"],
      "printer-make-and-model": ["Acme 1000"],
      "sides-supported": ["one-sided", "two-sided-long-edge"],
      "color-supported": [false],
    });
    expect(c.ok).toBe(true);
    expect(c.driverlessFormats).toEqual(["image/pwg-raster", "image/urf"]);
    expect(c.duplex).toBe(true);
    expect(c.problems).toEqual([]);
  });

  it("rejects PCL/PostScript-only printers", () => {
    const c = checkDriverless({ "document-format-supported": ["application/vnd.hp-pcl", "application/postscript"], "ipp-versions-supported": ["1.1"] });
    expect(c.ok).toBe(false);
    expect(c.problems).toHaveLength(2);
  });

  it("normalizes marker levels including unknown sentinels", () => {
    expect(normalizeLevel(50, 100)).toBe(50);
    expect(normalizeLevel(30, 60)).toBe(50);
    expect(normalizeLevel(-1, 100)).toBeNull();
    expect(normalizeLevel(-3, 100)).toBeNull();
    const m = markersFrom(
      { "marker-names": ["K", "C"], "marker-levels": [8, -3], "marker-colors": ["#000000", "#00FFFF"], "marker-low-levels": [10, 10] },
      15,
    );
    expect(m.map((x) => [x.level, x.low])).toEqual([[8, true], [null, false]]);
  });

  it("derives status, attention reasons and low supplies", () => {
    const s = statusFromIpp(
      {
        "printer-state": [5],
        "printer-state-reasons": ["media-jam-error", "toner-low-warning"],
        "marker-names": ["Black"],
        "marker-levels": [5],
        "printer-impressions-completed": [1234],
      },
      15,
    );
    expect(s.state).toBe("stopped");
    expect(needsAttention(s)).toEqual(["media-jam"]);
    expect(lowMarkers(s).map((m) => m.name)).toEqual(["Black"]);
    expect(s.pageCount).toBe(1234);
  });

  it("builds printer URIs", () => {
    expect(printerUri({ host: "192.0.2.5" })).toBe("ipp://192.0.2.5:631/ipp/print");
    expect(printerUri({ host: "printer.example.org", port: 443, useTls: true, ippPath: "ipp/print" })).toBe("ipps://printer.example.org:443/ipp/print");
    expect(printerUri({ host: "2001:db8::5" })).toBe("ipp://[2001:db8::5]:631/ipp/print");
  });
});

describe("IPP client against the simulator", () => {
  const sim = { ...SIMS[1], port: 0 };
  let server: ReturnType<typeof startSim>;
  let port = 0;
  beforeAll(async () => {
    server = startSim(sim);
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("reads attributes over HTTP and recognises a driverless printer", async () => {
    const attrs = await getPrinterAttributes(`ipp://127.0.0.1:${port}/ipp/print`, ["all"], 2000);
    expect(checkDriverless(attrs).ok).toBe(true);
    const s = statusFromIpp(attrs, 15);
    expect(s.online).toBe(true);
    expect(s.markers[0]).toMatchObject({ name: "Black Cartridge", level: 8, low: true });
    expect(s.pageCount).toBe(120447);
  });

  it("times out on unreachable printers", async () => {
    await expect(getPrinterAttributes("ipp://127.0.0.1:1/ipp/print", ["all"], 500)).rejects.toThrow();
  });
});

function u16(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function int32(n: number) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
function attr(tag: number, name: string, value: Buffer) {
  return Buffer.concat([Buffer.from([tag]), u16(name.length), Buffer.from(name), u16(value.length), value]);
}

describe("IPP client deadline (L8)", () => {
  it("gives up on a device that drips bytes slower than the deadline but faster than the idle timeout", async () => {
    const { createServer } = await import("node:http");
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/ipp" });
      const t = setInterval(() => res.write(Buffer.from([0])), 100);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    try {
      await expect(getPrinterAttributes(`ipp://127.0.0.1:${port}/ipp/print`, ["all"], 600)).rejects.toThrow(/600 ms/);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      timers.forEach(clearInterval);
      server.closeAllConnections();
      server.close();
    }
  });
});
