"use client";

import { BanIcon, ChevronsUpDownIcon, MonitorIcon, StarIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export interface PcOption {
  /** Lower-case objectGUID. */
  guid: string;
  name: string;
  /** OU path of the computer: "Workstations › Administration › Finance". */
  path: string;
}

/** A stored per-computer override of the printer being edited. */
export interface PcOverride {
  computerGuid: string;
  computerName: string;
  action: "add" | "block";
  makeDefault: boolean;
}

interface Props {
  options: PcOption[] | null;
  /** Selected computer GUIDs (the printer's `add` overrides). */
  value: string[];
  onChange: (v: string[]) => void;
  /** Stored overrides of the printer being edited (names for PCs no longer in the list, default flags, blocks). */
  stored: PcOverride[];
}

/** Multi-select of directory computers ("Assign to specific PCs") for the Add/Edit printer form. */
export function PcPicker({ options, value, onChange, stored }: Props) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const id = useId();
  const byGuid = useMemo(() => new Map((options ?? []).map((o) => [o.guid, o])), [options]);
  const storedBy = useMemo(() => new Map(stored.map((o) => [o.computerGuid.toLowerCase(), o])), [stored]);
  const blocked = stored.filter((o) => o.action === "block");
  const blockedSet = new Set(blocked.map((b) => b.computerGuid.toLowerCase()));
  const selected = new Set(value);

  const toggle = (g: string) => onChange(selected.has(g) ? value.filter((v) => v !== g) : [...value, g]);
  const remove = (g: string) => onChange(value.filter((v) => v !== g));

  if (!options) {
    return (
      <Field>
        <FieldLabel>Assign to specific PCs</FieldLabel>
        <FieldDescription>
          The directory cannot be read right now, so PCs cannot be changed here. Existing per-PC assignments are kept.
        </FieldDescription>
      </Field>
    );
  }

  const list = (
    <Command
      // Search matches the name and the OU path: "fin adm-01" finds ADM-01 in Finance.
      filter={(itemValue, search) => (search.toLowerCase().split(/\s+/).every((w) => itemValue.toLowerCase().includes(w)) ? 1 : 0)}
      className={cn(isMobile && "rounded-none bg-transparent")}
    >
      <CommandInput placeholder="Search PCs…" aria-label="Search PCs" />
      <CommandList className={cn(isMobile ? "max-h-[55svh]" : "max-h-80")}>
        <CommandEmpty>No PC matches.</CommandEmpty>
        <CommandGroup>
          {options.map((o) => {
            const checked = selected.has(o.guid);
            const isBlocked = blockedSet.has(o.guid);
            return (
              <CommandItem
                key={o.guid}
                value={`${o.name} ${o.path} ${o.guid}`}
                data-checked={checked}
                disabled={isBlocked}
                onSelect={() => toggle(o.guid)}
                className="items-start"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{o.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {isBlocked ? "Blocked for this printer · " : ""}
                    {o.path || "Domain root"}
                  </span>
                </span>
                <span className="sr-only">{checked ? "selected" : "not selected"}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );

  const trigger = (
    <Button
      id={id}
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      className="w-full justify-between font-normal"
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <span className="flex items-center gap-2 truncate">
        <MonitorIcon data-icon="inline-start" />
        {value.length ? `${value.length} PC${value.length === 1 ? "" : "s"} selected` : "Choose PCs…"}
      </span>
      <ChevronsUpDownIcon className="opacity-50" />
    </Button>
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>Assign to specific PCs</FieldLabel>
      {isMobile ? (
        <>
          {trigger}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="bottom" className="max-h-[90svh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]">
              <SheetHeader>
                <SheetTitle>Assign to specific PCs</SheetTitle>
                <SheetDescription>These PCs get the printer wherever they are in the directory.</SheetDescription>
              </SheetHeader>
              {list}
              <SheetFooter>
                <Button type="button" onClick={() => setOpen(false)}>
                  Done{value.length ? ` (${value.length})` : ""}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="start" side="bottom" className="w-(--radix-popover-trigger-width) min-w-80 p-0">
            {list}
          </PopoverContent>
        </Popover>
      )}

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Selected PCs">
          {value.map((g) => {
            const o = byGuid.get(g);
            const s = storedBy.get(g);
            const name = o?.name ?? s?.computerName ?? g;
            return (
              <li key={g} className="max-w-full">
                <Badge variant="secondary" className="h-auto max-w-full min-w-0 py-1 pr-0.5 whitespace-normal" title={o?.path || undefined}>
                  {s?.makeDefault && <StarIcon aria-label="Default printer on this PC" />}
                  <span className="min-w-0 break-words">{name}</span>
                  {o?.path && <span className="hidden min-w-0 truncate text-muted-foreground sm:inline">{o.path}</span>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full"
                    aria-label={`Remove ${name}`}
                    onClick={() => remove(g)}
                  >
                    <XIcon />
                  </Button>
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {blocked.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <ul className="flex flex-wrap gap-2" aria-label="PCs that block this printer">
            {blocked.map((b) => (
              <li key={b.computerGuid}>
                <Badge variant="outline" className="text-muted-foreground">
                  <BanIcon aria-hidden />
                  {b.computerName}
                </Badge>
              </li>
            ))}
          </ul>
          <FieldDescription>Blocked on {blocked.length === 1 ? "this PC" : "these PCs"} by a per-PC override. Change blocks on Preview.</FieldDescription>
        </div>
      )}
    </Field>
  );
}
