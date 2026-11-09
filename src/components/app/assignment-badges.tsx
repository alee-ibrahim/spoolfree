"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ouShortName } from "@/lib/format";

/**
 * A printer's assigned OUs and per-PC overrides as compact badges (printers list): at most `max`, then "+N" opens a
 * popover with the full list. An OU badge applies the list's OU filter.
 */

export interface OuRef {
  ouDn: string;
  isDefault: boolean;
}
export interface PcRef {
  computerGuid: string;
  computerName: string;
  action: "add" | "block";
  makeDefault: boolean;
}

function useOuHref() {
  const pathname = usePathname();
  const params = useSearchParams();
  return (dn: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("ou", dn);
    return `${pathname}?${next.toString()}`;
  };
}

function OuBadge({ ou, path, href }: { ou: OuRef; path: string; href: string }) {
  const name = ouShortName(ou.ouDn);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" asChild>
          <Link href={href} aria-label={`Filter by OU ${path}`} data-hit-area>
            {name}
            {ou.isDefault && <span className="text-muted-foreground">· default</span>}
          </Link>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{path}</TooltipContent>
    </Tooltip>
  );
}

function PcBadge({ pc }: { pc: PcRef }) {
  const blocked = pc.action === "block";
  return (
    <Badge variant="outline" className={blocked ? "text-muted-foreground" : undefined} title={blocked ? `${pc.computerName}: blocked for this PC` : `${pc.computerName}: added for this PC`}>
      <span className={blocked ? "line-through" : undefined}>{pc.computerName}</span>
      {blocked && <span>blocked</span>}
      {!blocked && pc.makeDefault && <span className="text-muted-foreground">· default</span>}
    </Badge>
  );
}

function More({ count, label, children }: { count: number; label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge variant="outline" asChild>
          <button type="button" aria-label={`Show all ${label}`} data-hit-area>
            +{count}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="mb-2 text-sm font-medium">{label}</p>
        <div className="flex max-h-64 flex-wrap gap-1 overflow-y-auto">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

export function OuBadges({ ous, paths, max = 3, empty = "—" }: { ous: OuRef[]; paths: Record<string, string>; max?: number; empty?: string }) {
  const href = useOuHref();
  if (!ous.length) return <span className="text-muted-foreground">{empty}</span>;
  const shown = ous.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((o) => (
        <OuBadge key={o.ouDn} ou={o} path={paths[o.ouDn] ?? o.ouDn} href={href(o.ouDn)} />
      ))}
      {ous.length > max && (
        <More count={ous.length - max} label={`All ${ous.length} OUs`}>
          {ous.map((o) => (
            <OuBadge key={o.ouDn} ou={o} path={paths[o.ouDn] ?? o.ouDn} href={href(o.ouDn)} />
          ))}
        </More>
      )}
    </div>
  );
}

export function PcBadges({ pcs, max = 3, empty = "—" }: { pcs: PcRef[]; max?: number; empty?: string }) {
  if (!pcs.length) return <span className="text-muted-foreground">{empty}</span>;
  // Added PCs first, blocked ones after.
  const sorted = [...pcs].sort((a, b) => (a.action === b.action ? a.computerName.localeCompare(b.computerName) : a.action === "add" ? -1 : 1));
  return (
    <div className="flex flex-wrap gap-1">
      {sorted.slice(0, max).map((p) => (
        <PcBadge key={p.computerGuid} pc={p} />
      ))}
      {sorted.length > max && (
        <More count={sorted.length - max} label={`All ${sorted.length} PCs`}>
          {sorted.map((p) => (
            <PcBadge key={p.computerGuid} pc={p} />
          ))}
        </More>
      )}
    </div>
  );
}
