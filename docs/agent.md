# Windows agent

The agent is a set of Windows PowerShell 5.1 scripts in [`agent/`](../agent). A GPO startup script installs it; a SYSTEM scheduled task then syncs at startup and every `AGENT_SYNC_INTERVAL_MINUTES`. From 0.4.3 it [updates itself](#self-update) from the server. See [deployment.md](deployment.md#4-gpo-setup-agent) for the rollout.

## How the agent creates queues

| Windows | Method | Notes |
|---|---|---|
| Windows 11 (all), Windows 10 builds whose `Add-Printer` has `-IppURL` | `Add-Printer -IppURL http(s)://printer:631/ipp/print` | **Primary.** Windows picks the Microsoft IPP Class Driver from the printer's IPP attributes. Creates a local, machine-wide queue. The only method reported to keep working with **Windows Protected Print Mode** on. The printer must be reachable when the queue is created; the agent retries at the next sync. |
| Older Windows 10 without `-IppURL` | none (0.7.7) | Reported as an error. Set a vendor driver for the printer (docs/drivers.md); vendor queues work on these PCs. Up to 0.7.6 this was a Standard TCP/IP port with the IPP Class Driver (see below). |

**When `-IppURL` fails** (0.4.6; any error except "already exists"), the agent does not give up on the queue:

1. If the server knows the printer's `printer-uuid`, the agent removes what a removed WSD/IPP queue for that device can
   leave behind:
   - a WSD Port monitor port whose `Printer UUID` is the device and that **no queue uses**;
   - Plug and Play nodes `SWD\DAFWSDProvider\urn:uuid:<uuid>[/...]` and `SWD\IPP\<uuid>` that are **no longer present**
     (`pnputil /remove-device`).

   Nothing that is in use, present, or belongs to another UUID is touched. When something was removed, the agent
   retries `-IppURL` once.
2. Otherwise, when Windows Protected Print Mode is off and takeover replaced a legacy queue whose driver is still
   installed, it creates a Standard TCP/IP queue with that driver (see "already exists" below).
3. Otherwise the error says the printer needs a vendor driver: set one in its Driver setting (docs/drivers.md).
   0.7.7: the agent no longer creates a TCP/IP queue with the IPP Class Driver.

**The IPP Class Driver is never put on a RAW 9100 port (0.7.7).** Up to 0.7.6 the fallback was a Standard TCP/IP port
with the IPP Class Driver. That queue sends the class driver's raster straight to port 9100, which expects PCL,
PostScript or another page language. Printers without PWG raster (for example the Brother HL-2250DN, HL-5350DN and
MFC-7860DW, which take only PJL, PCL and PCL XL, or PostScript) printed it as pages of text. Printers with port 9100
closed printed nothing. From 0.7.7 an agent re-creates such queues that it made itself:

- if the printer has a vendor driver (Driver setting), the vendor queue replaces it as usual;
- otherwise it tries `Add-Printer -IppURL` under a temporary name next to the old queue, then removes the old queue and
  renames the new one (make-before-break), so the queue name and users' default printer stay;
- if that fails, the old queue stays and the PC reports *"needs a vendor driver"* for the printer (Agents page). The
  agent tries again after 24 hours (`MigrateTried` in the queue's marker), because a failing `-IppURL` can take 90
  seconds.

The fix for a printer that keeps reporting this is a vendor driver: upload its exact-model package and set it in the
printer's Driver setting.

Seen in 2026 with Brother lasers (HL-L5100DN, MFC-L5700DN, DCP-L3551CDW and others): `Add-Printer -IppURL` failed after
about 90 seconds with "The specified WSD or IPP print device was not found", on Windows 10 and 11, while the same PCs
added HP and Xerox printers in a few seconds. An *Internet Port* (`printui /if /r http://printer:631/ipp/print`) with
the IPP Class Driver was tried as another fallback and dropped: the queue is created, but the class driver cannot
read the device's capabilities there, and `Set-Printer` and `Set-PrintConfiguration` hang or fail on it.

Seen on Windows 11 21H2 (build 22000): after takeover removed the PC's WSD queue for the device, `Add-Printer -IppURL`
kept failing with "The specified WSD or IPP print device was not found". The same flow worked on 24H2.

**"The specified printer already exists" after takeover** (0.6.2). Some printers (seen on HP LaserJet Pro / MFP models
on Windows 11 25H2) use their WS-Discovery endpoint UUID as IPP `printer-uuid`. Windows keeps the WSD device
association (`HKLM\SYSTEM\CurrentControlSet\Services\DeviceAssociationService\State\Store\DAFWSDProvider#urn:uuid:<uuid>`)
after the WSD queue and its Plug and Play nodes are gone, and `Add-Printer -IppURL` then fails with "already exists"
although no queue has that name. Before 0.6.2 the agent treated that as a name clash and stopped, so a PC whose legacy
queue takeover had just removed was left without the printer. From 0.6.2, when the name is free and takeover is **on**
for the printer or already removed a legacy queue for it on this PC, the agent:

1. looks again for any queue that holds the device (also one Windows set up again by itself right after the removal),
   removes it and retries `-IppURL`; the removal is reported in `legacy` like any takeover;
2. if no queue holds the device, clears the stale association: the store entry (backed up to
   `%ProgramData%\Spoolfree\Backup\daf-*.reg`), the device's `SWD\DAFWSDProvider\urn:uuid:<uuid>` nodes, then restarts
   the Device Association service, and retries `-IppURL`. Nothing is touched while a queue still uses a WSD/IPP port of
   the device;
3. as a last resort (WPP off) creates a Standard TCP/IP queue with the **driver of the legacy queue it replaced** when
   that driver is still installed (remembered in `HKLM:\SOFTWARE\Spoolfree\LegacyDrivers`). Up to 0.7.6 it otherwise
   used the Microsoft IPP Class Driver on that port; from 0.7.7 the error says the printer needs a vendor driver.

In dry-run nothing changes: the error still names the blocking queue. Queue names are matched literally from 0.6.2
(`Get-Printer -Name` / `Remove-Printer -Name` treat `[ ]` as wildcards, so a queue such as
`HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]` was reported as removed while Windows kept it).

**Windows automatic printer setup.** "Set up network connected devices automatically" (NcdAutoSetup) only acts on
networks with the Private profile, not on domain networks, and needs the Function Discovery services. It was not the
cause of the "already exists" failures above. If Windows does re-create a queue for a managed printer, step 1 removes
it. Should that happen again and again (PCs on Private-profile networks), turn automatic setup off with a GPP Registry
item `HKLM\SOFTWARE\Policies\Microsoft\Windows\NcdAutoSetup\Private` `AutoSetup` = `0` (DWORD).

**HP software prompts.** Windows Update can install HP extension drivers for an HP IPP queue
(`euthenia_extensioninf_x64.inf`, extension id `{DFC94AE1-91F8-4F6E-BDF2-157543A2109A}`) that add the software component
`SWC\HP_Device_DeployAgent` (`da_componentinf_x64.inf`). That component's `AddSoftware` runs
`HP.DeviceSetupLauncher.exe` in the user's session, which asks non-admins for UAC. To block it, use *Computer
Configuration > Administrative Templates > System > Device Installation > Device Installation Restrictions >
Prevent installation of devices that match any of these device IDs* with `SWC\HP_Device_DeployAgent` (and "Also apply
to matching devices that are already installed" to remove it from PCs that have it). Printing does not depend on it.

**PC left without a printer.** Takeover may have removed a legacy queue for a printer, in this or an earlier sync, while
the Spoolfree queue for that printer still does not exist. Every sync then reports it in the report's `critical` field:
`PC left without printer <name>: legacy queue(s) '<queue>' were removed and the Spoolfree queue could not be created
(<error>)`. The Agents view shows a red alert at the top until it is fixed. The agent does not re-create the removed
queue.

The agent checks whether `-IppURL` is available at runtime: `(Get-Command Add-Printer).Parameters.ContainsKey('IppURL')`.

### Vendor-driver queues (0.7)

For a printer that is in driver mode **vendor**, or that auto mode resolves to vendor, the agent first checks the
package against the signed manifest's SHA-256 and the catalog's Authenticode signature. It then installs the signed
driver package (`pnputil /add-driver /install`, `Add-PrinterDriver`) and creates the queue on a Standard TCP/IP port:
RAW 9100 by default, or LPR or IPP.

A switch between driverless and vendor creates the new queue first (make-before-break), so the PC is never left
without the printer. Under Windows Protected Print Mode vendor drivers are not allowed, and the queue stays driverless.

Details: [docs/drivers.md](drivers.md#what-the-agent-does-agents-07).

## Which queues it touches

It only changes queues it created. Each one is recorded under `HKLM:\SOFTWARE\Spoolfree\Printers` and carries a `Managed by Spoolfree [...]` comment.

- A queue with the same name that someone else created is reported as a conflict and left alone.
- A queue whose comment was changed is not deleted.
- The one exception is legacy queue takeover, below, which is set per printer.

## Legacy queue takeover

For moving PCs off an old print server or hand-installed queues, so users do not see the same printer twice. It is set
per printer: **off**, **dry-run** or **on**. From 0.7.6 a printer added in the web UI starts with **on**
(`DEFAULT_LEGACY_TAKEOVER=on|dry-run|off` changes that); edits keep the stored value, and the bulk CLI still uses
**off** unless the file sets `legacyTakeover`. In the printer form the setting, the legacy host names and (only when a
printer already has some) the print-server share names are in the collapsed **Advanced (migration)** section. Share
names for new printers are set with the bulk CLI (`legacyShares`).

**What counts as the same printer.** The agent matches non-Spoolfree queues against the printer's host name, its
resolved IP addresses and, from 0.4.2, the device identity the server sends in the manifest (`deviceUuid`: the IPP
`printer-uuid`; `macAddresses`):

- a Standard TCP/IP port whose host address, or what it resolves to, is the printer's;
- an IPP or URL port (`http`, `https`, `ipp`, `ipps`) for the same host;
- a WSD port, or an IPP port of the WSD port monitor (what `Add-Printer -IppURL` and Windows' own IPP discovery
  create), when either
  - the device UUID the port stores (`HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\WSD Port\Ports\<port>`,
    value `Printer UUID`) is the printer's `printer-uuid`, or
  - the address Plug and Play recorded for that device UUID is the printer's: `LocationInformation` and the PnP-X
    address/URL properties of `SWD\DAFWSDProvider\*` and `SWD\IPP\*` devices (registry and `Get-PnpDeviceProperty`).
    A device's UUIDs are taken from its instance id and container id only; its addresses are compared as found
    (IP literals and URL hosts), without DNS lookups.

  A WSD port whose device cannot be identified either way is left alone. From 0.4.5, when the server knows the
  printer's `printer-uuid`, a WSD port that stores a **different** device UUID is never matched by address: Plug and
  Play can keep an old address for a device after DHCP gave that IP to another printer;
- a TCP/IP or IPP port whose host name is a default name that embeds one of the printer's MAC addresses: `BRN<mac>`,
  `BRW<mac>` (Brother wired/wireless) or the bare MAC, 12 hex digits, any case, optionally ending in `.local`. These names
  are often not in DNS. Nothing else matches: no other prefixes or suffixes, no other domains, no partial MACs;
- (0.5.0) a Standard TCP/IP port, or an IPP/URL port, whose host is one of the printer's **legacy host names /
  aliases** (`legacyAliases` in the manifest; "Legacy hostnames / aliases" in the printer form; `legacyAliases` or the
  `aliases` column in the bulk CLI). They are compared case-insensitively, with a trailing dot and `.local` ignored on
  both sides. Use this for old names that are no longer in DNS and carry no MAC, such as a NetBIOS-style name like
  `OLD-PRN-OFFICE2`. WSD ports are never matched by alias;
- a `\\server\share` connection, when the server is one of the configured legacy print servers (a short name and an FQDN are treated as equal) and the share is listed for the printer.

**Where the identity comes from.** **Test** in the UI and the status poller (once a day per printer, while it is
online) read the printer's IPP `printer-uuid` and its SNMP `ifPhysAddress` values (IF-MIB, community
`SNMP_COMMUNITY`). For Brother models the MAC is also taken from the node field of the version-1 `printer-uuid`
(`e3248000-80ce-11db-8000-<mac>`). Failed reads keep the stored values; zero, broadcast and multicast MACs are ignored.
Changing a printer's host, port, path or TLS (edit, **Replace** or the bulk CLI) clears the identity until it is read
again. Until the server knows the identity, only address matching applies, so run **Test** after adding a printer.

**Queues of another Spoolfree server.** From 0.4.2 a queue's comment names the server that created it:
`Managed by Spoolfree [<printer id> rev <n> server <server id>]`, where the server id is the first 16 hex digits of the
SHA-256 of the pinned manifest public key (the `keyId` the server shows). The agent rewrites older comments of its own
queues to this form at the next sync. A queue with a Spoolfree comment counts as legacy, and can be taken over like any
other queue for the same device, only when it belongs to a **different** server:

- its comment names another server id; or
- its comment has no server id (agents before 0.4.2) and its printer id is not one of this server's printers (the
  manifest lists them all in `serverPrinterIds`).

Queues of this server are never legacy: a queue with this server's id, with a printer id this server knows, or with an
unreadable comment is left alone, and so is everything when the agent has no pinned key. Another server's queue with
the printer's own name is taken over too; a hand-made queue with that name is still reported as a conflict.

**Never touched:**

- USB, LPT, COM, FILE and Terminal Services ports;
- virtual queues: PDF, OneNote, XPS Document Writer, Fax, Evernote and "Microsoft Print to ...";
- queues for other devices;
- queues whose device cannot be identified;
- Spoolfree's own queues.

**Order.** Matching queues are removed before the Spoolfree queue is created, because Windows allows only one WSD/IPP queue per device.

**Blocked queue creation.** When creating or re-creating a queue fails with "printer already exists" or "WSD or IPP
print device was not found", the agent looks for a queue that holds the device, using the rules above whatever the
printer's takeover mode, and reports it, e.g. `Finance Laser: Add blocked by existing WSD queue 'Brother (Copy 1)'
(WSD port device uuid ...): enable legacy takeover for this printer (dry-run first, then on) or remove that queue.
Windows said: ...`. In dry-run the hint is to switch takeover on; in on mode, to check the legacy report. Without a
matching queue the original Windows error is reported.

**Dry-run** removes nothing. Each match is reported as `would-remove`, and the Agents view shows it, so you can check the list before switching to **on**.

**Per-user connections.** `\\server\share` connections added by a user are invisible to SYSTEM. The sync task publishes the rules in `HKLM:\SOFTWARE\Spoolfree\Public` (value `Takeover`). The *Spoolfree User Default* logon task then matches the user's own connections at the next logon and removes them in **on** mode. It writes its results to `%ProgramData%\Spoolfree\UserTakeover\<SID>.json`. Users can create files in that folder but cannot read or change other users' files. The next sync report includes the results, with the scope taken from the file's owner.

**Default printer.** If a user's default printer was a removed queue, the logon task makes the replacing Spoolfree queue the default. The machine keeps a map from removed queue to Spoolfree queue for this.

**Manifest fields** (0.4.2): `printers[].deviceUuid` (lower-case UUID or `null`), `printers[].macAddresses` (12 lower-case
hex digits each), `serverPrinterIds` (every printer id on the server). Older agents ignore them.

**Report.** From 0.4.6 the report also has `critical` (strings, see "PC left without a printer" above) and
`fallbacks` (`{ printer, method, reason }` for queues created with the TCP/IP fallback and the replaced queue's
driver).

Each match is recorded in the agent report's `legacy` field: `{ printer, queue, reason, action: removed | would-remove | failed, scope: machine | user:<DOMAIN\user>, error? }`, at most 200 entries. Matches are also written to `sync.log`. `Invoke-SpoolfreeSync.ps1 -WhatIf` removes nothing.

## Sync interval

The server sends `syncIntervalMinutes` (`AGENT_SYNC_INTERVAL_MINUTES`, default 15, 5 to 240) in every manifest. When it
differs from the value the agent applied last (`HKLM:\SOFTWARE\Spoolfree\SyncIntervalMinutes`), the agent rewrites the
"Spoolfree Sync" task's triggers: the startup trigger (2 minutes after boot) stays, and the repeating trigger gets the new
interval with a random delay of about 20% of it (1 to 48 minutes) so PCs spread their calls. The installer's
`-SyncIntervalMinutes` is only the first value; later GPO runs keep the server's value. Changing the interval needs no
GPO change; PCs pick it up at their next sync.

## Self-update

From 0.4.3 the agent updates itself from the server. A new release only needs the server upgraded: no new files on
the share, no re-install.

**Layout on the PC.**

| Path | What |
|---|---|
| `%ProgramFiles%\Spoolfree\Start-SpoolfreeSync.ps1` | Launcher. The "Spoolfree Sync" task runs it. Only the installer (GPO) writes it; a self-update never does. |
| `%ProgramFiles%\Spoolfree\current\` | The running agent: `Spoolfree.Agent.psm1`, `Invoke-SpoolfreeSync.ps1`, `Set-SpoolfreeUserDefault.ps1`, `Install-SpoolfreeAgent.ps1`. |
| `%ProgramFiles%\Spoolfree\previous\` | The version before the last update, kept for rollback. |
| `HKLM:\SOFTWARE\Spoolfree\Update` | Update state: pending version, failures, last result, the hash of a rolled-back bundle. |

The install directory is writable only by SYSTEM and Administrators. Users can read and run the files, because the
*Spoolfree User Default* logon task runs as the user.

**What the server sends.** The image carries the agent scripts in `/app/agent` (`AGENT_BUNDLE_DIR`). The server packs
them into one bundle: a UTF-8 JSON document `{ type: "spoolfree-agent-bundle", format: 1, version, files: [{ name,
sha256, content }] }`, where `content` is base64 and `version` is the one `Spoolfree.Agent.psm1` declares. The server
signs the bundle bytes with the manifest key (Ed25519, a detached signature) and adds these fields to every signed
manifest:

- `agentVersion`
- `agentBundle`: `{ sha256, size, signature }`
- `agentAllowDowngrade` (`AGENT_ALLOW_DOWNGRADE`, default `false`)

`GET /api/agent/bundle` returns the bundle bytes. It needs the machine token, like the manifest. `AGENT_SELF_UPDATE=0`
takes the fields out of the manifest and makes the endpoint answer 404.

**What the agent does.** After it has applied printers, a sync compares `agentVersion` with its own version. It does
nothing when they are equal. It does not update when:

- the offered version is lower and `agentAllowDowngrade` is not `true`;
- the bundle's hash is one that was rolled back on this PC.

Otherwise it downloads the bundle and refuses it unless all of these hold:

- the SHA-256 of the bytes equals `agentBundle.sha256`;
- the Ed25519 signature over the exact bytes verifies with the **pinned** public key;
- the bundle's type, format and version match the offer;
- every file name is one of the four above (no paths);
- every file matches its own hash;
- the module declares the offered version.

It then installs the files in two steps:

1. **Stage.** It writes the files to `staging\`, gives that folder the DACL of `current\`, reads the files back and checks them. It refuses to go on if anyone but SYSTEM, Administrators or TrustedInstaller could write there.
2. **Swap.** It renames `current\` to `previous\` and `staging\` to `current\`. If the second rename fails, it undoes the first.

The new version is now *pending*. It runs at the next sync. The current sync keeps running the old code.

**Rollback.** The launcher runs `current\Invoke-SpoolfreeSync.ps1` in a child process, with a 12-minute limit:

- A pending version confirms itself when one of its syncs verifies a signed manifest. The launcher then clears the
  pending state and the report says `updated`.
- A run that ends without confirmation counts as a failure: a crash, a script error, a rejected manifest or a
  timeout. Exit codes 3 (not enrolled) and 4 (server unreachable) are not counted.
- After two failures, the launcher puts `previous\` back as `current\` and runs the previous version at once.
  It records the failed bundle's hash, so that bundle is never installed again on this PC. A server with a fixed
  build (a new hash) is offered normally.

The launcher also repairs an interrupted swap. If `current\` is missing, it uses `previous\` (or a complete
`staging\`). It forgets a pending version that is not the one in `current\`.

**Report and UI.** The report's `agentVersion` and `update` field (`{ state: current | pending | updated |
rolled-back | failed | skipped, target, error, at }`) show on **Agents**. An agent older than the server's bundle is
marked **Outdated**. The deployment card shows the bundle version, its hash, and whether self-update is on.

**GPO installer and self-update together.** The startup script still runs at every boot. It installs the share's
version only when it is newer than the one in `current\` (or with `-Force`). It never replaces a newer version that
the PC installed itself. Upgrading from 0.4.2 or older needs the 0.4.3 files on the share and one installer run. That
run moves the agent into `current\`, installs the launcher, points the task at it and removes the old top-level files.

**Trust.** A self-update is code that runs as SYSTEM, signed with the manifest key. Whoever controls that key, or the
server that holds it, can push code to every PC. See [SECURITY.md](../SECURITY.md).

## Print analytics

From 0.5.0, when the server turns on analytics (`analytics.enabled` in the manifest), each sync does the following:

1. It enables the `Microsoft-Windows-PrintService/Operational` log and makes it at least 20 MB.
2. It reads new event 307 records after a registry bookmark (`HKLM:\SOFTWARE\Spoolfree\Analytics`, `LastRecordId`).
3. It sends them to `/api/agent/jobs` in batches of up to 500. Document names are sent only when
   `analytics.collectDocumentNames` is set.

Failures are logged and never fail the sync. What is collected, retention and privacy:
[analytics.md](analytics.md).

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
