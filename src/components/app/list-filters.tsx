"use client";

import { CalendarIcon, CheckIcon, ChevronsUpDownIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { DateRange } from "react-day-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}

/** One filter control. Everything is serialisable so server pages can describe their filters. */
export type FilterField =
  /** A choice; `searchable` turns it into a combobox for long lists (OUs, versions). */
  | { kind: "select"; key: string; label: string; allLabel: string; options: FilterOption[]; searchable?: boolean }
  /** A few mutually exclusive values shown side by side, plus "All". */
  | { kind: "toggle"; key: string; label: string; allLabel?: string; options: FilterOption[] }
  /** On/off ("1" in the URL). */
  | { kind: "switch"; key: string; label: string }
  /** Date range with presets. `required`: always set (the page's default range is passed in from/to). */
  | { kind: "dates"; label: string; fromKey: string; toKey: string; today: string; required?: boolean; from?: string | null; to?: string | null }
  /** Sort order (not counted as a filter). */
  | { kind: "sort"; key: string; label: string; options: FilterOption[]; defaultValue: string };

interface Props {
  fields: FilterField[];
  searchLabel: string;
  searchPlaceholder: string;
  /** Items before filtering, and after. */
  total: number;
  shown: number;
  noun: [singular: string, plural: string];
  /** Params "Clear filters" keeps (the selected OU, a required date range). */
  keep?: string[];
  className?: string;
}

const ALL = "__all__";
const SEARCH_KEY = "q";
const DEBOUNCE_MS = 300;

const PRESETS = [
  { label: "Today", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 12 months", days: 365 },
];

function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const fmtDay = (s: string) => fromDay(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const nf = new Intl.NumberFormat("en-US");

/** Keys a field writes to the URL. */
const keysOf = (f: FilterField) => (f.kind === "dates" ? [f.fromKey, f.toKey] : [f.key]);

/**
 * Search box plus filters for a list page. All state is in the URL (shareable, survives a refresh, the back button
 * works) and the server filters. From md up the filters sit in a row under the search; on phones they open in a
 * bottom Sheet behind a "Filters" button with the number of active filters.
 */
export function ListFilters({ fields, searchLabel, searchPlaceholder, total, shown, noun, keep = [], className }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [sheetOpen, setSheetOpen] = useState(false);

  const navigate = (patch: Record<string, string | null>, replace = false) => {
    // The live URL, not the rendered params: a second quick change must not drop the first one.
    const p = new URLSearchParams(window.location.search);
    p.delete("page");
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    start(() => (replace ? router.replace(url, { scroll: false }) : router.push(url, { scroll: false })));
  };

  // Search: typed text is debounced into ?q= (replace, so typing does not fill the history).
  const urlQ = sp.get(SEARCH_KEY) ?? "";
  const [text, setText] = useState(urlQ);
  const [seenQ, setSeenQ] = useState(urlQ);
  // The last value this box wrote to the URL (so its own write does not reset what is being typed).
  const [sent, setSent] = useState(urlQ);
  if (urlQ !== seenQ) {
    // The URL changed (back button, Clear filters, a link): show it unless it is our own debounced write.
    setSeenQ(urlQ);
    if (urlQ !== sent) setText(urlQ);
  }
  useEffect(() => {
    if (text.trim() === urlQ.trim()) return;
    const t = setTimeout(() => {
      setSent(text.trim());
      navigate({ [SEARCH_KEY]: text.trim() || null }, true);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const value = (key: string) => sp.get(key);
  const isActive = (f: FilterField) => {
    if (f.kind === "sort") return false;
    if (f.kind === "dates") return !f.required && !!(value(f.fromKey) || value(f.toKey));
    return !!value(f.key);
  };
  const activeCount = fields.filter(isActive).length;
  const anyActive = activeCount > 0 || !!urlQ;
  const clear = () => {
    const patch: Record<string, string | null> = { [SEARCH_KEY]: null };
    for (const f of fields) if (f.kind !== "sort") for (const k of keysOf(f)) if (!keep.includes(k)) patch[k] = null;
    setSent("");
    setText("");
    navigate(patch);
  };

  const countText =
    shown === total
      ? `${nf.format(total)} ${total === 1 ? noun[0] : noun[1]}`
      : `${nf.format(shown)} of ${nf.format(total)} ${total === 1 ? noun[0] : noun[1]}`;

  const control = (f: FilterField, stacked: boolean) => (
    <FilterControl key={keysOf(f).join("|")} field={f} stacked={stacked} value={value} onChange={(patch) => navigate(patch)} />
  );

  return (
    <div className={cn("flex flex-col gap-2", pending && "opacity-70 transition-opacity", className)} aria-busy={pending}>
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1 md:max-w-sm">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput type="search" className="h-auto self-stretch" value={text} onChange={(e) => setText(e.target.value)} placeholder={searchPlaceholder} aria-label={searchLabel} />
        </InputGroup>
        {fields.length > 0 && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" className="md:hidden" aria-label={activeCount ? `Filters (${activeCount} active)` : "Filters"}>
                <SlidersHorizontalIcon data-icon="inline-start" aria-hidden />
                Filters
                {activeCount > 0 && <Badge className="ml-0.5 h-5 min-w-5 rounded-full px-1.5 tabular-nums">{activeCount}</Badge>}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[85dvh] rounded-t-xl">
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription aria-live="polite">{countText}</SheetDescription>
              </SheetHeader>
              <div className="overflow-y-auto px-4">
                <FieldGroup className="gap-4">{fields.map((f) => control(f, true))}</FieldGroup>
              </div>
              <SheetFooter className="flex-row gap-2 border-t">
                <Button variant="outline" className="flex-1" onClick={clear} disabled={!anyActive}>
                  Clear filters
                </Button>
                <Button className="flex-1" onClick={() => setSheetOpen(false)}>
                  Show {nf.format(shown)}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        )}
      </div>
      {fields.length > 0 && <div className="hidden flex-wrap items-center gap-2 md:flex">{fields.map((f) => control(f, false))}</div>}
      <div className="flex min-h-8 items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite" data-testid="result-count">
          {countText}
        </p>
        {anyActive && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <XIcon data-icon="inline-start" aria-hidden />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

function FilterControl({
  field: f,
  stacked,
  value,
  onChange,
}: {
  field: FilterField;
  stacked: boolean;
  value: (key: string) => string | null;
  onChange: (patch: Record<string, string | null>) => void;
}) {
  const wrap = (label: string, control: React.ReactNode, id?: string) =>
    stacked ? (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {control}
      </Field>
    ) : (
      control
    );

  if (f.kind === "switch") {
    const on = value(f.key) === "1";
    if (!stacked)
      return (
        <Toggle variant="outline" pressed={on} onPressedChange={(p) => onChange({ [f.key]: p ? "1" : null })}>
          {on && <CheckIcon data-icon="inline-start" aria-hidden />}
          {f.label}
        </Toggle>
      );
    const id = `filter-${f.key}`;
    return (
      <Field orientation="horizontal">
        <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
        <Switch id={id} checked={on} onCheckedChange={(c) => onChange({ [f.key]: c ? "1" : null })} />
      </Field>
    );
  }

  if (f.kind === "toggle") {
    const v = value(f.key) ?? ALL;
    const items = [{ value: ALL, label: f.allLabel ?? "All" }, ...f.options];
    const group = (
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={v}
        onValueChange={(nv) => onChange({ [f.key]: !nv || nv === ALL ? null : nv })}
        aria-label={f.label}
        className={stacked ? "w-full" : undefined}
      >
        {items.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} className={stacked ? "flex-1" : undefined}>
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
    if (stacked) return wrap(f.label, group);
    // Inline: a visible label, so two "All" groups side by side stay distinguishable.
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{f.label}</span>
        {group}
      </div>
    );
  }

  if (f.kind === "dates") return wrap(f.label, <DateRangeControl field={f} value={value} onChange={onChange} stacked={stacked} />);

  if (f.kind === "select" && f.searchable) return wrap(f.label, <ComboboxControl field={f} value={value(f.key)} onChange={onChange} stacked={stacked} />);

  // select / sort
  const v = value(f.key) ?? (f.kind === "sort" ? f.defaultValue : ALL);
  const id = `filter-${f.key}`;
  const items = f.kind === "sort" ? f.options : [{ value: ALL, label: f.allLabel }, ...f.options];
  // Keep an unknown URL value visible instead of showing an empty trigger.
  if (!items.some((o) => o.value === v)) items.push({ value: v, label: v });
  return wrap(
    f.label,
    <Select value={v} onValueChange={(nv) => onChange({ [f.key]: nv === ALL || (f.kind === "sort" && nv === f.defaultValue) ? null : nv })}>
      <SelectTrigger id={id} className={stacked ? "w-full" : f.kind === "sort" ? "w-auto min-w-44" : "w-44"} aria-label={f.label}>
        {f.kind === "sort" && !stacked && <span className="text-muted-foreground">Sort:</span>}
        <SelectValue placeholder={f.label} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>,
    id,
  );
}

function ComboboxControl({
  field: f,
  value,
  onChange,
  stacked,
}: {
  field: Extract<FilterField, { kind: "select" }>;
  value: string | null;
  onChange: (patch: Record<string, string | null>) => void;
  stacked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = f.options.find((o) => o.value === value);
  const pick = (v: string | null) => {
    setOpen(false);
    onChange({ [f.key]: v });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`${f.label}: ${selected?.label ?? value ?? f.allLabel}`}
          className={cn("justify-between font-normal", stacked ? "w-full" : "w-56")}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>{selected?.label ?? value ?? f.allLabel}</span>
          <ChevronsUpDownIcon data-icon="inline-end" className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder={`Search ${f.label.toLowerCase()}`} />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__all ${f.allLabel}`} onSelect={() => pick(null)}>
                {f.allLabel}
                {!value && <CheckIcon className="ml-auto" aria-label="selected" />}
              </CommandItem>
              {f.options.map((o) => (
                <CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => pick(o.value)}>
                  <span className="truncate">{o.label}</span>
                  {o.value === value && <CheckIcon className="ml-auto" aria-label="selected" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DateRangeControl({
  field: f,
  value,
  onChange,
  stacked,
}: {
  field: Extract<FilterField, { kind: "dates" }>;
  value: (key: string) => string | null;
  onChange: (patch: Record<string, string | null>) => void;
  stacked: boolean;
}) {
  const from = value(f.fromKey) ?? f.from ?? null;
  const to = value(f.toKey) ?? f.to ?? null;
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(from ? { from: fromDay(from), to: to ? fromDay(to) : undefined } : undefined);
  const today = f.today;
  const activePreset = from && to === today ? PRESETS.find((p) => addDays(today, -(p.days - 1)) === from) : undefined;
  const label = activePreset?.label ?? (from && to ? (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`) : from ? `From ${fmtDay(from)}` : to ? `Until ${fmtDay(to)}` : "Any time");
  const set = (a: string | null, b: string | null) => {
    setOpen(false);
    onChange({ [f.fromKey]: a, [f.toKey]: b });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setRange(from ? { from: fromDay(from), to: to ? fromDay(to) : undefined } : undefined);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("justify-start font-normal", stacked && "w-full")} aria-label={`${f.label}: ${label}`}>
          <CalendarIcon data-icon="inline-start" aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
        <div className="flex flex-col p-1">
          {!f.required && (
            <Button variant="ghost" className="justify-between" onClick={() => set(null, null)}>
              Any time
              {!from && !to && <CheckIcon className="size-4 stroke-[3]" aria-label="selected" />}
            </Button>
          )}
          {PRESETS.map((p) => (
            <Button key={p.label} variant="ghost" className="justify-between" onClick={() => set(addDays(today, -(p.days - 1)), today)}>
              {p.label}
              {activePreset?.label === p.label && <CheckIcon className="size-4 stroke-[3]" aria-label="selected" />}
            </Button>
          ))}
        </div>
        <Separator />
        <Calendar
          mode="range"
          numberOfMonths={1}
          selected={range}
          onSelect={setRange}
          defaultMonth={fromDay(to ?? today)}
          disabled={{ after: fromDay(today) }}
          className="mx-auto"
        />
        <div className="flex justify-end gap-2 border-t p-2">
          <Button size="sm" disabled={!range?.from} onClick={() => range?.from && set(toDay(range.from), toDay(range.to ?? range.from))}>
            Apply range
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
