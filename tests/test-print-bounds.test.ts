import { describe, expect, it } from "vitest";
import { A4, LETTER, assertRasterSize, choosePageSize, GrayCanvas, MAX_RASTER_PIXELS, MAX_RENDER_DPI, rasterize, rasterPixels, RasterTooLargeError } from "@/lib/test-print/page";
import { chooseDocument, pageSizeForChoice, pickDpi } from "@/lib/test-print/direct";

const res = (x: number) => ({ x, y: x, units: 3 });

describe("direct test print: raster bounds (M1)", () => {
  it("never picks more than 600 dpi", () => {
    expect(pickDpi([1200])).toBeNull();
    expect(pickDpi([600, 1200])).toBe(600);
    expect(pickDpi([300, 600, 1200])).toBe(300);
    expect(pickDpi([150, 1200])).toBe(150);
    expect(pickDpi([])).toBe(300);
    expect(MAX_RENDER_DPI).toBe(600);
  });

  it("falls back from 1200-dpi-only PWG raster to URF or PDF, and to nothing when neither is offered", () => {
    expect(chooseDocument({ "document-format-supported": ["image/pwg-raster", "application/pdf"], "pwg-raster-document-resolution-supported": [res(1200)] })).toEqual({ format: "application/pdf" });
    expect(
      chooseDocument({ "document-format-supported": ["image/pwg-raster", "image/urf"], "pwg-raster-document-resolution-supported": [res(1200)], "urf-supported": ["W8", "RS600"] }),
    ).toEqual({ format: "image/urf", color: "W8", dpi: 600 });
    expect(chooseDocument({ "document-format-supported": ["image/pwg-raster"], "pwg-raster-document-resolution-supported": [res(1200)] })).toBeNull();
    expect(chooseDocument({ "document-format-supported": ["image/urf"], "urf-supported": ["W8", "RS1200"] })).toBeNull();
  });

  it("prefers A4 or Letter over the printer's largest default media", () => {
    expect(choosePageSize("iso_a3_297x420mm", ["iso_a3_297x420mm", "iso_a4_210x297mm", "na_letter_8.5x11in"])).toEqual(A4);
    expect(choosePageSize("na_ledger_11x17in", ["na_ledger_11x17in", "iso_a4_210x297mm", "na_letter_8.5x11in"])).toEqual(LETTER);
    expect(choosePageSize("na_letter_8.5x11in", ["iso_a4_210x297mm"])).toEqual(LETTER);
    expect(choosePageSize("iso_a4_210x297mm", [])).toEqual(A4);
    expect(choosePageSize(null, [])).toEqual(A4);
  });

  it("renders a hostile A3-only 600 dpi printer on A4 instead of allocating a huge canvas", () => {
    const attrs = { "document-format-supported": ["image/pwg-raster"], "pwg-raster-document-resolution-supported": [res(600)], "media-default": ["oe_300x432mm_300x432mm"] };
    const choice = chooseDocument(attrs)!;
    expect(choice).toMatchObject({ dpi: 600 });
    expect(rasterPixels({ name: "x", widthMm: 300, heightMm: 432 }, 600)).toBeGreaterThan(MAX_RASTER_PIXELS);
    expect(pageSizeForChoice(choice, attrs)).toEqual(A4);
    expect(rasterPixels(A4, 600)).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
  });

  it("refuses to allocate above the caps (fails, never OOMs)", () => {
    expect(() => assertRasterSize(A4, 1200)).toThrow(RasterTooLargeError);
    expect(() => assertRasterSize({ name: "big", widthMm: 300, heightMm: 432 }, 600)).toThrow(/MP/);
    expect(() => new GrayCanvas(14_173, 20_409)).toThrow(RasterTooLargeError);
    expect(() => rasterize([], A4, 1200)).toThrow(RasterTooLargeError);
    expect(rasterize([], A4, 72).width).toBe(595);
  });
});
