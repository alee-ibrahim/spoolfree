import "server-only";
import path from "node:path";
import { agentUpdateOffer, buildAgentBundle, signAgentBundle, type AgentUpdateOffer, type SignedAgentBundle } from "./agent-bundle";
import { config } from "./config";
import { signingKey } from "./keys";

let cached: { dir: string; bundle: SignedAgentBundle | null } | null = null;

export function agentBundleDir(): string {
  return config().AGENT_BUNDLE_DIR ?? path.join(process.cwd(), "agent");
}

/** The signed agent bundle built from AGENT_BUNDLE_DIR, once per process; null when the scripts are not there. */
export function currentAgentBundle(): SignedAgentBundle | null {
  const dir = agentBundleDir();
  if (cached && cached.dir === dir) return cached.bundle;
  let bundle: SignedAgentBundle | null = null;
  try {
    const b = buildAgentBundle(dir);
    bundle = b ? signAgentBundle(b, signingKey().key) : null;
  } catch (e) {
    console.error("agent bundle unavailable:", (e as Error).message);
  }
  cached = { dir, bundle };
  return bundle;
}

/** What the manifest offers: undefined when self-update is off (AGENT_SELF_UPDATE=false) or there is no bundle. */
export function agentUpdateForManifest(): AgentUpdateOffer | undefined {
  if (!config().AGENT_SELF_UPDATE) return undefined;
  const b = currentAgentBundle();
  return b ? agentUpdateOffer(b, config().AGENT_ALLOW_DOWNGRADE) : undefined;
}

/** For tests. */
export function resetAgentBundleCache() {
  cached = null;
}
