import { describe, expect, it } from "vitest";
import { adminFromClaims } from "@/lib/admin-claims";
import { generateSeed, keyId, privateKeyFromSeed, publicKeyRaw, verifyBytes } from "@/lib/crypto/signing";
import { buildManifest, httpUrlFor, signManifest, type ManifestPrinterInput } from "@/lib/manifest";
import { renderMetrics } from "@/lib/metrics";
import { resolvePrinters } from "@/lib/resolve";
import { errorStateToReasons, suppliesToMarkers } from "@/lib/status/snmp";

const OU = "OU=Staff,DC=example,DC=org";
const printers = new Map<string, ManifestPrinterInput>([
  ["p1", { id: "p1", name: "Staff Copier", host: "192.0.2.10", port: 631, ippPath: "/ipp/print", useTls: false, model: "Acme", location: "Room 1", revision: 3 }],
  ["p2", { id: "p2", name: "Secure Printer", host: "printer2.example.org", port: 443, ippPath: "/ipp/print", useTls: true, model: null, location: null, revision: 1 }],
]);
const computer = { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", dn: `CN=PC1,${OU}`, name: "PC1" };

function manifest() {
  const resolution = resolvePrinters(
    {
      baseDn: "DC=example,DC=org",
      assignments: [{ ouDn: OU, printerId: "p1" }, { ouDn: OU, printerId: "p2" }, { ouDn: OU, printerId: "deleted" }],
      ouSettings: [{ ouDn: OU, blockInheritance: false, blockedPrinterIds: [], defaultPrinterId: "p2" }],
      overrides: [],
    },
    computer,
  );
  return buildManifest({ resolution, printers, computer, now: new Date("2026-11-05T00:00:00Z"), ttlHours: 24, serial: "s1" });
}

describe("manifest", () => {
  it("builds printer entries with IPP and HTTP URLs, default and expiry", () => {
    const m = manifest();
    expect(m.printers.map((p) => p.name)).toEqual(["Staff Copier", "Secure Printer"]);
    expect(m.printers[0]).toMatchObject({ ippUri: "ipp://192.0.2.10:631/ipp/print", ippUrl: "http://192.0.2.10:631/ipp/print", revision: 3, isDefault: false });
    expect(m.printers[1].ippUrl).toBe("https://printer2.example.org:443/ipp/print");
    expect(m.defaultPrinter).toBe("Secure Printer");
    expect(m.expiresAt).toBe("2026-11-06T00:00:00.000Z");
    expect(m.computer.objectGuid).toBe(computer.objectGuid);
  });

  it("signs the exact payload bytes with Ed25519", () => {
    const { seed, publicKey } = generateSeed();
    const key = privateKeyFromSeed(seed);
    expect(publicKeyRaw(key).toString("base64")).toBe(publicKey);
    const signed = signManifest(manifest(), key);
    const bytes = Buffer.from(signed.payload, "base64");
    const pub = Buffer.from(publicKey, "base64");
    expect(signed.keyId).toBe(keyId(pub));
    expect(verifyBytes(pub, bytes, Buffer.from(signed.signature, "base64"))).toBe(true);
    expect(JSON.parse(bytes.toString("utf8")).serial).toBe("s1");

    const tampered = Buffer.from(bytes.toString("utf8").replace("192.0.2.10", "192.0.2.66"));
    expect(verifyBytes(pub, tampered, Buffer.from(signed.signature, "base64"))).toBe(false);
    const other = Buffer.from(generateSeed().publicKey, "base64");
    expect(verifyBytes(other, bytes, Buffer.from(signed.signature, "base64"))).toBe(false);
  });

  it("matches the RFC 8032 test vector 1 public key", () => {
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64");
    expect(publicKeyRaw(privateKeyFromSeed(seed)).toString("hex")).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  });

  it("rejects malformed seeds", () => {
    expect(() => privateKeyFromSeed("c2hvcnQ=")).toThrow(/32-byte/);
  });

  it("http URL keeps custom ports", () => {
    expect(httpUrlFor({ host: "192.0.2.9", port: 8631, ippPath: "/ipp/print", useTls: false })).toBe("http://192.0.2.9:8631/ipp/print");
  });
});

describe("admin claim check", () => {
  const admins = ["11111111-1111-1111-1111-111111111111"];
  it("grants access to members of the admin group (case-insensitive)", () => {
    expect(adminFromClaims({ groups: ["11111111-1111-1111-1111-111111111111".toUpperCase()] }, admins).isAdmin).toBe(true);
  });
  it("denies others and explains group overage", () => {
    expect(adminFromClaims({ groups: ["22222222-2222-2222-2222-222222222222"] }, admins)).toMatchObject({ isAdmin: false });
    expect(adminFromClaims({ _claim_names: { groups: "src1" } }, admins).error).toMatch(/overage/);
    expect(adminFromClaims({ groups: admins }, []).isAdmin).toBe(false);
  });
});

describe("SNMP Printer-MIB mapping", () => {
  it("decodes hrPrinterDetectedErrorState bits", () => {
    // bit 5 (jammed) and bit 2 (low toner) in byte 0; bit 8 (input tray missing) in byte 1
    expect(errorStateToReasons(Buffer.from([0b00100100, 0b10000000])).sort()).toEqual(["input-tray-missing", "media-jam", "toner-low"]);
    expect(errorStateToReasons(Buffer.alloc(0))).toEqual([]);
  });
  it("converts supply rows to percentages", () => {
    const m = suppliesToMarkers(
      [
        { description: "Black Toner Cartridge\0", max: 2000, level: 200 },
        { description: "Waste Toner Box", max: -2, level: -3 },
      ],
      15,
    );
    expect(m[0]).toMatchObject({ name: "Black Toner Cartridge", level: 10, low: true, color: "black" });
    expect(m[1]).toMatchObject({ level: null, low: false });
  });
});

describe("metrics", () => {
  it("renders Prometheus text with escaped labels", () => {
    const text = renderMetrics({
      printers: [
        {
          name: 'Lab "A"',
          host: "192.0.2.1",
          location: null,
          online: true,
          markers: [{ name: "Black", type: null, color: "#000000", level: 40, low: false }],
          pageCount: 10,
          lastSeen: new Date(1_700_000_000_000),
        },
      ],
      agents: { total: 3, stale: 1, withErrors: 0 },
    });
    expect(text).toContain('spoolfree_printer_up{printer="Lab \\"A\\"",host="192.0.2.1",location=""} 1');
    expect(text).toContain('spoolfree_printer_marker_level_percent{printer="Lab \\"A\\"",marker="Black",color="#000000"} 40');
    expect(text).toContain("spoolfree_printer_last_seen_timestamp_seconds");
    expect(text).toContain('spoolfree_agents{state="stale"} 1');
  });
});
