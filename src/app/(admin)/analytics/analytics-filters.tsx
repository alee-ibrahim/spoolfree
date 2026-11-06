"use client";

import { CalendarIcon, CheckIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const ALL = "__all__";

export interface FilterOptions {
  users: string[];
  computers: string[];
  printers: { value: string; label: string }[];
  ous: { value: string; label: string }[];
}

interface Props {
  from: string;
  to: string;
  today: string;
  values: { user: string | null; printer: string | null; ou: string | null; computer: string | null };
  options: FilterOptions;
}

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
const fmt = (s: string) => fromDay(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * One filter row above everything it scopes: date range first (presets, then a custom range), then user, printer,
 * OU and PC. Every change updates the URL, so views are shareable and the back button works.
 */
export function AnalyticsFilters({ from, to, today, values, options }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>({ from: fromDay(from), to: fromDay(to) });

  const push = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    p.delete("page");
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    start(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  };

  const activePreset = to === today ? PRESETS.find((p) => addDays(today, -(p.days - 1)) === from) : undefined;
  const rangeLabel = activePreset?.label ?? (from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`);
  const anyFilter = values.user || values.printer || values.ou || values.computer;

  const select = (key: keyof Props["values"], label: string, allLabel: string, items: { value: string; label: string }[]) => (
    <Select value={values[key] ?? ALL} onValueChange={(v) => push({ [key]: v === ALL ? null : v })}>
      <SelectTrigger className="w-full sm:w-44" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center", pending && "opacity-70")} aria-busy={pending}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="col-span-2 justify-start sm:w-auto">
            <CalendarIcon data-icon="inline-start" aria-hidden />
            {rangeLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
          <div className="flex flex-col p-1">
            {PRESETS.map((p) => {
              const selected = activePreset?.label === p.label;
              return (
                <Button
                  key={p.label}
                  variant="ghost"
                  className="justify-between"
                  onClick={() => {
                    setOpen(false);
                    push({ from: addDays(today, -(p.days - 1)), to: today });
                  }}
                >
                  {p.label}
                  {selected && <CheckIcon className="size-4 stroke-[3]" aria-label="selected" />}
                </Button>
              );
            })}
          </div>
          <Separator />
          <Calendar
            mode="range"
            numberOfMonths={1}
            selected={range}
            onSelect={setRange}
            defaultMonth={fromDay(to)}
            disabled={{ after: fromDay(today) }}
            className="mx-auto"
          />
          <div className="flex justify-end gap-2 border-t p-2">
            <Button
              size="sm"
              disabled={!range?.from}
              onClick={() => {
                if (!range?.from) return;
                setOpen(false);
                push({ from: toDay(range.from), to: toDay(range.to ?? range.from) });
              }}
            >
              Apply range
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {select("user", "User", "All users", options.users.map((u) => ({ value: u, label: u })))}
      {select("printer", "Printer", "All printers", options.printers)}
      {select("ou", "OU", "All OUs", options.ous)}
      {select("computer", "PC", "All PCs", options.computers.map((c) => ({ value: c, label: c })))}
      {anyFilter && (
        <Button variant="ghost" className="col-span-2 sm:w-auto" onClick={() => push({ user: null, printer: null, ou: null, computer: null })}>
          <XIcon data-icon="inline-start" aria-hidden />
          Clear filters
        </Button>
      )}
    </div>
  );
}
