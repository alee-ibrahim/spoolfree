import { readFileSync } from "node:fs";
import { Client, type Entry } from "ldapts";
import { config } from "../config";
import { dnEquals, rdnValue } from "../dn";
import { guidFilterValue, guidFromBuffer } from "./guid";
import type { ComputerObject, Directory, OuNode } from "./types";

const UAC_ACCOUNTDISABLE = 0x2;

function str(v: Entry[string] | undefined): string | null {
  if (v === undefined) return null;
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined) return null;
  return Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
}

export function entryToComputer(e: Entry): ComputerObject | null {
  const raw = Array.isArray(e.objectGUID) ? e.objectGUID[0] : e.objectGUID;
  if (!Buffer.isBuffer(raw) || raw.length !== 16) return null;
  const uac = Number(str(e.userAccountControl) ?? "0");
  const sam = str(e.sAMAccountName);
  return {
    dn: e.dn,
    name: (str(e.cn) ?? sam?.replace(/\$$/, "") ?? rdnValue(e.dn)).toUpperCase(),
    objectGuid: guidFromBuffer(raw),
    dnsHostName: str(e.dNSHostName),
    operatingSystem: str(e.operatingSystem),
    disabled: (uac & UAC_ACCOUNTDISABLE) !== 0,
  };
}

const COMPUTER_ATTRS = ["cn", "sAMAccountName", "objectGUID", "dNSHostName", "operatingSystem", "userAccountControl"];

/**
 * Read-only LDAP(S) directory. Uses a simple bind with a low-privilege
 * service account; never writes. Results are cached for LDAP_CACHE_SECONDS.
 */
export class LdapDirectory implements Directory {
  private cache = new Map<string, { at: number; value: unknown }>();

  private client(): Client {
    const c = config();
    const ca = c.LDAP_CA_CERT_FILE ? [readFileSync(c.LDAP_CA_CERT_FILE)] : undefined;
    return new Client({
      url: c.LDAP_URL,
      timeout: 10_000,
      connectTimeout: 10_000,
      tlsOptions: c.LDAP_URL.startsWith("ldaps:")
        ? { ca, rejectUnauthorized: c.LDAP_TLS_REJECT_UNAUTHORIZED, minVersion: "TLSv1.2" }
        : undefined,
    });
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const c = config();
    const client = this.client();
    try {
      await client.bind(c.LDAP_BIND_DN, c.LDAP_BIND_PASSWORD);
      return await fn(client);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const ttl = config().LDAP_CACHE_SECONDS * 1000;
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async listContainers(): Promise<OuNode[]> {
    return this.cached("containers", () =>
      this.withClient(async (client) => {
        const base = config().LDAP_BASE_DN;
        const { searchEntries } = await client.search(base, {
          scope: "sub",
          filter: "(objectClass=organizationalUnit)",
          attributes: ["ou", "description"],
          paged: { pageSize: 500 },
        });
        const nodes: OuNode[] = [{ dn: base, name: rdnValue(base), kind: "domain" }];
        for (const e of searchEntries) {
          nodes.push({ dn: e.dn, name: str(e.ou) ?? rdnValue(e.dn), kind: "ou", description: str(e.description) });
        }
        const def = await this.defaultComputersContainerWith(client);
        if (!nodes.some((n) => dnEquals(n.dn, def))) nodes.push({ dn: def, name: rdnValue(def), kind: "container" });
        return nodes;
      }),
    );
  }

  async listComputers(): Promise<ComputerObject[]> {
    return this.cached("computers", () =>
      this.withClient(async (client) => {
        const { searchEntries } = await client.search(config().LDAP_BASE_DN, {
          scope: "sub",
          filter: "(objectCategory=computer)",
          attributes: COMPUTER_ATTRS,
          explicitBufferAttributes: ["objectGUID"],
          paged: { pageSize: 500 },
        });
        return searchEntries.map(entryToComputer).filter((c): c is ComputerObject => c !== null);
      }),
    );
  }

  /** Not cached: used to authenticate agents, so it must reflect disables/moves promptly. */
  async findComputerByGuid(guid: string): Promise<ComputerObject | null> {
    return this.withClient(async (client) => {
      const { searchEntries } = await client.search(config().LDAP_BASE_DN, {
        scope: "sub",
        filter: `(&(objectCategory=computer)(objectGUID=${guidFilterValue(guid)}))`,
        attributes: COMPUTER_ATTRS,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return null;
      return entryToComputer(searchEntries[0]);
    });
  }

  private async defaultComputersContainerWith(client: Client): Promise<string> {
    const base = config().LDAP_BASE_DN;
    // GUID_COMPUTRS_CONTAINER_W from wellKnownObjects; honours `redircmp`.
    const { searchEntries } = await client.search(base, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: ["wellKnownObjects"],
    });
    const wko = searchEntries[0]?.wellKnownObjects;
    const values = (Array.isArray(wko) ? wko : wko ? [wko] : []).map(String);
    const hit = values.find((v) => v.toUpperCase().includes("AA312825768811D1ADED00C04FD8D5CD"));
    if (hit) return hit.slice(hit.lastIndexOf(":") + 1);
    return `CN=Computers,${base}`;
  }

  async defaultComputersContainer(): Promise<string> {
    return this.cached("defaultContainer", () => this.withClient((c) => this.defaultComputersContainerWith(c)));
  }
}
