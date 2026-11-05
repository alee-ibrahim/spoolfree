import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { lowMarkers, needsAttention, stripSeverity, type Marker } from "@/lib/ipp/interpret";

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

export function StatusBadges({ status }: { status: StatusLike }) {
  if (!status) return <Badge variant="outline">Pending</Badge>;
  if (!status.online) return <Badge variant="destructive">Offline</Badge>;
  const attention = needsAttention(status);
  const low = lowMarkers(status);
  return (
    <div className="flex flex-wrap gap-1">
      {attention.length === 0 && <Badge variant="secondary">{status.state === "processing" ? "Printing" : "Ready"}</Badge>}
      {attention.map((r) => (
        <Badge key={r} variant="destructive">
          {REASON_LABELS[stripSeverity(r)] ?? r}
        </Badge>
      ))}
      {low.length > 0 && <Badge variant="outline">Low: {low.map((m) => m.name).join(", ")}</Badge>}
    </div>
  );
}

export function MarkerBars({ markers }: { markers: Marker[] }) {
  if (markers.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-1.5">
      {markers.slice(0, 5).map((m) => (
        <div key={m.name} className="grid grid-cols-[minmax(0,7rem)_1fr_2.5rem] items-center gap-2 text-xs">
          <span className="truncate text-muted-foreground" title={m.name}>
            {m.name}
          </span>
          <Progress value={m.level ?? 0} className={m.low ? "[&>[data-slot=progress-indicator]]:bg-destructive" : undefined} />
          <span className="text-right tabular-nums">{m.level === null ? "?" : `${m.level}%`}</span>
        </div>
      ))}
    </div>
  );
}
