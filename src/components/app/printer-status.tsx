import { CircleCheckIcon, CircleDashedIcon, LoaderIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { lowMarkers, needsAttention, stripSeverity, type Marker } from "@/lib/ipp/interpret";
import { cn } from "@/lib/utils";

type StatusLike = {
  online: boolean;
  state: string;
  stateReasons: string[];
  markers: Marker[];
} | null;

const REASON_LABELS: Record<string, string> = {
  "media-jam": "Paper jam",
  "media-empty": "Out of paper",
  "media-needed": "Load paper",
  "media-low": "Paper low",
  "toner-empty": "Toner empty",
  "marker-supply-empty": "Supply empty",
  "door-open": "Door open",
  "cover-open": "Cover open",
  "input-tray-missing": "Tray missing",
  "output-area-full": "Output full",
  paused: "Paused",
  offline: "Offline",
};

/** Status as icon + label (never colour alone). */
export function StatusBadges({ status }: { status: StatusLike }) {
  if (!status)
    return (
      <Badge variant="outline">
        <CircleDashedIcon data-icon="inline-start" aria-hidden />
        Pending
      </Badge>
    );
  if (!status.online)
    return (
      <Badge variant="destructive">
        <WifiOffIcon data-icon="inline-start" aria-hidden />
        Offline
      </Badge>
    );
  const attention = needsAttention(status);
  const low = lowMarkers(status);
  return (
    <div className="flex flex-wrap gap-1">
      {attention.length === 0 && (
        <Badge variant="secondary">
          {status.state === "processing" ? <LoaderIcon data-icon="inline-start" aria-hidden /> : <CircleCheckIcon data-icon="inline-start" className="text-status-good" aria-hidden />}
          {status.state === "processing" ? "Printing" : "Ready"}
        </Badge>
      )}
      {attention.map((r) => (
        <Badge key={r} variant="destructive">
          <TriangleAlertIcon data-icon="inline-start" aria-hidden />
          {REASON_LABELS[stripSeverity(r)] ?? r}
        </Badge>
      ))}
      {low.length > 0 && (
        <Badge variant="outline" className="max-w-full whitespace-normal">
          <TriangleAlertIcon data-icon="inline-start" className="text-amber-600 dark:text-amber-400" aria-hidden />
          Low: {low.map((m) => m.name).join(", ")}
        </Badge>
      )}
    </div>
  );
}

/**
 * Jobs in the printer's own queue (IPP queued-job-count: pending, held or processing) at the last poll.
 * "—" when it is not known: not polled yet, offline (a stale count would mislead), or not reported by the printer.
 */
export function QueueCount({ status }: { status: { online: boolean; queuedJobs: number | null; polledAgo: string } | null }) {
  const unknown = (why: string) => (
    <span className="text-muted-foreground" title={why}>
      —<span className="sr-only">{why}</span>
    </span>
  );
  if (!status) return unknown("Queue unknown: not polled yet");
  if (!status.online) return unknown(`Queue unknown: printer offline (polled ${status.polledAgo})`);
  if (status.queuedJobs === null) return unknown(`Queue unknown: the printer does not report it (polled ${status.polledAgo})`);
  const n = status.queuedJobs;
  const label = `${n} ${n === 1 ? "job" : "jobs"} in queue (polled ${status.polledAgo})`;
  return n === 0 ? (
    <span className="tabular-nums text-muted-foreground" title={label}>
      0<span className="sr-only"> jobs in queue</span>
    </span>
  ) : (
    <Badge variant="secondary" className="tabular-nums" title={label}>
      {n} {n === 1 ? "job" : "jobs"}
    </Badge>
  );
}

/** A CSS colour from the printer's marker-colors value (#RRGGBB), or null. */
function swatch(color: string | null): string | null {
  const c = color?.split("#").filter(Boolean)[0];
  return c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : null;
}

/** Supply levels: name with the supply's own colour as a swatch, a bar, the percentage and "low" in words. */
export function MarkerBars({ markers, className }: { markers: Marker[]; className?: string }) {
  if (markers.length === 0) return <span className="text-muted-foreground">No supply data</span>;
  return (
    <ul className={cn("flex flex-col gap-2", className)} aria-label="Supplies">
      {markers.slice(0, 6).map((m) => {
        const sw = swatch(m.color);
        return (
          <li key={m.name} className="grid grid-cols-[minmax(0,8rem)_1fr_3.25rem] items-center gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={m.name}>
              <span
                className="size-2.5 shrink-0 rounded-full ring-1 ring-foreground/20"
                style={sw ? { backgroundColor: sw } : undefined}
                aria-hidden
              />
              <span className="truncate">{m.name}</span>
            </span>
            <Progress
              value={m.level ?? 0}
              aria-label={`${m.name} ${m.level === null ? "unknown" : `${m.level}%`}`}
              className={cn("h-2", m.low ? "[&>[data-slot=progress-indicator]]:bg-destructive" : "[&>[data-slot=progress-indicator]]:bg-foreground/70")}
            />
            <span className={cn("text-right tabular-nums", m.low && "font-semibold text-destructive")}>
              {m.level === null ? "?" : `${m.level}%`}
              {m.low && <span className="sr-only"> low</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
