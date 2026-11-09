import path from "node:path";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { generateSeed, privateKeyFromSeed, publicKeyRaw, verifyBytes } from "@/lib/crypto/signing";
import { buildManifest, signManifest } from "@/lib/manifest";
import { getJobAttributes, getPrinterAttributes, printJob } from "@/lib/ipp/client";
import { Tag } from "@/lib/ipp/encoding";
import { asciiText, glyph } from "@/lib/test-print/font";
import { A4, LETTER, layoutTestPage, packLine, pageSizeFor, renderPdf, renderPwgRaster, renderUrf, type TestPageInfo } from "@/lib/test-print/page";
import { canTransition, commandSigningBytes, signCommand, verifyCommand, versionAtLeast, type SignedCommand } from "@/lib/test-print/command";
import { chooseDocument, directCapability, jobAttributesFor, jobStatusText, pickDpi, refreshDirectTestPrint, sendDirectTestPrint } from "@/lib/test-print/direct";
import { SIMS, startSim } from "../scripts/fake-printers";

const pg = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async () => {
  const schemaMod = await import("@/lib/db/schema");
  return { db: () => pg.db, schema: schemaMod, sqlClient: () => null };
});

type Db = ReturnType<typeof drizzle<typeof schema>>;
let d: Db;

const INFO: TestPageInfo = {
  printerName: "Finance Laser",
  host: "printer.example.org",
  addresses: ["192.0.2.20"],
  model: "Brother HL-L5100DN",
  driverMode: "auto (PCs get driverless IPP)",
  route: "Spoolfree server, IPP Print-Job (direct)",
  time: new Date("2026-11-09T10:00:00Z"),
  timeZone: "Indian/Maldives",
};

/** Decodes PWG/URF run-length lines (the inverse of packLine) into rows of `bytesPerLine`. */
function unpackLines(data: Buffer, bytesPerLine: number, unit: number, height: number): Buffer[] {
  const rows: Buffer[] = [];
  let pos = 0;
  while (rows.length < height) {
    const repeat = data[pos++] + 1;
    const line = Buffer.alloc(bytesPerLine);
    let x = 0;
    while (x < bytesPerLine) {
      const n = data[pos++];
      if (n <= 127) {
        const px = data.subarray(pos, pos + unit);
        pos += unit;
        for (let k = 0; k <= n; k++) px.copy(line, x + k * unit);
        x += (n + 1) * unit;
      } else {
        const count = 257 - n;
        data.copy(line, x, pos, pos + count * unit);
        pos += count * unit;
        x += count * unit;
      }
    }
    for (let k = 0; k < repeat; k++) rows.push(line);
  }
  expect(pos).toBe(data.length);
  return rows;
}

describe("test page", () => {
  it("has a 5x7 glyph for every printable ASCII character and maps the rest to ?", () => {
    expect(glyph("A")).toEqual([14, 17, 17, 17, 31, 17, 17]);
    expect(glyph("ހ")).toEqual(glyph("?"));
    expect(asciiText("Café Ļ ދ")).toBe("Cafe L ?");
  });

  it("lays out the title, printer, IP, time, model, driver mode and an alignment box", () => {
    const els = layoutTestPage({ ...INFO, id: "abc" }, A4);
    const texts = els.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
    expect(texts).toContain("Spoolfree test page");
    expect(texts).toContain("Finance Laser");
    expect(texts).toContain("192.0.2.20");
    expect(texts).toContain("Brother HL-L5100DN");
    expect(texts).toContain("auto (PCs get driverless IPP)");
    expect(texts.some((t) => t.includes("2026") && t.includes("Indian/Maldives"))).toBe(true);
    expect(els).toContainEqual({ kind: "box", x: 10, y: 10, w: 190, h: 277, line: 0.5 });
  });

  it("reads the page size from media-default", () => {
    expect(pageSizeFor("na_letter_8.5x11in")).toEqual({ ...LETTER });
    expect(pageSizeFor("iso_a4_210x297mm")).toEqual(A4);
    expect(pageSizeFor("oe_photo-l_3.5x5in")).toEqual(A4);
    expect(pageSizeFor(null)).toEqual(A4);
  });

  it("run-length encodes lines losslessly", () => {
    const line = new Uint8Array([255, 255, 255, 0, 1, 2, 3, 3, 3, 9, ...new Array(300).fill(7), 5]);
    const packed = packLine(line, 1);
    expect(unpackLines(Buffer.concat([Buffer.from([0]), packed]), line.length, 1, 1)[0]).toEqual(Buffer.from(line));
    const rgb = new Uint8Array([1, 2, 3, 1, 2, 3, 4, 5, 6]);
    expect(unpackLines(Buffer.concat([Buffer.from([0]), packLine(rgb, 3)]), 9, 3, 1)[0]).toEqual(Buffer.from(rgb));
  });

  it("renders PWG raster with a valid header and decodable lines (sgray_8 and black_1)", () => {
    const doc = renderPwgRaster(INFO, A4, 150, "sgray_8");
    expect(doc.subarray(0, 4).toString()).toBe("RaS2");
    const h = doc.subarray(4, 4 + 1796);
    expect(h.toString("ascii", 0, 9)).toBe("PwgRaster");
    expect(h.readUInt32BE(276)).toBe(150);
    const w = h.readUInt32BE(372);
    const ht = h.readUInt32BE(376);
    expect([w, ht]).toEqual([1240, 1754]);
    expect(h.readUInt32BE(392)).toBe(w);
    expect(h.readUInt32BE(400)).toBe(18);
    expect(h.toString("ascii", 1732, 1732 + 16)).toBe("iso_a4_210x297mm");
    const rows = unpackLines(doc.subarray(1800), w, 1, ht);
    // The alignment box: 10 mm from the top is black across the page, the margin above is white.
    const y10 = Math.round((10 / 25.4) * 150) + 1;
    expect(rows[y10][Math.round(w / 2)]).toBe(0);
    expect(rows[5].every((b) => b === 255)).toBe(true);
    // Compressed to a small fraction of the 2 MB bitmap.
    expect(doc.length).toBeLessThan(200_000);

    const bw = renderPwgRaster(INFO, A4, 300, "black_1");
    const bh = bw.subarray(4, 1800);
    expect(bh.readUInt32BE(388)).toBe(1);
    expect(bh.readUInt32BE(392)).toBe(Math.ceil(bh.readUInt32BE(372) / 8));
    unpackLines(bw.subarray(1800), bh.readUInt32BE(392), 1, bh.readUInt32BE(376));
  });

  it("renders URF (Apple raster)", () => {
    const doc = renderUrf(INFO, LETTER, 300, "W8");
    expect(doc.subarray(0, 8).toString("latin1")).toBe("UNIRAST\0");
    expect(doc.readUInt32BE(8)).toBe(1);
    const page = doc.subarray(12, 44);
    expect(page[0]).toBe(8);
    expect(page[1]).toBe(0);
    expect(page.readUInt32BE(12)).toBe(2550);
    expect(page.readUInt32BE(16)).toBe(3300);
    expect(page.readUInt32BE(20)).toBe(300);
    unpackLines(doc.subarray(44), 2550, 1, 3300);
  });

  it("renders a one-page PDF with a correct xref", () => {
    const pdf = renderPdf({ ...INFO, printerName: "Copier (2nd floor) \\ A" }, A4).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("(Spoolfree test page) Tj");
    expect(pdf).toContain("(Copier \\(2nd floor\\) \\\\ A) Tj");
    expect(pdf).toContain("/MediaBox [0 0 595.28 841.89]");
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});

describe("format choice (Brother/HP/Toshiba-safe defaults)", () => {
  it("prefers grey PWG raster at 300 dpi, then URF, then PDF", () => {
    const res = (x: number) => ({ x, y: x, units: 3 });
    expect(chooseDocument({ "document-format-supported": ["image/pwg-raster", "application/pdf"], "pwg-raster-document-resolution-supported": [res(300), res(600)], "pwg-raster-document-type-supported": ["srgb_8", "sgray_8"] })).toEqual({ format: "image/pwg-raster", type: "sgray_8", dpi: 300 });
    expect(chooseDocument({ "document-format-supported": ["image/pwg-raster"], "pwg-raster-document-resolution-supported": [res(600)], "pwg-raster-document-type-supported": ["black_1", "srgb_8"] })).toEqual({ format: "image/pwg-raster", type: "black_1", dpi: 600 });
    expect(chooseDocument({ "document-format-supported": ["image/urf", "application/pdf"], "urf-supported": ["V1.4", "SRGB24", "W8", "RS300-600", "DM1"] })).toEqual({ format: "image/urf", color: "W8", dpi: 300 });
    expect(chooseDocument({ "document-format-supported": ["application/pdf", "application/postscript"] })).toEqual({ format: "application/pdf" });
    expect(chooseDocument({ "document-format-supported": ["application/vnd.hp-pcl"] })).toBeNull();
    expect(pickDpi([200, 1200])).toBe(200);
    expect(pickDpi([])).toBe(300);
  });

  it("asks for one-sided and monochrome only when the printer lists them", () => {
    expect(jobAttributesFor({ "sides-supported": ["one-sided", "two-sided-long-edge"], "print-color-mode-supported": ["auto", "monochrome"] })).toEqual([
      { tag: Tag.keyword, name: "sides", values: ["one-sided"] },
      { tag: Tag.keyword, name: "print-color-mode", values: ["monochrome"] },
    ]);
    expect(jobAttributesFor({})).toEqual([]);
  });

  it("disables direct mode for IPP 1.x and non-driverless printers, and before the first Test", () => {
    const base = { ok: true, formats: [], driverlessFormats: ["image/pwg-raster"], ippVersions: ["1.1", "2.0"], model: null, uuid: null, features: [], color: false, duplex: false, problems: [] };
    const at = new Date();
    expect(directCapability({ lastTest: base, lastTestAt: at })).toEqual({ enabled: true, reason: null });
    expect(directCapability({ lastTest: { ...base, ippVersions: ["1.0", "1.1"] }, lastTestAt: at }).reason).toMatch(/IPP 1\.x only/);
    expect(directCapability({ lastTest: { ...base, driverlessFormats: [] }, lastTestAt: at }).reason).toMatch(/not driverless/);
    expect(directCapability({ lastTest: null, lastTestAt: null }).enabled).toBe(false);
  });

  it("describes IPP job states", () => {
    expect(jobStatusText({ "job-state": [5], "job-state-reasons": ["job-printing"] }).text).toBe("processing (job-printing)");
    expect(jobStatusText({ "job-state": [8], "job-state-reasons": ["none"], "job-state-message": ["Paper jam"] })).toEqual({ state: 8, text: "aborted - Paper jam" });
  });
});

// --- Against a database and the fake printer --------------------------------------------------------------------

const seed = generateSeed();
const key = privateKeyFromSeed(seed.seed);
const pub = publicKeyRaw(key);
const GUID = "11111111-2222-3333-4444-555555555555";

async function addPrinter(name: string, port: number, extra: Partial<typeof schema.printers.$inferInsert> = {}) {
  const lastTest = { ok: true, formats: ["image/pwg-raster"], driverlessFormats: ["image/pwg-raster"], ippVersions: ["1.1", "2.0"], model: "Sim", uuid: null, features: [], color: false, duplex: true, problems: [] };
  const [p] = await d.insert(schema.printers).values({ name, host: "127.0.0.1", port, lastTest, lastTestAt: new Date(), ...extra }).returning();
  return p;
}

async function addAgent(name: string, guid: string, applied: string[], version = "0.8.0") {
  const [a] = await d
    .insert(schema.agents)
    .values({ objectGuid: guid, dn: `CN=${name},OU=PCs,DC=example,DC=org`, computerName: name, tokenHash: `hash-${guid}`, lastReportAt: new Date(), lastReport: { agentVersion: version, applied } })
    .returning();
  return a;
}

async function auditActions() {
  return (await d.select().from(schema.auditLog)).sort((a, b) => a.id - b.id).map((r) => r.action);
}

describe("test print lifecycle", () => {
  const sim = { ...SIMS[1], port: 0, jobMs: 50 };
  const old = { ...SIMS[4], port: 0, ippVersions: ["1.0", "1.1"] };
  let server: ReturnType<typeof startSim>;
  let oldServer: ReturnType<typeof startSim>;
  let port = 0;

  beforeAll(async () => {
    d = drizzle(new PGlite(), { schema });
    await migrate(d, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
    pg.db = d;
    server = startSim(sim);
    oldServer = startSim(old);
    await Promise.all([new Promise((r) => server.once("listening", r)), new Promise((r) => oldServer.once("listening", r))]);
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
    oldServer.close();
  });
  beforeEach(async () => {
    await d.delete(schema.auditLog);
    await d.delete(schema.testPrints);
    await d.delete(schema.agents);
    await d.delete(schema.printers);
    sim.jobs = [];
  });

  it("direct: sends a PWG raster page with IPP Print-Job and follows the job to completed", async () => {
    const p = await addPrinter("Sim Laser", port);
    let row = await sendDirectTestPrint(p, "admin@example.org", "auto");
    expect(row.state).toBe("sent");
    expect(row.jobId).toBe(1);
    expect(row.format).toBe("PWG raster sgray_8 300 dpi");
    expect(sim.jobs).toHaveLength(1);
    const job = sim.jobs![0];
    expect(job.format).toBe("image/pwg-raster");
    expect(job.name).toBe("Spoolfree test page");
    expect(job.attributes.sides).toEqual(["one-sided"]);
    expect(job.attributes["print-color-mode"]).toEqual(["monochrome"]);
    expect(job.document.subarray(0, 4).toString()).toBe("RaS2");

    await new Promise((r) => setTimeout(r, 80));
    row = await refreshDirectTestPrint(row, p, getJobAttributes);
    expect(row.state).toBe("printed");
    expect(row.jobStatus).toBe("completed (job-completed-successfully)");
    expect(row.events.map((e) => e.state)).toEqual(["queued", "sent", "printed"]);
    expect(await auditActions()).toEqual(["printer.test_print", "printer.test_print_result"]);
  });

  it("direct: a printer that forgot the job counts as printed; a refused job fails", async () => {
    const p = await addPrinter("Sim Laser", port);
    const row = await sendDirectTestPrint(p, "admin@example.org", "auto");
    sim.jobs = [];
    expect((await refreshDirectTestPrint(row, p, getJobAttributes)).state).toBe("printed");

    const q = await addPrinter("Old", (oldServer.address() as AddressInfo).port, { name: "Old" });
    // The last Test said 2.0, the device now refuses: the job fails, nothing is retried.
    const failed = await sendDirectTestPrint(q, "admin@example.org", "auto", { getPrinterAttributes, printJob });
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/IPP status 0x0501/);
  });

  it("direct: refused for IPP 1.x printers before anything is sent", async () => {
    const p = await addPrinter("Old", port, { lastTest: { ok: true, formats: [], driverlessFormats: [], ippVersions: ["1.1"], model: null, uuid: null, features: [], color: false, duplex: false, problems: [] } });
    await expect(sendDirectTestPrint(p, "admin@example.org", "vendor")).rejects.toThrow(/IPP 1\.x only/);
    expect(sim.jobs).toHaveLength(0);
    expect(await d.select().from(schema.testPrints)).toHaveLength(0);
  });

  it("rate limits test prints per printer across both modes", async () => {
    const { queuePcTestPrint } = await import("@/lib/test-print/service");
    const p = await addPrinter("Sim Laser", port);
    const a = await addAgent("PC-01", GUID, ["Sim Laser"]);
    await sendDirectTestPrint(p, "admin@example.org", "auto");
    await expect(queuePcTestPrint(p, a, "admin@example.org")).rejects.toThrow(/Try again in \d+ s/);
    // Another printer is not affected; a minute later the same printer is fine.
    const p2 = await addPrinter("Other", port, { name: "Other" });
    await expect(sendDirectTestPrint(p2, "admin@example.org", "auto")).resolves.toMatchObject({ state: "sent" });
    await expect(queuePcTestPrint(p, a, "admin@example.org", new Date(Date.now() + 61_000))).resolves.toMatchObject({ state: "queued" });
  });

  it("pc: only PCs that reported the queue, with agent 0.8+, can be asked", async () => {
    const { pcTargetsFor, queuePcTestPrint } = await import("@/lib/test-print/service");
    const p = await addPrinter("Sim Laser", port);
    const a = await addAgent("PC-01", GUID, ["sim laser"]);
    const old = await addAgent("PC-OLD", "22222222-2222-3333-4444-555555555555", ["Sim Laser"], "0.7.6");
    const other = await addAgent("PC-02", "33333333-2222-3333-4444-555555555555", ["Other"]);
    const targets = pcTargetsFor("Sim Laser", [a, old, other]);
    expect(targets.map((t) => [t.computerName, t.supported])).toEqual(
      expect.arrayContaining([
        ["PC-01", true],
        ["PC-OLD", false],
      ]),
    );
    expect(targets).toHaveLength(2);
    await expect(queuePcTestPrint(p, old, "admin@example.org")).rejects.toThrow(/need 0\.8\.0 or later/);
    await expect(queuePcTestPrint(p, other, "admin@example.org")).rejects.toThrow(/has not reported a queue/);
    await expect(queuePcTestPrint(p, a, "admin@example.org")).resolves.toMatchObject({ state: "queued", computerName: "PC-01" });
  });

  it("pc: queued -> delivered (signed, in the poll and the manifest) -> sent -> printed, audit-logged", async () => {
    const svc = await import("@/lib/test-print/service");
    const p = await addPrinter("Sim Laser", port);
    const a = await addAgent("PC-01", GUID, ["Sim Laser"]);
    const other = await addAgent("PC-02", "33333333-2222-3333-4444-555555555555", ["Sim Laser"]);
    const row = await svc.queuePcTestPrint(p, a, "admin@example.org");
    expect(await svc.pendingCommandRows(other.id)).toHaveLength(0);

    const pending = await svc.pendingCommandRows(a.id);
    const [cmd] = await svc.deliverCommands(a, pending, key);
    const payload = verifyCommand(cmd, pub, GUID.toUpperCase());
    expect(payload).toMatchObject({ kind: "spoolfree-command", id: row.id, type: "test-print", printer: { id: p.id, name: "Sim Laser" }, computer: { objectGuid: GUID } });
    expect(new Date(payload.expiresAt).getTime() - new Date(payload.issuedAt).getTime()).toBe(30 * 60_000);
    expect((await svc.getTestPrint(row.id))!.state).toBe("delivered");
    // Still offered until the agent reports (the agent runs each id once), e.g. in the next manifest.
    const again = await svc.deliverCommands(a, await svc.pendingCommandRows(a.id), key);
    expect(again).toHaveLength(1);
    const manifest = buildManifest({ resolution: { printers: [], defaultPrinterId: null } as never, printers: new Map(), computer: { objectGuid: GUID, dn: "x", name: "PC-01" }, now: new Date(), ttlHours: 1, commands: again, commandPollMinutes: 1 });
    expect(manifest.commands).toHaveLength(1);
    expect(manifest.commandPollMinutes).toBe(1);

    await expect(svc.recordAgentResult(other, row.id, { state: "printed" })).rejects.toThrow(/unknown command/);
    await svc.recordAgentResult(a, row.id, { state: "sent", jobId: 7, jobStatus: "Spooling" });
    const done = await svc.recordAgentResult(a, row.id, { state: "printed", jobId: 7, jobStatus: "Printed" });
    expect(done.state).toBe("printed");
    expect(done.events.map((e) => e.state)).toEqual(["queued", "delivered", "sent", "printed"]);
    // Single use: no longer offered, and a late result cannot change it.
    expect(await svc.pendingCommandRows(a.id)).toHaveLength(0);
    expect((await svc.recordAgentResult(a, row.id, { state: "failed", message: "late" })).state).toBe("printed");
    const audits = await d.select().from(schema.auditLog);
    expect(audits.map((r) => r.action).sort()).toEqual(["printer.test_print", "printer.test_print_result"]);
    expect(audits.find((r) => r.action === "printer.test_print")).toMatchObject({ actor: "admin@example.org", details: expect.objectContaining({ mode: "pc", computer: "PC-01", queue: "Sim Laser" }) });
    expect(audits.find((r) => r.action === "printer.test_print_result")).toMatchObject({ actor: "agent:PC-01", details: expect.objectContaining({ state: "printed", jobId: 7 }) });
  });

  it("pc: commands expire unless run in time; a rejected command records why", async () => {
    const svc = await import("@/lib/test-print/service");
    const p = await addPrinter("Sim Laser", port);
    const a = await addAgent("PC-01", GUID, ["Sim Laser"]);
    const row = await svc.queuePcTestPrint(p, a, "admin@example.org", new Date(Date.now() - 31 * 60_000));
    expect(await svc.pendingCommandRows(a.id)).toHaveLength(0);
    expect(await svc.expireTestPrints()).toBe(1);
    expect((await svc.getTestPrint(row.id))!.state).toBe("expired");

    const r2 = await svc.queuePcTestPrint(p, a, "admin@example.org");
    const rej = await svc.recordAgentResult(a, r2.id, { state: "rejected", message: "queue 'Sim Laser' is not managed by Spoolfree on this PC" });
    expect(rej).toMatchObject({ state: "rejected", error: "queue 'Sim Laser' is not managed by Spoolfree on this PC" });
  });
});

describe("command signatures", () => {
  const payload = {
    kind: "spoolfree-command" as const,
    v: 1 as const,
    id: "6f1c1d1e-0000-4000-8000-000000000001",
    type: "test-print" as const,
    computer: { objectGuid: GUID, name: "PC-01" },
    printer: { id: "6f1c1d1e-0000-4000-8000-000000000002", name: "Copier" },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it("verifies, and refuses tampering, other computers, expiry and other keys", () => {
    const s = signCommand(payload, key);
    expect(verifyCommand(s, pub, GUID).id).toBe(payload.id);
    const tampered: SignedCommand = { ...s, payload: Buffer.from(JSON.stringify({ ...payload, printer: { ...payload.printer, name: "Other" } })).toString("base64") };
    expect(() => verifyCommand(tampered, pub, GUID)).toThrow(/signature/);
    expect(() => verifyCommand(s, pub, "99999999-2222-3333-4444-555555555555")).toThrow(/different computer/);
    expect(() => verifyCommand(s, pub, GUID, new Date(Date.now() + 120_000))).toThrow(/expired/);
    const other = privateKeyFromSeed(generateSeed().seed);
    expect(() => verifyCommand(s, publicKeyRaw(other), GUID)).toThrow(/signature/);
  });

  it("is domain-separated from manifests: neither signature verifies as the other", () => {
    const manifest = signManifest(buildManifest({ resolution: { printers: [], defaultPrinterId: null } as never, printers: new Map(), computer: { objectGuid: GUID, dn: "x", name: "PC-01" }, now: new Date(), ttlHours: 1 }), key);
    expect(() => verifyCommand(manifest as unknown as SignedCommand, pub, GUID)).toThrow(/signature/);
    const s = signCommand(payload, key);
    expect(commandSigningBytes(Buffer.from("{}")).toString()).toBe("spoolfree-command-v1\n{}");
    // The command's signature does not cover its bare payload (what a manifest signature covers).
    expect(verifyBytes(pub, Buffer.from(s.payload, "base64"), Buffer.from(s.signature, "base64"))).toBe(false);
  });

  it("moves states forward only", () => {
    expect(canTransition("queued", "delivered", false)).toBe(true);
    expect(canTransition("sent", "delivered", true)).toBe(false);
    expect(canTransition("printed", "failed", true)).toBe(false);
    expect(canTransition("expired", "printed", true)).toBe(true);
    expect(canTransition("expired", "printed", false)).toBe(false);
    expect(versionAtLeast("0.10.0", "0.8.0")).toBe(true);
    expect(versionAtLeast("0.7.9", "0.8.0")).toBe(false);
    expect(versionAtLeast(null, "0.8.0")).toBe(false);
  });
});

