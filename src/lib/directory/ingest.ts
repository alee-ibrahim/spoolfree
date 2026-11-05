import { ZodError } from "zod";
import { constantTimeEquals } from "../crypto/signing";
import { parseSnapshot, sanitizeSyncError, SnapshotRejected, SyncErrorPayload, type SnapshotStore } from "./snapshot";

/** 447 computers are ~200 KB of JSON; this leaves room for very large domains. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MIN_SYNC_TOKEN_LENGTH = 32;

export interface IngestDeps {
  mode: string;
  token: string | undefined;
  store: SnapshotStore;
  baseDn: string;
  now?: () => Date;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * POST /api/internal/directory-snapshot, called only by the adsync sidecar (same pod).
 * - 404 unless DIRECTORY_MODE=snapshot
 * - 503 when DIRECTORY_SYNC_TOKEN is unset or shorter than 32 characters (never open)
 * - 401 unless "Authorization: Bearer <DIRECTORY_SYNC_TOKEN>"
 * Body: a full snapshot (replaces the stored one) or {"version":1,"status":"error","error":"..."}.
 */
export async function handleSnapshotPush(req: Request, deps: IngestDeps): Promise<Response> {
  if (deps.mode !== "snapshot") return json({ error: "not found" }, 404);
  if (!deps.token || deps.token.length < MIN_SYNC_TOKEN_LENGTH) {
    return json({ error: "directory sync is not configured (DIRECTORY_SYNC_TOKEN)" }, 503);
  }
  const h = req.headers.get("authorization") ?? "";
  const presented = /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, "").trim() : "";
  if (!presented || !constantTimeEquals(presented, deps.token)) return json({ error: "unauthorized" }, 401);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_SNAPSHOT_BYTES) return json({ error: "snapshot too large" }, 413);
  const text = await req.text();
  if (text.length > MAX_SNAPSHOT_BYTES) return json({ error: "snapshot too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const now = (deps.now ?? (() => new Date()))();

  if (body && typeof body === "object" && (body as { status?: unknown }).status === "error") {
    const e = SyncErrorPayload.safeParse(body);
    if (!e.success) return json({ error: "invalid error report" }, 400);
    await deps.store.recordError(sanitizeSyncError(e.data.error), e.data.source ?? null, now);
    return json({ ok: true });
  }

  try {
    const snapshot = parseSnapshot(body, deps.baseDn);
    await deps.store.replace(snapshot, now);
    return json({ ok: true, ous: snapshot.ous.length, computers: snapshot.computers.length });
  } catch (e) {
    if (e instanceof SnapshotRejected || e instanceof ZodError) {
      const reason =
        e instanceof ZodError
          ? `invalid snapshot: ${e.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`
          : e.message;
      await deps.store.recordError(sanitizeSyncError(`rejected: ${reason}`), null, now);
      return json({ error: reason }, 400);
    }
    throw e;
  }
}
