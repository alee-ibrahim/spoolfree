"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

/*
 * Charts follow the dataviz rules: one series = one colour (slot 1, no legend box), bars at most 24px thick with 4px
 * rounded data ends, hairline solid gridlines, values at bar tips only where they help, and a tooltip on every mark.
 * Two series (counter vs PCs) get a legend and the table view next to the chart.
 */

const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const pagesConfig = { pages: { label: "Pages", color: "var(--chart-1)" } } satisfies ChartConfig;

function shortDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Pages printed per day (from PCs). */
export function PagesOverTime({ data }: { data: { day: string; pages: number; jobs: number }[] }) {
  return (
    <ChartContainer config={pagesConfig} className="aspect-auto h-56 w-full md:h-64">
      <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent labelFormatter={(_, p) => shortDay(String(p?.[0]?.payload?.day ?? ""))} indicator="line" />}
        />
        <Bar dataKey="pages" fill="var(--color-pages)" radius={[4, 4, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ChartContainer>
  );
}

/** Horizontal bars for a ranking (top users, PCs, printers, OUs): one colour, value at the tip. */
export function RankingBars({ data }: { data: { label: string; pages: number; jobs: number }[] }) {
  const height = Math.max(120, data.length * 36 + 16);
  const rows = data.map((d) => ({ ...d, short: d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label }));
  return (
    <ChartContainer config={pagesConfig} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" strokeWidth={1} />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="short" tickLine={false} axisLine={false} width={128} tickMargin={4} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent labelFormatter={(_, p) => String(p?.[0]?.payload?.label ?? "")} indicator="line" />}
        />
        <Bar dataKey="pages" fill="var(--color-pages)" radius={[0, 4, 4, 0]} maxBarSize={24}>
          <LabelList dataKey="pages" position="right" className="fill-foreground" fontSize={12} formatter={(v: unknown) => nf.format(Number(v))} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const counterConfig = {
  pcPages: { label: "Sent from PCs", color: "var(--chart-1)" },
  notFromPcs: { label: "Not from PCs (copies, direct, mobile)", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** Per printer: its own page counter split into pages PCs reported and the rest. */
export function CounterVsPcs({ data }: { data: { name: string; pcPages: number; notFromPcs: number }[] }) {
  const height = Math.max(140, data.length * 40 + 56);
  const rows = data.map((d) => ({ ...d, short: d.name.length > 22 ? `${d.name.slice(0, 21)}…` : d.name }));
  return (
    <ChartContainer config={counterConfig} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" strokeWidth={1} />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
        <YAxis type="category" dataKey="short" tickLine={false} axisLine={false} width={128} tickMargin={4} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent labelFormatter={(_, p) => String(p?.[0]?.payload?.name ?? "")} indicator="line" />}
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap" />} verticalAlign="top" />
        {/* 2px surface gap between the stacked segments. */}
        <Bar dataKey="pcPages" stackId="a" fill="var(--color-pcPages)" maxBarSize={24} stroke="var(--card)" strokeWidth={2} />
        <Bar dataKey="notFromPcs" stackId="a" fill="var(--color-notFromPcs)" radius={[0, 4, 4, 0]} maxBarSize={24} stroke="var(--card)" strokeWidth={2} />
      </BarChart>
    </ChartContainer>
  );
}
