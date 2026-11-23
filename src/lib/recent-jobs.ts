import { sql, type SQL } from "drizzle-orm";
import { TEST_PRINT_STATES } from "./db/schema";
import { countActive, likeEscape, one, oneOf, pageNumber, words, type SearchParams } from "./list-filters/params";

/*
 * Recent jobs across all printers, built only from what Spoolfree already stores (opening the page asks no printer):
 *  - print_jobs: documents PCs printed (agent analytics, PrintService event 307; needs ANALYTICS_ENABLED), always "printed";
 *  - test_prints: test pages sent from the admin UI, with their full state;
 *  - printer_jobs: the printers' own completed-job lists, read by the status poller (PRINTER_JOBS_POLL). These include
 *    copies, USB, mobile and direct-IP jobs. A printer job that is clearly the same as a PC job (same printer, same
 *    user, finished within PC_MATCH_MINUTES) or a direct test print (same printer and job id) is not listed twice.
 * Pure SQL builders and parsers, so they are unit-tested against PGlite.
 */

export const JOB_SOURCES = ["pc", "printer", "test"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];
/** Every state a row can have: PC jobs are always "printed"; test prints use the test-print states; printer jobs add "canceled". */
export const JOB_STATES = [...TEST_PRINT_STATES, "canceled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface RecentJobFilters {
  /** A Spoolfree printer id, or "queue:<name>" for a queue Spoolfree does not manage. */
  printer: string | null;
  state: JobState | null;
  source: JobSource | null;
  /** Every word must appear in the user, PC, document name or printer name. */
  q: string | null;
  page: number;
}

export interface RecentJob {
  source: JobSource;
  id: string;
  printer: string;
  printerId: string | null;
  /** Document name (PC jobs, only when document names are collected) or "Test page". */
  name: string | null;
  /** PC jobs: the Windows event record id. Test prints and printer jobs: the printer's or spooler's job id. */
  jobRef: string | null;
  owner: string | null;
  computer: string | null;
  state: JobState;
  pages: number | null;
  submittedAt: string | null;
  completedAt: string | null;
  /** Sort key: completion time for PC and printer jobs, submission time for test prints. */
  at: string;
  message: string | null;
}

export function parseRecentJobFilters(sp: SearchParams): RecentJobFilters {
  return {
    printer: one(sp, "printer", 512),
    state: oneOf(sp, "state", JOB_STATES),
    source: oneOf(sp, "source", JOB_SOURCES),
    q: one(sp, "q", 200),
    page: pageNumber(sp),
  };
}

export const activeRecentJobFilters = (f: RecentJobFilters) => countActive({ printer: f.printer, state: f.state, source: f.source });

/** A printer job this close to a PC job of the same user on the same printer is taken to be that job. */
export const PC_MATCH_MINUTES = 5;
const PC_WINDOW = sql.raw(`interval '${PC_MATCH_MINUTES} minutes'`);

/** DOMAIN\name, name@domain and name compare equal (lower case). */
const bareUser = (col: SQL) => sql`lower(regexp_replace(regexp_replace(${col}, '^.*\\\\', ''), '@.*$', ''))`;

/** All sources as one relation (alias r), newest first by "at". */
const UNION = sql`(
  select 'pc' as source, j.id::text as id, coalesce(j.printer_id::text, 'queue:' || j.queue_name) as printer_key,
         coalesce(p.name, j.queue_name) as printer, j.printer_id::text as printer_id, j.document_name as name,
         j.record_id::text as job_ref, j.user_name as owner, j.computer_name as computer, 'printed' as state, j.pages,
         null::timestamptz as submitted_at, j.printed_at as completed_at, j.printed_at as at, null::text as message
  from print_jobs j left join printers p on p.id = j.printer_id
  union all
  select 'test', t.id::text, t.printer_id::text, coalesce(p.name, t.printer_name), t.printer_id::text, 'Test page',
         t.job_id::text, t.requested_by, t.computer_name, t.state, null::integer,
         t.created_at, t.completed_at, t.created_at, coalesce(t.error, t.job_status)
  from test_prints t left join printers p on p.id = t.printer_id
  union all
  select 'printer', x.id::text, x.printer_id::text, p.name, x.printer_id::text, x.name,
         x.job_id::text, x.owner, null::text,
         case x.state when 'completed' then 'printed' when 'canceled' then 'canceled' else 'failed' end, x.pages,
         x.created_at, x.completed_at, coalesce(x.completed_at, x.created_at, x.seen_at), null::text
  from printer_jobs x join printers p on p.id = x.printer_id
  where not exists (
          select 1 from test_prints t
          where t.printer_id = x.printer_id and t.mode = 'direct' and t.job_id = x.job_id
            and abs(extract(epoch from (t.created_at - coalesce(x.created_at, x.completed_at, x.seen_at)))) < 900
        )
    and not (nullif(x.owner, '') is not null and exists (
          select 1 from print_jobs j
          where j.printer_id = x.printer_id
            and j.printed_at between coalesce(x.completed_at, x.seen_at) - ${PC_WINDOW}
                                 and coalesce(x.completed_at, x.seen_at) + ${PC_WINDOW}
            and ${bareUser(sql`j.user_name`)} = ${bareUser(sql`x.owner`)}
        ))
) r`;

function where(f: Omit<RecentJobFilters, "page">): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.printer) parts.push(sql`r.printer_key = ${f.printer}`);
  if (f.state) parts.push(sql`r.state = ${f.state}`);
  if (f.source) parts.push(sql`r.source = ${f.source}`);
  for (const w of words(f.q)) {
    const pat = `%${likeEscape(w)}%`;
    parts.push(sql`(r.owner ilike ${pat} or r.computer ilike ${pat} or r.name ilike ${pat} or r.printer ilike ${pat})`);
  }
  return sql.join(parts, sql` and `);
}

export function recentJobsQuery(f: Omit<RecentJobFilters, "page">, limit: number, offset = 0): SQL {
  return sql`select r.* from ${UNION} where ${where(f)} order by r.at desc, r.source, r.id desc limit ${limit} offset ${offset}`;
}

export function recentJobsCountQuery(f: Omit<RecentJobFilters, "page">): SQL {
  return sql`select count(*) as c from ${UNION} where ${where(f)}`;
}

/** Printer filter choices: printers (and unmanaged queues) that have at least one job, by name. */
export function recentJobPrintersQuery(): SQL {
  return sql`select o.v, o.label from (
               select distinct r.printer_key as v, r.printer || case when r.printer_id is null then ' (unmanaged)' else '' end as label from ${UNION}
             ) o order by lower(o.label), o.label limit 500`;
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export function toRecentJob(r: Record<string, unknown>): RecentJob {
  return {
    source: r.source === "test" ? "test" : r.source === "printer" ? "printer" : "pc",
    id: String(r.id),
    printer: String(r.printer),
    printerId: (r.printer_id as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    jobRef: (r.job_ref as string | null) ?? null,
    owner: (r.owner as string | null) ?? null,
    computer: (r.computer as string | null) ?? null,
    state: (JOB_STATES as readonly string[]).includes(String(r.state)) ? (r.state as JobState) : "unknown",
    pages: r.pages === null || r.pages === undefined ? null : Number(r.pages),
    submittedAt: iso(r.submitted_at),
    completedAt: iso(r.completed_at),
    at: iso(r.at) ?? new Date(0).toISOString(),
    message: (r.message as string | null) ?? null,
  };
}

/** Badge look per state: done, failed, in progress or unknown. */
export function stateTone(s: JobState): "default" | "destructive" | "secondary" | "outline" {
  if (s === "printed") return "default";
  if (s === "failed" || s === "rejected" || s === "expired") return "destructive";
  if (s === "unknown" || s === "canceled") return "outline";
  return "secondary";
}
