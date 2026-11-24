import { sql, type SQL } from "drizzle-orm";
import { words } from "../list-filters/params";
import { likeEscape, type AnalyticsFilters, type JobLogSource } from "./filters";

/*
 * The Analytics job log: one list from two of Spoolfree's own tables (reading it asks no printer anything):
 *  - "pc": print_jobs, the jobs PCs printed (agent reports of PrintService event 307; needs ANALYTICS_ENABLED);
 *  - "printer": printer_jobs, each printer's own completed-job list read by the status poller (PRINTER_JOBS_POLL).
 *    These include copies, USB, mobile and direct-IP jobs. A printer job that is clearly the printer's copy of a PC job
 *    (same printer, same user without the domain, within PC_MATCH_MINUTES) is not listed.
 * Pure SQL builders, unit-tested against PGlite. Summary, charts and rankings stay PC-only (see queries.ts).
 */

/** A printer job this close to a PC job of the same user on the same printer is taken to be that job. */
export const PC_MATCH_MINUTES = 5;
const PC_WINDOW = sql.raw(`interval '${PC_MATCH_MINUTES} minutes'`);

/** DOMAIN\name, name@domain and name compare equal (lower case). */
const bareUser = (v: SQL) => sql`lower(regexp_replace(regexp_replace(${v}, '^.*\\\\', ''), '@.*$', ''))`;

/** A printer job's time: completion, else creation, else when the poller first saw it. */
const PRINTER_AT = sql`coalesce(x.completed_at, x.created_at, x.seen_at)`;

const range = (at: SQL, f: AnalyticsFilters, tz: string) => [
  sql`${at} >= (${f.from}::date::timestamp at time zone ${tz})`,
  sql`${at} < ((${f.to}::date + 1)::timestamp at time zone ${tz})`,
];

/** WHERE clause for print_jobs j (left-joined printers p) from the filters. The source filter is not applied here. */
export function where(f: AnalyticsFilters, tz: string): SQL {
  const parts: SQL[] = range(sql`j.printed_at`, f, tz);
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

/**
 * WHERE clause for printer_jobs x (joined printers p), or null when the filters rule printer jobs out: they have no
 * PC or OU, and only managed printers are polled (an unmanaged queue filter matches none). The user filter compares
 * names without the domain, since printers usually report "alice" for EXAMPLE\alice.
 */
export function printerJobWhere(f: AnalyticsFilters, tz: string): SQL | null {
  if (f.computer || f.ou || f.printer?.startsWith("queue:")) return null;
  const parts: SQL[] = range(PRINTER_AT, f, tz);
  if (f.user) parts.push(sql`${bareUser(sql`x.owner`)} = ${bareUser(sql`${f.user}::text`)}`);
  if (f.printer) parts.push(sql`x.printer_id::text = ${f.printer}`);
  for (const w of words(f.q)) {
    const pat = `%${likeEscape(w)}%`;
    parts.push(sql`(x.owner ilike ${pat} or x.name ilike ${pat})`);
  }
  return sql.join(parts, sql` and `);
}

/** Hides the printer's own copy of a PC job (same printer, same bare user name, within PC_MATCH_MINUTES). */
const NOT_A_PC_JOB = sql`not (nullif(x.owner, '') is not null and exists (
  select 1 from print_jobs pj
  where pj.printer_id = x.printer_id
    and pj.printed_at between ${PRINTER_AT} - ${PC_WINDOW} and ${PRINTER_AT} + ${PC_WINDOW}
    and ${bareUser(sql`pj.user_name`)} = ${bareUser(sql`x.owner`)}
))`;

/** The job log as one relation (alias r) for the filters; the source filter picks one or both parts. */
function union(f: AnalyticsFilters, tz: string): SQL {
  const parts: SQL[] = [];
  if (f.source !== "printer") {
    parts.push(sql`
      select 'pc' as source, j.id, j.printed_at as at, j.user_name, j.computer_name, j.ou_dn, coalesce(p.name, j.queue_name) as printer,
             j.printer_id, j.queue_name, j.port_host, j.pages, j.bytes, j.document_name, 'completed' as state
      from print_jobs j left join printers p on p.id = j.printer_id
      where ${where(f, tz)}`);
  }
  const pw = f.source === "pc" ? null : printerJobWhere(f, tz);
  if (pw) {
    parts.push(sql`
      select 'printer' as source, x.id, ${PRINTER_AT} as at, nullif(x.owner, '') as user_name, null::text as computer_name, null::text as ou_dn,
             p.name as printer, x.printer_id, null::text as queue_name, null::text as port_host, x.pages, null::bigint as bytes,
             x.name as document_name, x.state
      from printer_jobs x join printers p on p.id = x.printer_id
      where ${pw} and ${NOT_A_PC_JOB}`);
  }
  if (parts.length === 0) parts.push(sql`select null::text as source, null::bigint as id, null::timestamptz as at where false`);
  return sql`(${sql.join(parts, sql` union all `)}) r`;
}

/** One page of the job log, newest first. */
export function jobLogQuery(f: AnalyticsFilters, tz: string, limit: number, offset = 0): SQL {
  return sql`select r.* from ${union(f, tz)} order by r.at desc, r.source, r.id desc limit ${limit} offset ${offset}`;
}

/** How many job log rows match the filters (both sources). */
export function jobLogCountQuery(f: AnalyticsFilters, tz: string): SQL {
  return sql`select count(*) as c from ${union(f, tz)}`;
}

export interface JobLogRow {
  source: JobLogSource;
  id: number;
  /** PC jobs: when the job was printed. Printer jobs: completion (else creation, else first seen). */
  printedAt: string;
  userName: string | null;
  /** PC jobs only. */
  computerName: string | null;
  ouDn: string | null;
  printer: string;
  printerId: string | null;
  /** PC jobs only: the Windows queue name. */
  queueName: string | null;
  portHost: string | null;
  pages: number | null;
  bytes: number | null;
  documentName: string | null;
  /** IPP job state: PC jobs are always "completed"; printer jobs may also be "canceled" or "aborted". */
  state: string;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function toJobLogRow(r: Record<string, unknown>): JobLogRow {
  return {
    source: r.source === "printer" ? "printer" : "pc",
    id: Number(r.id),
    printedAt: new Date(r.at as string).toISOString(),
    userName: str(r.user_name),
    computerName: str(r.computer_name),
    ouDn: str(r.ou_dn),
    printer: String(r.printer),
    printerId: str(r.printer_id),
    queueName: str(r.queue_name),
    portHost: str(r.port_host),
    pages: num(r.pages),
    bytes: num(r.bytes),
    documentName: str(r.document_name),
    state: String(r.state ?? "completed"),
  };
}

/** Filter choices from printer jobs in the range: their users and printers (merged with the PC ones by the caller). */
export function printerJobOptionsQuery(f: AnalyticsFilters, tz: string, what: "users" | "printers"): SQL {
  const w = sql.join(range(PRINTER_AT, f, tz), sql` and `);
  return what === "users"
    ? sql`select distinct x.owner v from printer_jobs x where ${w} and nullif(x.owner, '') is not null order by 1 limit 500`
    : sql`select distinct x.printer_id::text v, p.name label from printer_jobs x join printers p on p.id = x.printer_id where ${w} order by 2 limit 500`;
}
