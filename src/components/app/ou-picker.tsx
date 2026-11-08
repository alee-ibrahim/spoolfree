"use client";

import { ChevronsUpDownIcon, FolderTreeIcon, MonitorIcon, StarIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { normalizeDn } from "@/lib/dn";
import { cn } from "@/lib/utils";

export interface OuOption {
  /** Normalized DN. */
  key: string;
  dn: string;
  name: string;
  /** "Workstations › Administration › Finance". */
  path: string;
  depth: number;
  kind: "domain" | "ou" | "container";
  /** Enabled computers in this OU and below. */
  computers: number;
  /** The OU's current default printer, if any. */
  defaultPrinter: { id: string; name: string } | null;
}

export interface PickedOu {
  ouDn: string;
  isDefault: boolean;
}

interface Props {
  options: OuOption[] | null;
  value: PickedOu[];
  onChange: (v: PickedOu[]) => void;
  /** The printer being edited (null when adding). */
  printerId: string | null;
}

const keyOf = normalizeDn;

/** Multi-select of directory OUs for the Add/Edit printer form. */
export function OuPicker({ options, value, onChange, printerId }: Props) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const id = useId();
  const byKey = useMemo(() => new Map((options ?? []).map((o) => [o.key, o])), [options]);
  const selected = new Map(value.map((v) => [keyOf(v.ouDn), v]));

  const toggle = (o: OuOption) => {
    if (selected.has(o.key)) onChange(value.filter((v) => keyOf(v.ouDn) !== o.key));
    else onChange([...value, { ouDn: o.dn, isDefault: false }]);
  };
  const remove = (dn: string) => onChange(value.filter((v) => keyOf(v.ouDn) !== keyOf(dn)));
  const setDefault = (dn: string, isDefault: boolean) =>
    onChange(value.map((v) => (keyOf(v.ouDn) === keyOf(dn) ? { ...v, isDefault } : v)));

  if (!options) {
    return (
      <Field>
        <FieldLabel>Assign to OUs</FieldLabel>
        <FieldDescription>
          The directory cannot be read right now, so OUs cannot be changed here. Existing assignments are kept; use Assignments when the
          directory is back.
        </FieldDescription>
      </Field>
    );
  }

  const list = (
    <Command
      // Search matches the full path, so "admin fin" finds Administration › Finance.
      filter={(itemValue, search) => (search.toLowerCase().split(/\s+/).every((w) => itemValue.toLowerCase().includes(w)) ? 1 : 0)}
      className={cn(isMobile && "rounded-none bg-transparent")}
    >
      <CommandInput placeholder="Search OUs…" aria-label="Search OUs" />
      <CommandList className={cn(isMobile ? "max-h-[55svh]" : "max-h-80")}>
        <CommandEmpty>No OU matches.</CommandEmpty>
        <CommandGroup>
          {options.map((o) => {
            const checked = selected.has(o.key);
            return (
              <CommandItem
                key={o.key}
                value={`${o.path} ${o.dn}`}
                data-checked={checked}
                onSelect={() => toggle(o)}
                className="items-start"
              >
                <span className="flex min-w-0 flex-1 flex-col" style={{ paddingInlineStart: `${o.depth * 0.875}rem` }}>
                  <span className="truncate">{o.kind === "domain" ? `${o.name} (domain root)` : o.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {o.depth > 1 ? `${o.path} · ` : ""}
                    {o.computers} PC{o.computers === 1 ? "" : "s"}
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
        <FolderTreeIcon data-icon="inline-start" />
        {value.length ? `${value.length} OU${value.length === 1 ? "" : "s"} selected` : "Choose OUs…"}
      </span>
      <ChevronsUpDownIcon className="opacity-50" />
    </Button>
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>Assign to OUs</FieldLabel>
      {isMobile ? (
        <>
          {trigger}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent side="bottom" className="max-h-[90svh] gap-0 rounded-t-xl pb-[env(safe-area-inset-bottom)]">
              <SheetHeader>
                <SheetTitle>Assign to OUs</SheetTitle>
                <SheetDescription>Computers in child OUs get the printer too.</SheetDescription>
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
        <ul className="flex flex-col gap-2" aria-label="Selected OUs">
          {value.map((v) => {
            const o = byKey.get(keyOf(v.ouDn));
            const label = o ? (o.kind === "domain" ? `${o.name} (domain root)` : o.path) : v.ouDn;
            const other = o?.defaultPrinter && o.defaultPrinter.id !== printerId ? o.defaultPrinter : null;
            const switchId = `${id}-def-${keyOf(v.ouDn)}`;
            return (
              <li key={keyOf(v.ouDn)} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-2">
                <Badge variant="secondary" className="mr-auto h-auto max-w-full min-w-0 py-1 pr-0.5 whitespace-normal">
                  <span className="min-w-0 break-words">{label}</span>
                  {o && (
                    <span className="flex items-center gap-0.5 text-muted-foreground">
                      <MonitorIcon />
                      {o.computers}
                    </span>
                  )}
                  <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" aria-label={`Remove ${label}`} onClick={() => remove(v.ouDn)}>
                    <XIcon />
                  </Button>
                </Badge>
                <div className="flex shrink-0 items-center gap-2 pl-1">
                  <Switch id={switchId} checked={v.isDefault} onCheckedChange={(c) => setDefault(v.ouDn, c)} />
                  <label htmlFor={switchId} className="flex min-h-11 items-center gap-1 text-sm sm:min-h-0">
                    <StarIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    Default<span className="sr-only"> for this OU</span>
                  </label>
                </div>
                {v.isDefault && other && (
                  <p className="basis-full pl-1 text-xs text-muted-foreground">Replaces {other.name} as this OU&apos;s default printer.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <FieldDescription>
        {value.length === 0 ? "Optional. You can also assign printers on the Assignments page." : "Computers in child OUs get the printer too."}
      </FieldDescription>
    </Field>
  );
}
