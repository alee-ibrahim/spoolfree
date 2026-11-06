import type snmp from "net-snmp";
import { describe, expect, it } from "vitest";
import { OID, snmpStatus } from "@/lib/status/snmp";

/** A session that answers GETs and fails every table walk with a timeout (as some Brother devices do). */
function fakeSession(walkFails: boolean): snmp.Session {
  const values: Record<string, unknown> = {
    [OID.hrDeviceDescr]: Buffer.from("Brother DCP-L3551CDW series"),
    [OID.hrPrinterStatus]: 3,
    [OID.hrPrinterDetectedErrorState]: Buffer.from([0]),
    [OID.prtMarkerLifeCount]: 4979,
  };
  return {
    get: (oids: string[], cb: (err: Error | null, vbs: snmp.Varbind[]) => void) =>
      cb(
        null,
        oids.map((oid) => ({ oid, type: 2, value: values[oid] }) as unknown as snmp.Varbind),
      ),
    subtree: (oid: string, feed: (vbs: snmp.Varbind[]) => void, done: (err?: Error) => void) => {
      if (walkFails) return done(new Error("Request timed out"));
      if (oid === OID.suppliesDescription) feed([{ oid: `${oid}.1.1`, type: 4, value: Buffer.from("Black Toner") } as unknown as snmp.Varbind]);
      if (oid === OID.suppliesMaxCapacity) feed([{ oid: `${oid}.1.1`, type: 2, value: 100 } as unknown as snmp.Varbind]);
      if (oid === OID.suppliesLevel) feed([{ oid: `${oid}.1.1`, type: 2, value: 40 } as unknown as snmp.Varbind]);
      done();
    },
    close: () => undefined,
  } as unknown as snmp.Session;
}

describe("SNMP status", () => {
  it("keeps the page counter when the supplies walk times out", async () => {
    const s = await snmpStatus("192.0.2.13", "public", 1000, 15, () => fakeSession(true));
    expect(s).toMatchObject({ online: true, pageCount: 4979, markers: [], source: "snmp" });
  });

  it("reads supplies when the walk works", async () => {
    const s = await snmpStatus("192.0.2.13", "public", 1000, 15, () => fakeSession(false));
    expect(s.pageCount).toBe(4979);
    expect(s.markers).toHaveLength(1);
    expect(s.markers[0]).toMatchObject({ name: "Black Toner", level: 40 });
  });
});
