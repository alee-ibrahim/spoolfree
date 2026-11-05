import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { directorySyncFreshness, type Freshness } from "@/lib/directory";
import { timeAgo } from "@/lib/format";

/** Page-header badge: "Directory synced 3 min ago" (snapshot mode only). */
export async function DirectorySyncBadge() {
  const f = await directorySyncFreshness();
  if (!f) return null;
  const label = f.state === "never" ? "Directory never synced" : `Directory synced ${timeAgo(f.syncedAt)}`;
  const problem = f.state !== "fresh" || f.lastError;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={problem ? "destructive" : "outline"}>
          {problem ? <TriangleAlertIcon data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tooltip(f)}</TooltipContent>
    </Tooltip>
  );
}

function tooltip(f: Freshness): string {
  if (f.lastError) return `Last sync failed ${timeAgo(f.lastErrorAt)}: ${f.lastError}`;
  if (f.state === "never") return "Waiting for the first snapshot from the AD sync sidecar.";
  return `Active Directory is read by the AD sync sidecar; last snapshot at ${f.syncedAt.toISOString()}.`;
}

/** Banner for every admin page when the snapshot is missing, stale or the last sync failed. */
export async function DirectorySyncAlert() {
  const f = await directorySyncFreshness();
  if (!f || (f.state === "fresh" && !f.lastError)) return null;
  const title =
    f.state === "never"
      ? "No directory snapshot yet"
      : f.state === "stale"
        ? `Directory data is stale (last synced ${timeAgo(f.syncedAt)})`
        : "The last directory sync failed";
  return (
    <div className="px-4 pt-3">
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          {f.lastError ? `${timeAgo(f.lastErrorAt)}: ${f.lastError}. ` : "Check the adsync container's log. "}
          {f.state === "never"
            ? "AD views and agent enrollment stay unavailable until the AD sync sidecar delivers its first snapshot."
            : "AD views use the last good snapshot; agents are refused once it is older than DIRECTORY_MAX_AGE_HOURS."}
        </AlertDescription>
      </Alert>
    </div>
  );
}
