export interface OuNode {
  dn: string;
  name: string;
  /** "domain" for the base DN, "ou" for organizationalUnit, "container" for CN=Computers etc. */
  kind: "domain" | "ou" | "container";
  description?: string | null;
}

export interface ComputerObject {
  dn: string;
  name: string;
  /** Lower-case GUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). */
  objectGuid: string;
  dnsHostName?: string | null;
  operatingSystem?: string | null;
  disabled: boolean;
}

/** Read-only view of Active Directory used by Spoolfree. */
export interface Directory {
  /** All OUs plus the base DN and well-known containers that can hold computers. */
  listContainers(): Promise<OuNode[]>;
  listComputers(): Promise<ComputerObject[]>;
  findComputerByGuid(guid: string): Promise<ComputerObject | null>;
  /** The default container for new computers (wellKnownObjects / CN=Computers). */
  defaultComputersContainer(): Promise<string>;
}

/** The directory cannot be trusted right now (no snapshot yet, or too old). Agents get 503. */
export class DirectoryUnavailableError extends Error {}
