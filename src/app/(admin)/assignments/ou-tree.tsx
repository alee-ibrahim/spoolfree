"use client";

import { BanIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
}

/** Levels shown before the tree collapses (domain = 0, top-level OUs = 1, departments = 2). */
const OPEN_DEPTH = 2;

/**
 * OU tree: collapsible nodes (deeper levels collapsed by default, the selected OU's ancestors open) and a
 * filter. It flows with the page on small screens; on large screens it scrolls inside the card.
 */
export function OuTree({ items, selectedKey }: { items: OuTreeItem[]; selectedKey: string }) {
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const ancestors = (key: string) => {
    const out = new Set<string>();
    let p = byKey.get(key)?.parentKey ?? null;
    while (p) {
      out.add(p);
      p = byKey.get(p)?.parentKey ?? null;
    }
    return out;
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set(items.filter((i) => i.depth < OPEN_DEPTH).map((i) => i.key));
    for (const a of ancestors(selectedKey)) open.add(a);
    return open;
  });
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (q) {
      const keep = new Set<string>();
      for (const i of items) {
        if (i.label.toLowerCase().includes(q)) {
          keep.add(i.key);
          let p = i.parentKey;
          while (p) {
            keep.add(p);
            p = byKey.get(p)?.parentKey ?? null;
          }
        }
      }
      return items.filter((i) => keep.has(i.key));
    }
    return items.filter((i) => {
      let p = i.parentKey;
      while (p) {
        if (!expanded.has(p)) return false;
        p = byKey.get(p)?.parentKey ?? null;
      }
      return true;
    });
  }, [items, byKey, expanded, q]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="relative px-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${items.length} OUs`}
          aria-label="Filter OUs"
          className="pl-8"
        />
      </div>
      <nav className="flex flex-col gap-0.5 lg:max-h-[70vh] lg:overflow-y-auto" aria-label="Organizational units">
        {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No OU matches “{query}”.</p>}
        {visible.map((n) => {
          const active = n.key === selectedKey;
          const open = q ? true : expanded.has(n.key);
          return (
            <div key={n.key} className="flex items-center" style={{ paddingLeft: `${n.depth * 0.75}rem` }}>
              {n.hasChildren && !q ? (
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
              <Button asChild variant={active ? "secondary" : "ghost"} size="sm" className="min-w-0 flex-1 justify-start">
                <Link href={`/assignments?ou=${encodeURIComponent(n.dn)}`} aria-current={active ? "page" : undefined}>
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
    </div>
  );
}
