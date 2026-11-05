import { config, directoryMode, secretValue } from "@/lib/config";
import { baseDn } from "@/lib/directory";
import { handleSnapshotPush } from "@/lib/directory/ingest";
import { DbSnapshotStore } from "@/lib/directory/snapshot-db";

/**
 * Internal: the adsync sidecar pushes directory snapshots here (DIRECTORY_MODE=snapshot).
 * Requires DIRECTORY_SYNC_TOKEN; keep /api/internal/ off your ingress or gateway as well.
 */
function syncToken(): string | undefined {
  const c = config();
  try {
    return secretValue(c.DIRECTORY_SYNC_TOKEN, c.DIRECTORY_SYNC_TOKEN_FILE);
  } catch {
    return undefined; // unreadable token file: refuse (503), never open
  }
}

export async function POST(req: Request) {
  try {
    return await handleSnapshotPush(req, {
      mode: directoryMode(),
      token: syncToken(),
      store: new DbSnapshotStore(),
      baseDn: baseDn(),
    });
  } catch (e) {
    console.error("directory snapshot error", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
