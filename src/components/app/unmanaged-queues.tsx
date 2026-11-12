import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { AgentReport, UnmanagedQueue } from "@/lib/db/schema";
import { presentUnmanaged, UNMANAGED_CLASS_LABELS } from "@/lib/unmanaged";

/** Text for what the agent did with an unmanaged queue (never color alone). */
function actionText(u: UnmanagedQueue): { label: string; className: string } {
  switch (u.action) {
    case "would-remove":
      return { label: "Would remove", className: "text-amber-700 dark:text-amber-500" };
    case "removed":
      return { label: "Removed", className: "text-muted-foreground" };
    case "failed":
      return { label: "Could not remove", className: "text-destructive" };
    case "kept":
      return { label: "Kept", className: "text-muted-foreground" };
    default:
      return { label: "Reported", className: "text-muted-foreground" };
  }
}

/** One line per unmanaged queue: name, class, scope, host/driver, matched printer and the action. */
export function UnmanagedQueueList({ items }: { items: UnmanagedQueue[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {items.map((u) => {
        const a = actionText(u);
        const detail = [u.host, u.driver].filter(Boolean).join(" · ");
        return (
          <li key={`${u.scope}|${u.queue}`} className="min-w-0 break-words">
            <span className="font-medium">{u.queue}</span>
            <span className="text-muted-foreground">
              {" "}
              · {UNMANAGED_CLASS_LABELS[u.class] ?? u.class}
              {u.scope !== "machine" ? ` · ${u.scope}` : ""}
            </span>
            {detail && <div className="text-muted-foreground">{detail}</div>}
            {u.matchedPrinter && <div className="text-muted-foreground">Copy of {u.matchedPrinter}{u.matchBy ? ` (matched by ${u.matchBy})` : ""}</div>}
            <div className={a.className}>
              {a.label}
              {u.action === "failed" && u.error ? `: ${u.error}` : u.reason && u.action === "kept" ? `: ${u.reason}` : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Compact per-PC summary for the Agents page: a toggle "N unmanaged" (plus dry-run / failed hints) that expands to the
 * list. Nothing when the agent does not report unmanaged queues (agents before 0.9.0) and has none.
 */
export function UnmanagedSummaryToggle({ report }: { report: AgentReport | null }) {
  const all = report?.unmanaged;
  if (!Array.isArray(all) || all.length === 0) {
    return report?.unmanagedPolicy?.blocked ? <div className="mt-1 text-xs text-muted-foreground">Unmanaged: {report.unmanagedPolicy.blocked}</div> : null;
  }
  const present = presentUnmanaged(report);
  const would = all.filter((u) => u.action === "would-remove").length;
  const removed = all.filter((u) => u.action === "removed").length;
  const failed = all.filter((u) => u.action === "failed").length;
  return (
    <Collapsible className="mt-1">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="h-auto min-h-8 flex-wrap justify-start gap-1 px-1 py-0.5 text-xs [&[data-state=open]>svg]:rotate-180">
          <Badge variant="outline">{present.length} unmanaged</Badge>
          {would > 0 && <Badge variant="outline" className="text-amber-700 dark:text-amber-500">{would} would remove</Badge>}
          {removed > 0 && <Badge variant="secondary">{removed} removed</Badge>}
          {failed > 0 && <Badge variant="destructive">{failed} failed</Badge>}
          <ChevronDownIcon className="transition-transform" aria-hidden />
          <span className="sr-only">Show unmanaged printers</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-w-md pl-1">
        {report?.unmanagedPolicy?.blocked && <div className="mb-1 text-xs text-muted-foreground">Nothing removed: {report.unmanagedPolicy.blocked}</div>}
        <UnmanagedQueueList items={all} />
      </CollapsibleContent>
    </Collapsible>
  );
}
