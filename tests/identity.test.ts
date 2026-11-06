import { describe, expect, it } from "vitest";
import { buildManifest, type ManifestPrinterInput } from "@/lib/manifest";
import { macFromPrinterUuid, mergeIdentity, normalizeMac, normalizeUuid } from "@/lib/identity";
import { resolvePrinters } from "@/lib/resolve";

const BROTHER_UUID = "urn:uuid:e3248000-80ce-11db-8000-0011223344aa";

describe("printer identity", () => {
  it("normalizes UUIDs", () => {
    expect(normalizeUuid(BROTHER_UUID)).toBe("e3248000-80ce-11db-8000-0011223344aa");
    expect(normalizeUuid("{E3248000-80CE-11DB-8000-0011223344AA}")).toBe("e3248000-80ce-11db-8000-0011223344aa");
    expect(normalizeUuid("not-a-uuid")).toBeNull();
    expect(normalizeUuid("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(normalizeUuid(null)).toBeNull();
  });

  it("normalizes MACs and rejects zero, broadcast and multicast", () => {
    expect(normalizeMac("00:11:22:33:44:AA")).toBe("0011223344aa");
    expect(normalizeMac("00-11-22-33-44-aa")).toBe("0011223344aa");
    expect(normalizeMac(Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0xaa]))).toBe("0011223344aa");
    expect(normalizeMac(Buffer.alloc(6))).toBeNull();
    expect(normalizeMac(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBeNull();
    expect(normalizeMac("01:00:5e:00:00:01")).toBeNull();
    expect(normalizeMac(Buffer.alloc(0))).toBeNull();
    expect(normalizeMac("0011223344")).toBeNull();
    expect(normalizeMac("00:11:22:33:44:aa:bb")).toBeNull();
  });

  it("takes the MAC from a Brother version-1 printer-uuid only", () => {
    expect(macFromPrinterUuid(BROTHER_UUID, "Brother DCP-L3551CDW series")).toBe("0011223344aa");
    expect(macFromPrinterUuid(BROTHER_UUID, "HP LaserJet")).toBeNull();
    expect(macFromPrinterUuid(BROTHER_UUID, null)).toBeNull();
    // version 4 (random) UUIDs have no MAC
    expect(macFromPrinterUuid("e3248000-80ce-41db-8000-0011223344aa", "Brother HL")).toBeNull();
    // node with the multicast bit (random node) is not a MAC
    expect(macFromPrinterUuid("e3248000-80ce-11db-8000-0111223344aa", "Brother HL")).toBeNull();
  });

  it("merges lookups without losing values on failure", () => {
    const prev = { deviceUuid: "e3248000-80ce-11db-8000-0011223344aa", macAddresses: ["0011223344ab"] };
    // all lookups failed: unchanged
    expect(mergeIdentity(prev, { uuid: null, snmpMacs: null })).toEqual(prev);
    // SNMP read replaces the MACs; the Brother uuid adds its node
    expect(mergeIdentity(prev, { uuid: BROTHER_UUID, model: "Brother X", snmpMacs: [Buffer.from("0011223344ac", "hex"), Buffer.alloc(6)] })).toEqual({
      deviceUuid: "e3248000-80ce-11db-8000-0011223344aa",
      macAddresses: ["0011223344aa", "0011223344ac"],
    });
    // SNMP failed, same device: keep stored MACs
    expect(mergeIdentity(prev, { uuid: BROTHER_UUID, model: "HP", snmpMacs: null }).macAddresses).toEqual(["0011223344ab"]);
    // another device answers now: stored MACs dropped
    expect(mergeIdentity(prev, { uuid: "6d1e5c2a-0000-4000-8000-000000000001", model: "HP", snmpMacs: null })).toEqual({
      deviceUuid: "6d1e5c2a-0000-4000-8000-000000000001",
      macAddresses: [],
    });
  });
});

describe("manifest identity fields", () => {
  const OU = "OU=Staff,DC=example,DC=org";
  const computer = { objectGuid: "0f8fad5b-d9cb-469f-a165-70867728950e", dn: `CN=PC1,${OU}`, name: "PC1" };
  const base = { port: 631, ippPath: "/ipp/print", useTls: false, model: null, location: null, revision: 1 };
  const printers = new Map<string, ManifestPrinterInput>([
    ["p1", { ...base, id: "p1", name: "A", host: "192.0.2.10", deviceUuid: "URN:UUID:E3248000-80CE-11DB-8000-0011223344AA", macAddresses: ["00:11:22:33:44:AA", "bogus", "0011223344aa"] }],
    ["p2", { ...base, id: "p2", name: "B", host: "192.0.2.11" }],
    ["p0", { ...base, id: "p0", name: "Not assigned here", host: "192.0.2.12" }],
  ]);
  const resolution = resolvePrinters(
    { baseDn: "DC=example,DC=org", assignments: [{ ouDn: OU, printerId: "p1" }, { ouDn: OU, printerId: "p2" }], ouSettings: [], overrides: [] },
    computer,
  );
  const m = buildManifest({ resolution, printers, computer, now: new Date("2026-11-05T00:00:00Z"), ttlHours: 24, serial: "s" });

  it("carries the normalized printer-uuid and MACs", () => {
    expect(m.printers[0]).toMatchObject({ deviceUuid: "e3248000-80ce-11db-8000-0011223344aa", macAddresses: ["0011223344aa"] });
    expect(m.printers[1]).toMatchObject({ deviceUuid: null, macAddresses: [] });
  });

  it("lists every printer id on the server, assigned or not", () => {
    expect(m.serverPrinterIds).toEqual(["p0", "p1", "p2"]);
  });
});
