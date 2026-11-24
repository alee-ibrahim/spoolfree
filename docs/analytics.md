# Print analytics

From 0.5.0 Spoolfree can show who printed what, where and how much. The data comes from two sources:

- **PCs.** The agent reads the Windows print log on each PC: `Microsoft-Windows-PrintService/Operational`, event 307
  "document printed".
- **Printers.** The status poller reads each printer's own page counter (IPP `printer-impressions-completed`, or the
  SNMP Printer-MIB `prtMarkerLifeCount`).

Comparing the two shows the pages that never came from a PC: copies, scans printed at the device, USB, direct IP and
mobile printing.

Analytics is **off by default**. Read [Privacy](#privacy) before you turn it on.

## Turning it on

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_ENABLED` | `0` | Agents collect print jobs and the server accepts them at `/api/agent/jobs`. |
| `ANALYTICS_COLLECT_DOCUMENT_NAMES` | `0` | Also collect document names (window titles such as `Budget 2027.xlsx`). Only takes effect together with `ANALYTICS_ENABLED`. |
| `ANALYTICS_RETENTION_DAYS` | `365` | Print jobs and daily counter readings older than this are deleted. The purge runs every hour. |
| `ANALYTICS_TIME_ZONE` | `UTC` | IANA time zone for day buckets, for example `Indian/Maldives`. |

The server sends the two switches in every signed manifest. Agents 0.5.0 and later follow them at their next sync.
Older agents ignore them; they update themselves when [self-update](agent.md#self-update) is on.

Printer page counters are recorded whatever these settings are. They contain no personal data.

## What the agent does

When the manifest says `analytics.enabled`, each sync:

1. **Enables the print log.** If `Microsoft-Windows-PrintService/Operational` is disabled, the agent enables it
   (`wevtutil sl ... /e:true`). If its maximum size is below 20 MB it raises it to 20 MB.
2. **Reads new events.** It reads event 307 records newer than the bookmark (the last event record id sent, in
   `HKLM:\SOFTWARE\Spoolfree\Analytics`, value `LastRecordId`), oldest first, at most 2000 per sync. If the log was
   cleared, the bookmark starts again from 0.
3. **Builds one record per event.** Each record has the time, the user (the event's SID translated to `DOMAIN\name`),
   the client computer, the queue name, the port and its host, the pages, the size in bytes and, only when document
   names are on, the document name.
4. **Maps the queue.** A queue that is a Spoolfree printer is linked to it. Other queues are kept with the host their
   port points at, which helps find hand-installed printers.
5. **Sends batches.** It posts batches of up to 500 records to `/api/agent/jobs`. The bookmark moves only after the
   server accepted a batch. The server drops duplicates (same PC, event record id and time), so a resent batch is
   harmless.

The sync report carries `analytics: { enabled, logEnabled, sent, error }`. Analytics never makes a sync fail.

**Shared queues.** Windows logs event 307 on the computer whose spooler renders the job. A PC that prints through a
`\\server\share` connection logs nothing locally; the print server's own log has those events. Spoolfree's queues are
local queues, so their jobs are logged on the PC.

## The Analytics page

- **Filters.** A date range (presets or a custom range) and filters for user, printer, OU, PC and the job log's source,
  in one row above everything they scope. They are part of the URL, so a view can be bookmarked or shared.
- **Totals.** PC jobs, pages from PCs, active users and printers used.
- **Charts.** Pages per day, then the top users, top PCs, top printers and pages by OU (the PC's OU when the job was
  received), each with a table view.
- **Printer counters and PC jobs.** For each printer, the pages its own counter advanced in the range, split into pages
  PCs reported and the rest. A counter that goes backwards, or a replaced device (a new revision), restarts that day's
  count, so a swap never shows a negative or huge number.
- **Queues Spoolfree does not manage.** Unmanaged queues with their port host, PC count and pages.
- **Job log.** PC jobs and printer jobs (below) in one list, newest first, 25 per page, with a Source column (PC or
  Printer). Document names appear only when they are collected.
- **CSV export** of the job log for the current filters (at most 100,000 rows), with `source` (`PC` or `Printer`) and
  `state` columns at the end. Cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets do not
  run them as formulas.

## Printer jobs in the job log

The job log reads only Spoolfree's own tables, so opening it sends nothing to any printer. It has two sources:

- **PC** jobs from `print_jobs` (the agent reports above). Event 307 is logged when a job is done, so these are always
  completed. Without `ANALYTICS_ENABLED` there are none.
- **Printer** jobs from `printer_jobs`: each printer's own list of completed jobs, read by the status poller
  (`PRINTER_JOBS_POLL`, on by default). These include jobs that never passed through a Windows PC: copies, USB, mobile
  and direct-IP printing. They show the user as the printer reports it (devices may leave it empty or anonymise it),
  pages and state (completed, canceled, aborted); no PC, OU or queue. Their time is the printer's completion time
  (else creation time, else when the poller first saw the job).

A printer job that is the printer's copy of a PC job (same printer, same user name without the domain, within 5
minutes) is not listed, so a job printed from a PC appears once, as a PC job.

How the filters apply to printer jobs:

- **Date range, printer and search** (user or document name) apply to both sources.
- **User** matches printer jobs without the domain: `EXAMPLE\alice` also finds printer jobs by `alice`. The user and
  printer choices include the users and printers of printer jobs in the range.
- **PC, OU and unmanaged queue** filters show PC jobs only (printer jobs have none of these).
- **Source** shows PC jobs, printer jobs or both. The "N of M jobs" count and the pages cover both sources.

**Totals and charts stay PC-only.** The totals, pages over time, top users, PCs, printers and OUs, and unmanaged queues
count PC jobs only, as before. Printer jobs are not added there: many are the printer's copy of a PC job, matched only
by a 5-minute heuristic, and printers keep only their last 20 jobs per poll, so adding them would double-count or
under-count pages. Pages that did not come from PCs are already measured exactly by **Printer counters and PC jobs**
(from the page counters), and each such job is listed in the job log.

**With `ANALYTICS_ENABLED` off** the Analytics page still shows the job log (it was never hidden), so printer jobs are
listed there; the totals and charts are empty, and the notice at the top says the job log still lists printer jobs.
Test prints from the admin UI are not in the job log: they are listed under "Recent test prints" in the test print dialog.

### Printer job list: what the poller sends

Inside the existing status poll (no new timer, port, host or dependency; same IPP URI and `POLL_TIMEOUT_MS`), for each
printer that answered the status request over IPP in that cycle:

- **One IPP Get-Jobs** per printer per cycle (`POLL_INTERVAL_SECONDS`, default 120): `which-jobs=completed`, `limit=20`,
  `requested-attributes` `job-id`, `job-originating-user-name`, `job-state`, `job-impressions-completed`,
  `time-at-creation`, `time-at-completed`, plus `job-name` only when `ANALYTICS_COLLECT_DOCUMENT_NAMES` is on.
  Not-completed jobs are not read: that would need a second request; the Queue column counts them and they are listed
  once they complete.
- About 0.4 KB sent and at most about 4.5 KB received (20 jobs of roughly 200 bytes), plus HTTP headers.
- The status request itself also asks for `printer-up-time` (a few bytes more), used to turn the printer's job times
  into clock times.
- Offline printers and printers reached only over SNMP are skipped. A device that refuses Get-Jobs (IPP operation not
  supported or not authorised, HTTP 4xx) is remembered and never asked again; a new endpoint or a replaced device is
  asked once more. Timeouts are not remembered.
- Auto driver mode's speed check (`DRIVER_AUTO_SPEED_INTERVAL_MINUTES`) uses the same request when it is due instead
  of sending its own Get-Jobs.

| Variable | Default | Meaning |
|---|---|---|
| `PRINTER_JOBS_POLL` | `1` | `0` turns the printer job list off: no Get-Jobs from the status poll. |
| `PRINTER_JOBS_RETENTION_DAYS` | `30` | Printer jobs older than this are deleted (hourly purge). Each printer also keeps at most 1000 rows. |

`ANALYTICS_RETENTION_DAYS` bounds the PC jobs.

## Privacy

Print logs are personal data. They say who printed, when, from which PC, how much and, with document names on, what.
The printer job list holds the user names printers report (and document names only when they are collected), so it
is personal data too, even with `ANALYTICS_ENABLED` off; turn it off with `PRINTER_JOBS_POLL=0`, or clear it with
`psql -c "truncate printer_jobs"`.
Before you turn analytics on:

- **Tell staff** that printing is logged, what is kept and for how long. Follow your organisation's rules and local
  law, and record why you need it, for example cost allocation or finding unmanaged printers.
- **Keep document names off** unless you need them. Titles can contain names, case numbers or confidential subjects.
  With `ANALYTICS_COLLECT_DOCUMENT_NAMES=0` agents never send them, and the server drops any it receives anyway.
- **Choose the shortest retention** that serves the purpose (`ANALYTICS_RETENTION_DAYS`). Deleted rows are gone from
  Spoolfree's database; database backups keep them until the backups expire.
- **Access.** Only Spoolfree administrators can see the page and download the CSV. An exported CSV is outside
  Spoolfree's retention, so handle it like any other personal data export.

**What is never collected:** document contents, page images, file paths and print settings.

**To turn it off:** set `ANALYTICS_ENABLED=0`. Agents stop at their next sync and the server refuses new jobs. Stored
jobs stay until retention removes them. To remove them at once:
`psql -c "truncate print_jobs"`. Agents leave the PrintService log enabled; disable it with
`wevtutil sl Microsoft-Windows-PrintService/Operational /e:false` (for example from a GPO) if you want that too.
