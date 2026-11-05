# Windows agent

The agent is a set of Windows PowerShell 5.1 scripts in [`agent/`](../agent). A GPO startup script installs it; a SYSTEM scheduled task then syncs at startup and every `AGENT_SYNC_INTERVAL_MINUTES`. See [deployment.md](deployment.md#4-gpo-setup-agent) for the rollout.

## How the agent creates queues

| Windows | Method | Notes |
|---|---|---|
| Windows 11 (all), Windows 10 builds whose `Add-Printer` has `-IppURL` | `Add-Printer -IppURL http(s)://printer:631/ipp/print` | **Primary.** Windows picks the Microsoft IPP Class Driver from the printer's IPP attributes. Creates a local, machine-wide queue. The only method reported to keep working with **Windows Protected Print Mode** on. The printer must be reachable when the queue is created; the agent retries at the next sync. |
| Older Windows 10 without `-IppURL`, WPP off | `Add-PrinterPort` (Standard TCP/IP) + `Add-Printer -DriverName "Microsoft IPP Class Driver"` | **Fallback.** Not WPP-compatible. Whether the class driver's output prints correctly over a raw TCP port depends on the printer model, so test it first. |
| No `-IppURL` and WPP on | none | Reported as an error. |

The agent checks whether `-IppURL` is available at runtime: `(Get-Command Add-Printer).Parameters.ContainsKey('IppURL')`.

## Which queues it touches

It only changes queues it created. Each one is recorded under `HKLM:\SOFTWARE\Spoolfree\Printers` and carries a `Managed by Spoolfree [...]` comment.

- A queue with the same name that someone else created is reported as a conflict and left alone.
- A queue whose comment was changed is not deleted.
- The one exception is legacy queue takeover, below, which is opt-in per printer.

## Legacy queue takeover

For moving PCs off an old print server or hand-installed queues. It is set per printer: **off** (the default), **dry-run** or **on**.

**What counts as the same printer.** The agent matches non-Spoolfree queues against the printer's host name and its resolved IP addresses:

- a Standard TCP/IP port whose host address, or what it resolves to, is the printer's;
- an IPP or URL port (`http`, `https`, `ipp`, `ipps`) for the same host;
- a WSD port, but only when the device's address can be read from the WSD port's registry data. Otherwise it is left alone;
- a `\\server\share` connection, when the server is one of the configured legacy print servers (a short name and an FQDN are treated as equal) and the share is listed for the printer.

**Never touched:**

- USB, LPT, COM, FILE and Terminal Services ports;
- virtual queues: PDF, OneNote, XPS Document Writer, Fax, Evernote and "Microsoft Print to ...";
- queues for other devices;
- queues whose device cannot be identified;
- Spoolfree's own queues.

**Order.** Matching queues are removed before the Spoolfree queue is created, because Windows allows only one IPP queue per device.

**Dry-run** removes nothing. Each match is reported as `would-remove`, and the Agents view shows it, so you can check the list before switching to **on**.

**Per-user connections.** `\\server\share` connections added by a user are invisible to SYSTEM. The sync task publishes the rules in `HKLM:\SOFTWARE\Spoolfree\Public` (value `Takeover`). The *Spoolfree User Default* logon task then matches the user's own connections at the next logon and removes them in **on** mode. It writes its results to `%ProgramData%\Spoolfree\UserTakeover\<SID>.json`. Users can create files in that folder but cannot read or change other users' files. The next sync report includes the results, with the scope taken from the file's owner.

**Default printer.** If a user's default printer was a removed queue, the logon task makes the replacing Spoolfree queue the default. The machine keeps a map from removed queue to Spoolfree queue for this.

**Report.** Each match is recorded in the agent report's `legacy` field: `{ printer, queue, reason, action: removed | would-remove | failed, scope: machine | user:<DOMAIN\user>, error? }`, at most 200 entries. Matches are also written to `sync.log`. `Invoke-SpoolfreeSync.ps1 -WhatIf` removes nothing.

## Sync interval

The server sends `syncIntervalMinutes` (`AGENT_SYNC_INTERVAL_MINUTES`, default 15, 5 to 240) in every manifest. When it
differs from the value the agent applied last (`HKLM:\SOFTWARE\Spoolfree\SyncIntervalMinutes`), the agent rewrites the
"Spoolfree Sync" task's triggers: the startup trigger (2 minutes after boot) stays, and the repeating trigger gets the new
interval with a random delay of about 20% of it (1 to 48 minutes) so PCs spread their calls. The installer's
`-SyncIntervalMinutes` is only the first value; later GPO runs keep the server's value. Changing the interval needs no
GPO change; PCs pick it up at their next sync.

## Default printer after a rename or replace

Renaming a printer or using **Replace** removes the queue and creates it again, and Windows then drops it as the default
for users who had it. The sync publishes which queues it re-created (old name → new name, with the time) in
`HKLM:\SOFTWARE\Spoolfree\Public` (`Takeover.recreated`). The logon task records each user's default at every logon;
at the next logon, if that queue was re-created since, the new queue becomes the user's default again. A default the user
chose after the re-creation is left alone. Users who stay logged on get it back at their next logon.

## Default duplex

A printer's **Default duplex** (`defaultSides` in the manifest: `auto`, `one-sided`, `two-sided-long-edge`,
`two-sided-short-edge`) is applied with `Set-PrintConfiguration -DuplexingMode OneSided|TwoSidedLongEdge|TwoSidedShortEdge`
after the queue exists. The applied value is stored in the queue's registry marker (`Sides`), so it is set again only
when the manifest value changes or the queue is re-created (a *Replace*). `auto` never touches the queue. The report
carries `sides` (queue name → value in effect; `failed:<value>` when Windows refused it, retried at the next sync).

What to expect from the **Microsoft IPP Class Driver**:

- Windows builds the queue's print capabilities from the printer's IPP attributes when the queue is created, including
  `sides-supported`. A printer that advertises `two-sided-long-edge`/`two-sided-short-edge` gets the duplex options in
  the print dialog ("Print on both sides", flip on long/short edge); one that advertises only `one-sided` does not, and
  `Set-PrintConfiguration -DuplexingMode TwoSided…` then fails. Check the printer's `sides-supported` with **Test** in
  the UI before you pick a mode; the form warns when the mode is not advertised.
- **Capability refresh:** if the printer was off or unreachable when the queue was created, Windows may have stored
  generic capabilities without duplex, and the duplex default fails until the capabilities are refreshed. Re-creating
  the queue fixes it: use **Replace** on the printer (same device is fine), or remove the queue on the PC; the agent
  re-creates it at the next sync and applies the duplex default again.
- `Set-PrintConfiguration` sets the **queue default** (all users). A user who saved their own printing preferences for
  that queue keeps them; new users and users without saved preferences get the default.
- Applications can still override duplex per job in their own print dialog.

The duplex behaviour above follows Microsoft's documentation of the IPP Class Driver and `Set-PrintConfiguration`; it was
not yet verified on every printer model, so pilot a mode on one OU first and check **Agents** for `failed:` values.

## Default printer

Windows keeps the default printer per user. The agent records the policy default, and the *Spoolfree User Default* logon task applies it. That task only acts when the policy value changes, so a user's own choice is kept until then.

## Real-device findings

`Add-Printer -IppURL` has been tested as SYSTEM on one Windows 11 25H2 PC (build 26200, WPP off) against an AirPrint printer over plain IPP:

- The queue gets the Microsoft IPP Class Driver and a port named `WSD-<guid>` (description "IPP Port"), which Windows removes together with the queue.
- Windows allows only one IPP queue per device, so the agent removes a renamed queue before it adds the new one.
- Still untested: Windows 10 22H2, WPP on, and IPPS queues (including whether they need the "same security settings for all users" option).
- On laptops in Modern Standby, Task Scheduler holds the sync task as "Queued" until the device wakes, so changes are applied at the next wake rather than on the hour.
