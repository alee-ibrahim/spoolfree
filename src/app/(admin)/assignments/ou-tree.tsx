"use client";

import { BanIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OuTreeItem {
  key: string;
  dn: string;
  label: string;
  depth: number;
  kind: "domain" | "ou" | "container";
  parentKey: string | null;
  hasChildren: boolean;
  count: number;
  blocked: boolean;
  /** False for an ancestor shown only to keep a matching OU in place. */
  matched: boolean;
}

/** Levels shown before the tree collapses (domain = 0, top-level OUs = 1, departments = 2). */
const OPEN_DEPTH = 2;

/**
 * OU tree: collapsible nodes (deeper levels collapsed by default, the selected OU's ancestors open). The server
 * filters it (name search, "only OUs with printers", "gets printer X"); a filtered tree is shown fully expanded with
 * the ancestors of matching OUs dimmed. It flows with the page on small screens; on large screens it scrolls inside
 * the card.
 */
export function OuTree({
  items,
  selectedKey,
  filtering,
  filterQuery,
}: {
  items: OuTreeItem[];
  selectedKey: string;
  filtering: boolean;
  /** "?q=...&assigned=1" (or ""): kept when another OU is picked. */
  filterQuery: string;
}) {
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set(items.filter((i) => i.depth < OPEN_DEPTH).map((i) => i.key));
    let p = byKey.get(selectedKey)?.parentKey ?? null;
    while (p) {
      open.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
    return open;
  });

  const visible = useMemo(() => {
    if (filtering) return items;
    return items.filter((i) => {
      let p = i.parentKey;
      while (p) {
        if (!expanded.has(p)) return false;
        p = byKey.get(p)?.parentKey ?? null;
      }
      return true;
    });
  }, [items, byKey, expanded, filtering]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const href = (dn: string) => `/assignments?ou=${encodeURIComponent(dn)}${filterQuery ? `&${filterQuery.slice(1)}` : ""}`;

  return (
    <nav className="flex flex-col gap-0.5 lg:max-h-[70vh] lg:overflow-y-auto" aria-label="Organizational units">
      {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No OU matches the filters.</p>}
      {visible.map((n) => {
        const active = n.key === selectedKey;
        const open = filtering ? true : expanded.has(n.key);
        return (
          <div key={n.key} className="flex items-center" style={{ paddingLeft: `${n.depth * 0.75}rem` }}>
            {n.hasChildren && !filtering ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={() => toggle(n.key)}
                aria-label={`${open ? "Collapse" : "Expand"} ${n.label}`}
                aria-expanded={open}
              >
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </Button>
            ) : (
              <span className="size-7 shrink-0" />
            )}
            <Button asChild variant={active ? "secondary" : "ghost"} size="sm" className={cn("min-w-0 flex-1 justify-start", !n.matched && "text-muted-foreground")}>
              <Link href={href(n.dn)} aria-current={active ? "page" : undefined}>
                {active ? <FolderOpenIcon /> : <FolderIcon className={n.kind === "container" ? "text-muted-foreground" : undefined} />}
                <span className="truncate">{n.label}</span>
                <span className="ml-auto flex items-center gap-1">
                  {n.blocked && <BanIcon className="size-3 text-destructive" />}
                  {n.count > 0 && <Badge variant="secondary">{n.count}</Badge>}
                </span>
              </Link>
            </Button>
          </div>
        );
      })}
    </nav>
  );
}
