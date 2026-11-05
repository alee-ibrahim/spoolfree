import { NextResponse } from "next/server";
import { z } from "zod";
import { AgentAuthError, checkEnrollmentToken, findComputer } from "@/lib/agent-auth";
import { randomToken, sha256Hex } from "@/lib/crypto/signing";
import { db, schema } from "@/lib/db";
import { isGuid, normalizeGuid } from "@/lib/directory/guid";
import { dnEquals } from "@/lib/dn";
import { enrollmentToken, signingKeyInfo } from "@/lib/keys";
import { audit } from "@/lib/service";

const Body = z.object({
  enrollmentToken: z.string().min(1).max(512),
  objectGuid: z.string().refine(isGuid, "invalid GUID"),
  dn: z.string().min(3).max(2048),
  computerName: z.string().min(1).max(64),
});

/**
 * One-time enrollment. The shared enrollment token proves the caller ran our
 * GPO script; the directory (LDAP or the synced snapshot) proves the claimed computer exists, is enabled and matches
 * the claimed DN/name. A fresh per-machine token is issued (re-enrollment
 * after a reimage replaces the old token).
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const body = parsed.data;

  if (!checkEnrollmentToken(body.enrollmentToken, enrollmentToken())) {
    return NextResponse.json({ error: "invalid enrollment token" }, { status: 401 });
  }
  const guid = normalizeGuid(body.objectGuid);
  let computer;
  try {
    computer = await findComputer(guid);
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!computer || computer.disabled) {
    return NextResponse.json({ error: "computer not found or disabled" }, { status: 403 });
  }
  if (!dnEquals(computer.dn, body.dn) || computer.name.toUpperCase() !== body.computerName.toUpperCase()) {
    return NextResponse.json({ error: "computer identity mismatch" }, { status: 403 });
  }

  const token = randomToken(32);
  await db()
    .insert(schema.agents)
    .values({ objectGuid: guid, dn: computer.dn, computerName: computer.name, tokenHash: sha256Hex(token) })
    .onConflictDoUpdate({
      target: schema.agents.objectGuid,
      set: { tokenHash: sha256Hex(token), dn: computer.dn, computerName: computer.name, enrolledAt: new Date(), revokedAt: null },
    });
  await audit(`agent:${computer.name}`, "agent.enroll", "agent", guid, { dn: computer.dn });

  const key = signingKeyInfo();
  return NextResponse.json({ token, keyId: "keyId" in key ? key.keyId : null });
}
