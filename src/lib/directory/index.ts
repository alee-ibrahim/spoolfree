import { config, fakeAdEnabled } from "../config";
import { FakeDirectory, loadFakeDirectoryFile } from "./fake";
import { LdapDirectory } from "./ldap";
import type { Directory } from "./types";

const g = globalThis as unknown as { __spoolfreeDir?: Directory };

export function directory(): Directory {
  if (!g.__spoolfreeDir) g.__spoolfreeDir = fakeAdEnabled() ? fakeDirectory() : new LdapDirectory();
  return g.__spoolfreeDir;
}

function fakeDirectory(): FakeDirectory {
  const file = config().DEV_FAKE_AD_FILE;
  return file ? loadFakeDirectoryFile(file) : new FakeDirectory();
}

export function baseDn(): string {
  if (fakeAdEnabled()) return (directory() as FakeDirectory).baseDn;
  return process.env.LDAP_BASE_DN || "DC=example,DC=org";
}

export type { ComputerObject, Directory, OuNode } from "./types";
