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

- **Filters.** A date range (presets or a custom range) and filters for user, printer, OU and PC, in one row above
  everything they scope. They are part of the URL, so a view can be bookmarked or shared.
- **Totals.** Print jobs, pages from PCs, active users and printers used.
- **Charts.** Pages per day, then the top users, top PCs, top printers and pages by OU (the PC's OU when the job was
  received), each with a table view.
- **Printer counters and PC jobs.** For each printer, the pages its own counter advanced in the range, split into pages
  PCs reported and the rest. A counter that goes backwards, or a replaced device (a new revision), restarts that day's
  count, so a swap never shows a negative or huge number.
- **Queues Spoolfree does not manage.** Unmanaged queues with their port host, PC count and pages.
- **Job log.** Newest first, 25 per page. Document names appear only when they are collected.
- **CSV export** of the job log for the current filters (at most 100,000 rows). Cells that start with `=`, `+`, `-` or
  `@` are prefixed with `'` so spreadsheets do not run them as formulas.

## Privacy

Print logs are personal data. They say who printed, when, from which PC, how much and, with document names on, what.
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
