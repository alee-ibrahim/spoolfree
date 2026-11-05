import type { Marker } from "./ipp/interpret";

/** Prometheus text exposition helpers (pure, unit-tested). */

export function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labels(l: Record<string, string>): string {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

export interface MetricsInput {
  printers: {
    name: string;
    host: string;
    location: string | null;
    online: boolean | null;
    markers: Marker[];
    pageCount: number | null;
    lastSeen: Date | null;
  }[];
  agents: { total: number; stale: number; withErrors: number };
}

export function renderMetrics(m: MetricsInput): string {
  const out: string[] = [];
  out.push("# HELP spoolfree_printer_up 1 if the printer answered the last poll.");
  out.push("# TYPE spoolfree_printer_up gauge");
  for (const p of m.printers) {
    out.push(`spoolfree_printer_up${labels({ printer: p.name, host: p.host, location: p.location ?? "" })} ${p.online ? 1 : 0}`);
  }
  out.push("# HELP spoolfree_printer_marker_level_percent Supply level in percent (toner, ink, drum).");
  out.push("# TYPE spoolfree_printer_marker_level_percent gauge");
  for (const p of m.printers) {
    for (const mk of p.markers) {
      if (mk.level === null) continue;
      out.push(
        `spoolfree_printer_marker_level_percent${labels({ printer: p.name, marker: mk.name, color: mk.color ?? "" })} ${mk.level}`,
      );
    }
  }
  out.push("# HELP spoolfree_printer_pages_total Lifetime page/impression count.");
  out.push("# TYPE spoolfree_printer_pages_total counter");
  for (const p of m.printers) {
    if (p.pageCount !== null) out.push(`spoolfree_printer_pages_total${labels({ printer: p.name })} ${p.pageCount}`);
  }
  out.push("# HELP spoolfree_printer_last_seen_timestamp_seconds Last successful poll.");
  out.push("# TYPE spoolfree_printer_last_seen_timestamp_seconds gauge");
  for (const p of m.printers) {
    if (p.lastSeen) out.push(`spoolfree_printer_last_seen_timestamp_seconds${labels({ printer: p.name })} ${Math.floor(p.lastSeen.getTime() / 1000)}`);
  }
  out.push("# HELP spoolfree_agents Enrolled agents by state.");
  out.push("# TYPE spoolfree_agents gauge");
  out.push(`spoolfree_agents{state="total"} ${m.agents.total}`);
  out.push(`spoolfree_agents{state="stale"} ${m.agents.stale}`);
  out.push(`spoolfree_agents{state="errors"} ${m.agents.withErrors}`);
  return out.join("\n") + "\n";
}
