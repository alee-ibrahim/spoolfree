import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { counterTotals, daysBetween, pagesNotFromPcs, type CounterDay } from "./counters";
import { words } from "../list-filters/params";
import { likeEscape, type AnalyticsFilters } from "./filters";

/** WHERE clause for print_jobs j (left-joined printers p) from the filters. */
export function where(f: AnalyticsFilters, tz: string): SQL {
  const parts: SQL[] = [
    sql`j.printed_at >= (${f.from}::date::timestamp at time zone ${tz})`,
    sql`j.printed_at < ((${f.to}::date + 1)::timestamp at time zone ${tz})`,
  ];
  if (f.user) parts.push(sql`lower(j.user_name) = lower(${f.user})`);
  if (f.computer) parts.push(sql`lower(j.computer_name) = lower(${f.computer})`);
  if (f.printer?.startsWith("queue:")) parts.push(sql`j.printer_id is null and lower(j.queue_name) = lower(${f.printer.slice(6)})`);
  else if (f.printer) parts.push(sql`j.printer_id::text = ${f.printer}`);
  if (f.ou) parts.push(sql`(lower(j.ou_dn) = lower(${f.ou}) or lower(j.ou_dn) like ${"%," + likeEscape(f.ou.toLowerCase())})`);
  for (const w of words(f.q)) {
    const pat = `%${likeEscape(w)}%`;
    parts.push(sql`(j.user_name ilike ${pat} or j.document_name ilike ${pat})`);
  }
  return sql.join(parts, sql` and `);
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface Summary {
  jobs: number;
  pages: number;
  users: number;
  printers: number;
  computers: number;
}

export interface Ranked {
  key: string;
  label: string;
  jobs: number;
  pages: number;
}

export interface JobLogRow {
  id: number;
  printedAt: string;
  userName: string | null;
  computerName: string;
  ouDn: string | null;
  printer: string;
  printerId: string | null;
  queueName: string;
  portHost: string | null;
  pages: number | null;
  bytes: number | null;
  documentName: string | null;
}

export interface CounterRow {
  printerId: string;
  name: string;
  counterPages: number | null;
  pcPages: number;
  notFromPcs: number | null;
  counterDays: number;
}

export interface UnmanagedQueue {
  queueName: string;
  portHost: string | null;
  computers: number;
  jobs: number;
  pages: number;
  lastPrinted: string;
}

export async function summary(f: AnalyticsFilters): Promise<Summary> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const [r] = await db().execute<Record<string, unknown>>(sql`
    select count(*) jobs, coalesce(sum(j.pages), 0) pages, count(distinct lower(j.user_name)) users,
           count(distinct coalesce(j.printer_id::text, 'q:' || lower(j.queue_name))) printers, count(distinct j.computer_guid) computers
    from print_jobs j where ${where(f, tz)}`);
  return { jobs: n(r?.jobs), pages: n(r?.pages), users: n(r?.users), printers: n(r?.printers), computers: n(r?.computers) };
}

export async function pagesByDay(f: AnalyticsFilters): Promise<{ day: string; pages: number; jobs: number }[]> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const rows = await db().execute<Record<string, unknown>>(sql`
    select to_char(j.printed_at at time zone ${tz}, 'YYYY-MM-DD') d, coalesce(sum(j.pages), 0) pages, count(*) jobs
    from print_jobs j where ${where(f, tz)} group by 1`);
  const by = new Map(rows.map((r) => [String(r.d), { pages: n(r.pages), jobs: n(r.jobs) }]));
  return daysBetween(f.from, f.to).map((day) => ({ day, ...(by.get(day) ?? { pages: 0, jobs: 0 }) }));
}

export type Dimension = "user" | "computer" | "printer" | "ou";

export async function top(f: AnalyticsFilters, dim: Dimension, limit = 10): Promise<Ranked[]> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const key = {
    user: sql`coalesce(j.user_name, '(unknown)')`,
    computer: sql`j.computer_name`,
    printer: sql`coalesce(j.printer_id::text, 'queue:' || j.queue_name)`,
    ou: sql`coalesce(j.ou_dn, '')`,
  }[dim];
  const label = dim === "printer" ? sql`min(coalesce(p.name, j.queue_name))` : sql`min(${key})`;
  const rows = await db().execute<Record<string, unknown>>(sql`
    select ${key} k, ${label} label, count(*) jobs, coalesce(sum(j.pages), 0) pages
    from print_jobs j left join printers p on p.id = j.printer_id
    where ${where(f, tz)} group by 1 order by 4 desc, 3 desc, 2 limit ${limit}`);
  return rows.map((r) => ({ key: String(r.k), label: String(r.label), jobs: n(r.jobs), pages: n(r.pages) }));
}

export async function jobLog(f: AnalyticsFilters, opts: { limit: number; offset?: number }): Promise<{ rows: JobLogRow[]; total: number }> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const w = where(f, tz);
  const [rows, [count]] = await Promise.all([
    db().execute<Record<string, unknown>>(sql`
      select j.id, j.printed_at, j.user_name, j.computer_name, j.ou_dn, coalesce(p.name, j.queue_name) printer, j.printer_id,
             j.queue_name, j.port_host, j.pages, j.bytes, j.document_name
      from print_jobs j left join printers p on p.id = j.printer_id
      where ${w} order by j.printed_at desc, j.id desc limit ${opts.limit} offset ${opts.offset ?? 0}`),
    db().execute<Record<string, unknown>>(sql`select count(*) c from print_jobs j where ${w}`),
  ]);
  return {
    total: n(count?.c),
    rows: rows.map((r) => ({
      id: n(r.id),
      printedAt: new Date(r.printed_at as string).toISOString(),
      userName: (r.user_name as string) ?? null,
      computerName: String(r.computer_name),
      ouDn: (r.ou_dn as string) ?? null,
      printer: String(r.printer),
      printerId: (r.printer_id as string) ?? null,
      queueName: String(r.queue_name),
      portHost: (r.port_host as string) ?? null,
      pages: r.pages === null ? null : n(r.pages),
      bytes: r.bytes === null ? null : n(r.bytes),
      documentName: (r.document_name as string) ?? null,
    })),
  };
}

/** Per managed printer: what its own counter says vs what PCs reported, over the filter's date range. */
export async function counterComparison(f: AnalyticsFilters): Promise<CounterRow[]> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const d = db();
  const [printers, counters, pc] = await Promise.all([
    d.execute<Record<string, unknown>>(sql`select id, name from printers order by name`),
    d.execute<Record<string, unknown>>(sql`
      select printer_id, to_char(day, 'YYYY-MM-DD') as day, revision, first_count, last_count
      from printer_counter_daily
      where day between ${f.from}::date and ${f.to}::date or day = (
        select max(day) from printer_counter_daily c2 where c2.printer_id = printer_counter_daily.printer_id and c2.day < ${f.from}::date)`),
    d.execute<Record<string, unknown>>(sql`
      select j.printer_id, coalesce(sum(j.pages), 0) pages from print_jobs j
      where ${where({ ...f, printer: null }, tz)} and j.printer_id is not null group by 1`),
  ]);
  const rows: CounterDay[] = counters.map((r) => ({
    printerId: String(r.printer_id),
    day: String(r.day),
    revision: n(r.revision),
    firstCount: n(r.first_count),
    lastCount: n(r.last_count),
  }));
  const totals = counterTotals(rows, f.from, f.to);
  const pcPages = new Map(pc.map((r) => [String(r.printer_id), n(r.pages)]));
  const wanted = f.printer && !f.printer.startsWith("queue:") ? f.printer : null;
  return printers
    .filter((p) => !wanted || String(p.id) === wanted)
    .map((p) => {
      const id = String(p.id);
      const t = totals.get(id) ?? null;
      const pcs = pcPages.get(id) ?? 0;
      return { printerId: id, name: String(p.name), counterPages: t?.pages ?? null, pcPages: pcs, notFromPcs: pagesNotFromPcs(t?.pages ?? null, pcs), counterDays: t?.days ?? 0 };
    })
    .filter((r) => r.counterPages !== null || r.pcPages > 0);
}

/** Queues Spoolfree does not manage, with the host their port points at: candidates for hand-installed printers. */
export async function unmanagedQueues(f: AnalyticsFilters, limit = 50): Promise<UnmanagedQueue[]> {
  const tz = config().ANALYTICS_TIME_ZONE;
  const rows = await db().execute<Record<string, unknown>>(sql`
    select min(j.queue_name) queue_name, j.port_host, count(distinct j.computer_guid) computers, count(*) jobs,
           coalesce(sum(j.pages), 0) pages, max(j.printed_at) last_printed
    from print_jobs j where ${where({ ...f, printer: null }, tz)} and j.printer_id is null
    group by lower(j.queue_name), j.port_host order by 5 desc limit ${limit}`);
  return rows.map((r) => ({
    queueName: String(r.queue_name),
    portHost: (r.port_host as string) ?? null,
    computers: n(r.computers),
    jobs: n(r.jobs),
    pages: n(r.pages),
    lastPrinted: new Date(r.last_printed as string).toISOString(),
  }));
}

/** Filter choices: users, PCs, printers/queues and OUs seen in the range. */
export async function filterOptions(f: AnalyticsFilters) {
  const tz = config().ANALYTICS_TIME_ZONE;
  const base = { ...f, user: null, printer: null, ou: null, computer: null, q: null };
  const w = where(base, tz);
  const [users, computers, printers, ous] = await Promise.all([
    db().execute<Record<string, unknown>>(sql`select distinct j.user_name v from print_jobs j where ${w} and j.user_name is not null order by 1 limit 500`),
    db().execute<Record<string, unknown>>(sql`select distinct j.computer_name v from print_jobs j where ${w} order by 1 limit 500`),
    db().execute<Record<string, unknown>>(sql`
      select distinct coalesce(j.printer_id::text, 'queue:' || j.queue_name) v, coalesce(p.name, j.queue_name || ' (unmanaged)') label
      from print_jobs j left join printers p on p.id = j.printer_id where ${w} order by 2 limit 500`),
    db().execute<Record<string, unknown>>(sql`select distinct j.ou_dn v from print_jobs j where ${w} and j.ou_dn is not null order by 1 limit 500`),
  ]);
  return {
    users: users.map((r) => String(r.v)),
    computers: computers.map((r) => String(r.v)),
    printers: printers.map((r) => ({ value: String(r.v), label: String(r.label) })),
    ous: ous.map((r) => String(r.v)),
  };
}

/** Deletes print jobs and counter readings older than ANALYTICS_RETENTION_DAYS. */
export async function purgeAnalytics(now = new Date()): Promise<{ jobs: number; counters: number }> {
  const days = config().ANALYTICS_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const d = db();
  const jobs = await d.execute(sql`delete from print_jobs where printed_at < ${cutoff.toISOString()}::timestamptz`);
  const counters = await d.execute(sql`delete from printer_counter_daily where day < ${cutoff.toISOString().slice(0, 10)}::date`);
  return { jobs: (jobs as unknown as { count?: number }).count ?? 0, counters: (counters as unknown as { count?: number }).count ?? 0 };
}
