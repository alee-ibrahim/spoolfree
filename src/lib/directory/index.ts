import { fakeAdEnabled } from "../config";
import { FakeDirectory, FAKE_BASE_DN } from "./fake";
import { LdapDirectory } from "./ldap";
import type { Directory } from "./types";

const g = globalThis as unknown as { __spoolfreeDir?: Directory };

export function directory(): Directory {
  if (!g.__spoolfreeDir) g.__spoolfreeDir = fakeAdEnabled() ? new FakeDirectory() : new LdapDirectory();
  return g.__spoolfreeDir;
}

export function baseDn(): string {
  return fakeAdEnabled() ? FAKE_BASE_DN : process.env.LDAP_BASE_DN || "DC=example,DC=org";
}

export type { ComputerObject, Directory, OuNode } from "./types";
