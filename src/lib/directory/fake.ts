import { createHash } from "node:crypto";
import { parentDn, rdnValue } from "../dn";
import type { ComputerObject, Directory, OuNode } from "./types";

/**
 * In-memory directory for development (DEV_FAKE_AD=1) and tests.
 * Models a small school/office domain: example.org.
 */
export const FAKE_BASE_DN = "DC=example,DC=org";

const OUS: [string, string | null][] = [
  ["OU=Workstations,DC=example,DC=org", "All managed PCs"],
  ["OU=Administration,OU=Workstations,DC=example,DC=org", "Front office"],
  ["OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org", null],
  ["OU=HR,OU=Administration,OU=Workstations,DC=example,DC=org", null],
  ["OU=Teaching,OU=Workstations,DC=example,DC=org", "Staff room and classrooms"],
  ["OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org", null],
  ["OU=Library,OU=Workstations,DC=example,DC=org", null],
  ["OU=Kiosks,OU=Library,OU=Workstations,DC=example,DC=org", "Public catalogue PCs"],
  ["OU=Servers,DC=example,DC=org", "No printers"],
];

const COMPUTERS: [string, string, string?][] = [
  ["ADM-01", "OU=Administration,OU=Workstations,DC=example,DC=org"],
  ["ADM-02", "OU=Administration,OU=Workstations,DC=example,DC=org"],
  ["FIN-01", "OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org"],
  ["FIN-02", "OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org"],
  ["HR-01", "OU=HR,OU=Administration,OU=Workstations,DC=example,DC=org"],
  ["TCH-01", "OU=Teaching,OU=Workstations,DC=example,DC=org"],
  ["TCH-02", "OU=Teaching,OU=Workstations,DC=example,DC=org"],
  ["TCH-03", "OU=Teaching,OU=Workstations,DC=example,DC=org"],
  ["LAB-01", "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org"],
  ["LAB-02", "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org"],
  ["LIB-01", "OU=Library,OU=Workstations,DC=example,DC=org"],
  ["KIOSK-01", "OU=Kiosks,OU=Library,OU=Workstations,DC=example,DC=org"],
  ["KIOSK-02", "OU=Kiosks,OU=Library,OU=Workstations,DC=example,DC=org"],
  ["SRV-FS01", "OU=Servers,DC=example,DC=org", "Windows Server 2022 Standard"],
  ["NEW-PC-17", "CN=Computers,DC=example,DC=org"],
  ["NEW-PC-18", "CN=Computers,DC=example,DC=org"],
  ["OLD-LAPTOP", "CN=Computers,DC=example,DC=org", "Windows 10 Pro"],
];

/** Deterministic GUID so dev data survives restarts. */
export function fakeGuid(name: string): string {
  const h = createHash("sha256").update(`spoolfree-dev:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class FakeDirectory implements Directory {
  constructor(
    private ous: [string, string | null][] = OUS,
    private computers: [string, string, string?][] = COMPUTERS,
    private baseDn = FAKE_BASE_DN,
  ) {}

  async listContainers(): Promise<OuNode[]> {
    return [
      { dn: this.baseDn, name: rdnValue(this.baseDn), kind: "domain" },
      ...this.ous.map(([dn, description]) => ({ dn, name: rdnValue(dn), kind: "ou" as const, description })),
      { dn: `CN=Computers,${this.baseDn}`, name: "Computers", kind: "container" },
    ];
  }

  async listComputers(): Promise<ComputerObject[]> {
    return this.computers.map(([name, ou, os]) => ({
      dn: `CN=${name},${ou}`,
      name,
      objectGuid: fakeGuid(name),
      dnsHostName: `${name.toLowerCase()}.example.org`,
      operatingSystem: os ?? "Windows 11 Enterprise",
      disabled: name === "OLD-LAPTOP",
    }));
  }

  async findComputerByGuid(guid: string): Promise<ComputerObject | null> {
    return (await this.listComputers()).find((c) => c.objectGuid === guid.toLowerCase()) ?? null;
  }

  async defaultComputersContainer(): Promise<string> {
    return `CN=Computers,${this.baseDn}`;
  }
}

export function parentOf(dn: string): string {
  return parentDn(dn) ?? dn;
}
