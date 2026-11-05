import { beforeEach, describe, expect, it, vi } from "vitest";
import { guidFilterValue, guidFromBuffer, guidToBuffer, isGuid, normalizeGuid } from "@/lib/directory/guid";
import { FakeDirectory, fakeGuid } from "@/lib/directory/fake";
import { buildOuTree, flattenTree } from "@/lib/ou-tree";

// --- Mock ldapts: record searches and return canned entries -----------------
const calls: { method: string; args: unknown[] }[] = [];
let entries: Record<string, unknown>[] = [];

vi.mock("ldapts", () => {
  class Client {
    constructor(public opts: unknown) {
      calls.push({ method: "ctor", args: [opts] });
    }
    async bind(dn: string, pw: string) {
      calls.push({ method: "bind", args: [dn, pw] });
    }
    async search(base: string, opts: { filter: string; scope: string }) {
      calls.push({ method: "search", args: [base, opts] });
      if (opts.scope === "base") return { searchEntries: [{ dn: base, wellKnownObjects: ["B:32:AA312825768811D1ADED00C04FD8D5CD:OU=New PCs,DC=example,DC=org"] }] };
      return { searchEntries: entries };
    }
    async unbind() {
      calls.push({ method: "unbind", args: [] });
    }
  }
  return { Client };
});

const GUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  calls.length = 0;
  entries = [];
  process.env.LDAP_URL = "ldaps://dc1.example.org:636";
  process.env.LDAP_BIND_DN = "CN=svc,DC=example,DC=org";
  process.env.LDAP_BIND_PASSWORD = "pw";
  process.env.LDAP_BASE_DN = "DC=example,DC=org";
});

describe("objectGUID handling", () => {
  it("converts between AD byte order and string form", () => {
    const buf = guidToBuffer(GUID);
    expect(buf.toString("hex")).toBe("5bad8f0fcbd99f46a16570867728950e");
    expect(guidFromBuffer(buf)).toBe(GUID);
    expect(normalizeGuid(`{${GUID.toUpperCase()}}`)).toBe(GUID);
    expect(isGuid("not-a-guid")).toBe(false);
  });
  it("escapes every byte for LDAP filters", () => {
    expect(guidFilterValue(GUID)).toBe("\\5b\\ad\\8f\\0f\\cb\\d9\\9f\\46\\a1\\65\\70\\86\\77\\28\\95\\0e");
  });
});

describe("LdapDirectory (mocked ldapts)", () => {
  it("looks up a computer by objectGUID with a read-only bind and maps attributes", async () => {
    const { LdapDirectory } = await import("@/lib/directory/ldap");
    entries = [
      {
        dn: "CN=PC1,OU=Staff,DC=example,DC=org",
        cn: "pc1",
        sAMAccountName: "PC1$",
        objectGUID: guidToBuffer(GUID),
        dNSHostName: "pc1.example.org",
        operatingSystem: "Windows 11 Enterprise",
        userAccountControl: "4098", // WORKSTATION_TRUST_ACCOUNT | ACCOUNTDISABLE
      },
    ];
    const c = await new LdapDirectory().findComputerByGuid(GUID);
    expect(c).toMatchObject({ name: "PC1", objectGuid: GUID, disabled: true, dn: "CN=PC1,OU=Staff,DC=example,DC=org" });
    const search = calls.find((x) => x.method === "search")!;
    expect((search.args[1] as { filter: string }).filter).toBe(`(&(objectCategory=computer)(objectGUID=${guidFilterValue(GUID)}))`);
    expect(calls.find((x) => x.method === "bind")!.args).toEqual(["CN=svc,DC=example,DC=org", "pw"]);
    expect(calls.at(-1)!.method).toBe("unbind");
    expect(calls.some((x) => ["add", "modify", "del"].includes(x.method))).toBe(false);
  });

  it("returns null when the GUID is not unique or missing", async () => {
    const { LdapDirectory } = await import("@/lib/directory/ldap");
    entries = [];
    expect(await new LdapDirectory().findComputerByGuid(GUID)).toBeNull();
  });

  it("lists OUs and adds the redirected default computers container", async () => {
    const { LdapDirectory } = await import("@/lib/directory/ldap");
    entries = [{ dn: "OU=Staff,DC=example,DC=org", ou: "Staff" }];
    const nodes = await new LdapDirectory().listContainers();
    expect(nodes.map((n) => [n.kind, n.dn])).toEqual([
      ["domain", "DC=example,DC=org"],
      ["ou", "OU=Staff,DC=example,DC=org"],
      ["container", "OU=New PCs,DC=example,DC=org"],
    ]);
  });
});

describe("FakeDirectory and OU tree", () => {
  it("provides a deterministic sample domain", async () => {
    const d = new FakeDirectory();
    const pcs = await d.listComputers();
    expect(pcs.find((c) => c.name === "FIN-01")?.objectGuid).toBe(fakeGuid("FIN-01"));
    expect(isGuid(fakeGuid("X"))).toBe(true);
    expect(await d.findComputerByGuid(fakeGuid("LAB-01").toUpperCase())).toMatchObject({ name: "LAB-01" });
  });

  it("builds a nested, sorted tree", async () => {
    const tree = buildOuTree(await new FakeDirectory().listContainers());
    expect(tree).toHaveLength(1);
    const flat = flattenTree(tree);
    expect(flat[0].kind).toBe("domain");
    expect(flat.at(-1)?.kind).toBe("container");
    const fin = flat.find((n) => n.name === "Finance")!;
    expect(fin.depth).toBe(3);
  });
});
