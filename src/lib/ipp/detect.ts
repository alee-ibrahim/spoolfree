import type { IppValue } from "./encoding";
import { IppHttpError, IppStatusError } from "./client";
import { printerUri } from "./interpret";

/** Paths tried by IPP path auto-detection, in order. */
export const IPP_PATH_CANDIDATES = ["/ipp/print", "/ipp", "/ipp/printer", "/printers/lp1", "/"] as const;

/** IPP versions tried, in order: every path with 2.0 first, then every path with 1.1. */
export const IPP_DETECT_VERSIONS: [number, number][] = [
  [2, 0],
  [1, 1],
];

export type AttributeProbe = (
  uri: string,
  requested: string[],
  timeoutMs: number,
  version: [number, number],
) => Promise<Record<string, IppValue[]>>;

export interface DetectedPath {
  path: string;
  /** "2.0" or "1.1": the request version the device answered. */
  version: string;
  uri: string;
  attrs: Record<string, IppValue[]>;
  /** Every candidate that was tried, with its error (for the Test dialog). */
  tried: { path: string; version: string; error: string | null }[];
}

export class IppDetectError extends Error {
  constructor(
    message: string,
    public tried: DetectedPath["tried"],
  ) {
    super(message);
  }
}

/**
 * The device answered at this address but not at this path or version: try the next candidate. Anything else
 * (connection refused, timeout, DNS, TLS) means the host itself is unreachable, so detection stops early instead of
 * waiting out a timeout per candidate.
 */
export function isWrongPathError(e: unknown): boolean {
  if (e instanceof IppHttpError || e instanceof IppStatusError) return true;
  const msg = String((e as Error)?.message ?? "");
  return /IPP message truncated|socket hang up|unexpected end/i.test(msg);
}

/**
 * IPP path auto-detection: sends Get-Printer-Attributes to each candidate path, IPP 2.0 first and then 1.1, and
 * returns the first that answers successfully.
 */
export async function detectIppPath(
  endpoint: { host: string; port: number; useTls: boolean },
  requested: string[],
  timeoutMs: number,
  probe: AttributeProbe,
  paths: readonly string[] = IPP_PATH_CANDIDATES,
): Promise<DetectedPath> {
  const tried: DetectedPath["tried"] = [];
  for (const version of IPP_DETECT_VERSIONS) {
    const v = version.join(".");
    for (const path of paths) {
      const uri = printerUri({ ...endpoint, ippPath: path });
      try {
        const attrs = await probe(uri, requested, timeoutMs, version);
        tried.push({ path, version: v, error: null });
        return { path, version: v, uri, attrs, tried };
      } catch (e) {
        tried.push({ path, version: v, error: (e as Error).message });
        if (!isWrongPathError(e)) {
          throw new IppDetectError(`${endpoint.host}:${endpoint.port} did not answer: ${(e as Error).message}`, tried);
        }
      }
    }
  }
  throw new IppDetectError(
    `No IPP path answered Get-Printer-Attributes (tried ${paths.join(", ")} with IPP 2.0 and 1.1)`,
    tried,
  );
}
