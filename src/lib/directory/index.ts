import { config, directoryMode, fakeAdEnabled } from "../config";
import { FakeDirectory, loadFakeDirectoryFile } from "./fake";
import { LdapDirectory } from "./ldap";
import { freshness, SnapshotDirectory, type Freshness } from "./snapshot";
import { DbSnapshotStore } from "./snapshot-db";
import type { Directory } from "./types";

const g = globalThis as unknown as { __spoolfreeDir?: Directory };

export function directory(): Directory {
  if (!g.__spoolfreeDir) {
    const mode = directoryMode();
    g.__spoolfreeDir =
      mode === "fake"
        ? fakeDirectory()
        : mode === "snapshot"
          ? new SnapshotDirectory(new DbSnapshotStore(), { baseDn: baseDn(), maxAgeHours: config().DIRECTORY_MAX_AGE_HOURS })
          : new LdapDirectory();
  }
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

/** Snapshot mode only: how old the directory data is (null in ldap/fake mode or when the database is unreachable). */
export async function directorySyncFreshness(): Promise<Freshness | null> {
  if (directoryMode() !== "snapshot") return null;
  try {
    const status = await new DbSnapshotStore().status();
    return freshness(status, new Date(), config().DIRECTORY_STALE_MINUTES);
  } catch {
    return null;
  }
}

export { DirectoryUnavailableError } from "./types";
export type { ComputerObject, Directory, OuNode } from "./types";
export type { Freshness } from "./snapshot";
