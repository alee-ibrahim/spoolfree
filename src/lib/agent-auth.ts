import "server-only";
import { eq } from "drizzle-orm";
import { constantTimeEquals, sha256Hex } from "./crypto/signing";
import { db, schema } from "./db";
import { directory } from "./directory";
import { DirectoryUnavailableError, type ComputerObject } from "./directory/types";

export class AgentAuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const t = h.slice(7).trim();
  return t.length >= 20 && t.length <= 200 ? t : null;
}

export function checkEnrollmentToken(presented: string, expected: string | undefined): boolean {
  if (!expected || expected.length < 16) return false;
  return constantTimeEquals(presented, expected);
}

/**
 * Token-only check (no directory lookup) for the cheap command poll: the agent row for a valid, unrevoked token.
 * Anything that hands out data must still call authenticateAgent.
 */
export async function agentFromToken(req: Request): Promise<typeof schema.agents.$inferSelect> {
  const token = bearer(req);
  if (!token) throw new AgentAuthError("missing bearer token");
  const [agent] = await db()
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!agent || agent.revokedAt) throw new AgentAuthError("unknown or revoked agent token");
  return agent;
}

/**
 * Authenticates an agent request: per-machine bearer token -> agent row ->
 * directory lookup by objectGUID (live LDAP, or the synced snapshot). Disabled or deleted
 * computer accounts fail; an unavailable directory gives 503 (fail closed).
 */
export async function authenticateAgent(
  req: Request,
): Promise<{ agent: typeof schema.agents.$inferSelect; computer: ComputerObject }> {
  const token = bearer(req);
  if (!token) throw new AgentAuthError("missing bearer token");
  const [agent] = await db()
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!agent || agent.revokedAt) throw new AgentAuthError("unknown or revoked agent token");
  const computer = await findComputer(agent.objectGuid);
  if (!computer) throw new AgentAuthError("computer account not found in directory", 403);
  if (computer.disabled) throw new AgentAuthError("computer account is disabled", 403);
  if (computer.dn !== agent.dn || computer.name !== agent.computerName) {
    await db()
      .update(schema.agents)
      .set({ dn: computer.dn, computerName: computer.name })
      .where(eq(schema.agents.id, agent.id));
  }
  return { agent, computer };
}

/** Directory lookup for agent requests; maps "directory unavailable" to a 503 AgentAuthError. */
export async function findComputer(guid: string): Promise<ComputerObject | null> {
  try {
    return await directory().findComputerByGuid(guid);
  } catch (e) {
    if (e instanceof DirectoryUnavailableError) throw new AgentAuthError(e.message, 503);
    throw e;
  }
}
