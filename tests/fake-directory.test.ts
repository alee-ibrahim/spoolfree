import { describe, expect, it } from "vitest";
import { FakeDirectory, fakeDirectoryFromJson } from "@/lib/directory/fake";
import { ancestorChain } from "@/lib/dn";

const BASE = "DC=corp,DC=example,DC=net";
const PC_DN = `CN=LAB-PC1,OU=Lab,OU=Dept,${BASE}`;
const GUID = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";

describe("DEV_FAKE_AD_FILE directory", () => {
  const dir = fakeDirectoryFromJson({
    baseDn: BASE,
    ous: [{ dn: `OU=Dept,${BASE}` }, { dn: `OU=Lab,OU=Dept,${BASE}`, description: "test lab" }],
    computers: [
      { dn: PC_DN, objectGuid: GUID },
      { dn: `CN=OLD-PC,OU=Lab,OU=Dept,${BASE}`, disabled: true },
    ],
  });

  it("uses the file's base DN and containers", async () => {
    expect(dir.baseDn).toBe(BASE);
    const containers = await dir.listContainers();
    expect(containers[0]).toMatchObject({ dn: BASE, kind: "domain" });
    expect(containers.map((c) => c.dn)).toContain(`OU=Lab,OU=Dept,${BASE}`);
    expect(await dir.defaultComputersContainer()).toBe(`CN=Computers,${BASE}`);
  });

  it("keeps the real DN and objectGUID so the PC can enroll", async () => {
    const pc = await dir.findComputerByGuid(GUID.toLowerCase());
    expect(pc).toMatchObject({ dn: PC_DN, name: "LAB-PC1", objectGuid: GUID.toLowerCase(), disabled: false });
    expect(pc?.dnsHostName).toBe("lab-pc1.corp.example.net");
    expect(ancestorChain(PC_DN, dir.baseDn)).toContain(`OU=Lab,OU=Dept,${BASE}`);
  });

  it("honours disabled computers and derives a GUID when none is given", async () => {
    const all = await dir.listComputers();
    const old = all.find((c) => c.name === "OLD-PC");
    expect(old?.disabled).toBe(true);
    expect(old?.objectGuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects malformed files", () => {
    expect(() => fakeDirectoryFromJson({ baseDn: BASE, computers: [{ dn: "OU=x", objectGuid: GUID }] })).toThrow();
    expect(() => fakeDirectoryFromJson({ baseDn: BASE, computers: [{ dn: PC_DN, objectGuid: "nope" }] })).toThrow();
  });

  it("leaves the built-in sample directory unchanged", async () => {
    const sample = new FakeDirectory();
    expect(sample.baseDn).toBe("DC=example,DC=org");
    expect((await sample.listComputers()).find((c) => c.name === "OLD-LAPTOP")?.disabled).toBe(true);
  });
});
