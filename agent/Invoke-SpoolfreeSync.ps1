#Requires -Version 5.1
<#
.SYNOPSIS
    Spoolfree sync: downloads this computer's signed printer manifest,
    verifies it, reconciles driverless IPP queues and reports back.

.DESCRIPTION
    Runs as SYSTEM from the "Spoolfree Sync" scheduled task (at startup and
    every AGENT_SYNC_INTERVAL_MINUTES), started by Start-SpoolfreeSync.ps1. Only queues this agent created (registry marker under
    HKLM:\SOFTWARE\Spoolfree\Printers plus a "Managed by Spoolfree" comment)
    are ever modified or removed.

.PARAMETER WhatIf
    Show the plan without changing printers.

.PARAMETER CommandsOnly
    (0.8) Only fetch and run pending commands (test prints) from /api/agent/commands. The "Spoolfree Commands" task
    runs this every AGENT_COMMAND_POLL_MINUTES. 0.8.1: it is cheap when nothing is pending: it reads the configuration
    from the registry and makes one GET, without loading the agent module and without any AD lookup (the objectGUID is
    cached in the registry). It logs to commands.log, and a PC that cannot reach the server (an off-network laptop)
    logs that at most once an hour and still exits 0.

.PARAMETER TestPageJob
    (0.8.1) Internal: run by the one-off "Spoolfree Test Page" task in the logged-on user's session. Prints the test
    page described by the job file and writes the result next to it.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$CommandsOnly,
    [string]$TestPageJob,
    # Tests only: the configuration key and the log folder.
    [string]$ConfigKey = 'HKLM:\SOFTWARE\Spoolfree',
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'
if (-not $LogDir) { $LogDir = Join-Path $env:ProgramData 'Spoolfree\Logs' }

# Test page as the logged-on user (0.8.1): no logs, no configuration (the user can read neither).
if ($TestPageJob) {
    Import-Module (Join-Path $PSScriptRoot 'Spoolfree.Agent.psm1') -Force
    Invoke-SpoolfreeTestPageJob -Path $TestPageJob
    exit 0
}

# Fast path for commands (0.8.1, M2): registry + one small authenticated GET; the module is loaded, and signatures
# are checked, only when something is pending.
if ($CommandsOnly) {
    $pollLog = Join-Path $LogDir 'commands.log'
    function Write-PollLog([string]$Message) {
        try {
            if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
            if ((Test-Path -LiteralPath $pollLog) -and (Get-Item -LiteralPath $pollLog).Length -gt 1MB) { Move-Item -LiteralPath $pollLog "$pollLog.1" -Force }
            Add-Content -LiteralPath $pollLog -Value ('{0:u} {1}' -f (Get-Date).ToUniversalTime(), $Message)
        } catch { }
    }
    # A problem (server unreachable, AD unreachable...) is logged once per kind and then at most once an hour.
    function Write-PollProblem([string]$Kind, [string]$Message) {
        $now = (Get-Date).ToUniversalTime()
        $last = $null
        try { $last = [string](Get-ItemProperty -Path $ConfigKey -Name CommandPollProblem -ErrorAction Stop).CommandPollProblem } catch { }
        $at = [datetime]::MinValue
        $parts = ([string]$last).Split([char]'|', 2)
        $logged = $parts.Count -eq 2 -and $parts[1] -eq $Kind -and [datetime]::TryParse($parts[0], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]'AdjustToUniversal,AssumeUniversal', [ref]$at) -and ($now - $at).TotalMinutes -lt 60
        if ($logged) { return }
        Write-PollLog "$Message (logged at most once an hour while it lasts)"
        try { New-ItemProperty -Path $ConfigKey -Name CommandPollProblem -Value ('{0}|{1}' -f $now.ToString('o'), $Kind) -PropertyType String -Force | Out-Null } catch { }
    }
    $reg = Get-ItemProperty -Path $ConfigKey -ErrorAction SilentlyContinue
    $value = { param($n) if ($reg -and $reg.PSObject.Properties[$n]) { [string]$reg.$n } else { '' } }
    $serverUrl = & $value 'ServerUrl'
    $publicKey = & $value 'PublicKey'
    $protected = & $value 'MachineToken'
    # Not installed or not enrolled yet: the main sync reports that; the poll stays quiet.
    if (-not $serverUrl -or -not $publicKey -or -not $protected) { exit 0 }
    try {
        Add-Type -AssemblyName System.Security
        $token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($protected), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))
    } catch {
        Write-PollProblem 'token' "Command poll: cannot read the machine token: $($_.Exception.Message)"
        exit 0
    }
    $base = $serverUrl.TrimEnd('/')
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $resp = Invoke-RestMethod -Uri "$base/api/agent/commands" -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'Spoolfree-Agent-Poll' } -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
    } catch {
        $status = $null
        try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch { }
        $kind = if ($status) { "http-$status" } else { 'unreachable' }
        Write-PollProblem $kind "Command poll failed ($(if ($status) { "HTTP $status" } else { 'server unreachable' })): $($_.Exception.Message)"
        exit 0
    }
    if (& $value 'CommandPollProblem') {
        Write-PollLog 'Command poll works again.'
        Remove-ItemProperty -Path $ConfigKey -Name CommandPollProblem -ErrorAction SilentlyContinue
    }
    $pending = @(if ($resp -and $resp.PSObject.Properties['commands']) { @($resp.commands) | Where-Object { $_ } })
    if ($pending.Count -eq 0 -or $WhatIfPreference) { exit 0 }

    Import-Module (Join-Path $PSScriptRoot 'Spoolfree.Agent.psm1') -Force
    # The objectGUID cached at enrollment or by the main sync; AD only when there is no cache.
    $objectGuid = & $value 'ObjectGuid'
    if (-not $objectGuid) {
        try {
            $objectGuid = (Get-SpoolfreeComputerIdentity).ObjectGuid
            Set-SpoolfreeIdentityCache -ObjectGuid $objectGuid -Key $ConfigKey | Out-Null
        } catch {
            Write-PollProblem 'identity' "Command poll: $($pending.Count) command(s) pending, but this computer's identity is not cached and AD cannot be reached: $($_.Exception.Message)"
            exit 0
        }
    }
    try {
        $n = Invoke-SpoolfreeCommands -Commands $pending -PublicKey $publicKey -ObjectGuid $objectGuid -BaseUrl $base -Token $token -ServerId (Get-SpoolfreeServerId $publicKey) -Log ${function:Write-PollLog}
        Write-PollLog "Command poll: $($pending.Count) pending, $n run."
    } catch {
        Write-PollLog "Running commands failed: $($_.Exception.Message)"
    }
    exit 0
}

Import-Module (Join-Path $PSScriptRoot 'Spoolfree.Agent.psm1') -Force

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$log = Join-Path $LogDir 'sync.log'
try { if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.1" -Force } } catch { }
# 0.8.1 (L6): a log write that fails (the file is busy) never aborts the sync.
function Write-Log([string]$Message) {
    $line = '{0:u} {1}' -f (Get-Date).ToUniversalTime(), $Message
    try { Add-Content -Path $log -Value $line } catch { }
    Write-Verbose $line
}

$started = Get-Date
$errors = New-Object System.Collections.Generic.List[string]
$added = New-Object System.Collections.Generic.List[string]
$removed = New-Object System.Collections.Generic.List[string]

$cfg = Get-SpoolfreeConfig
if (-not $cfg -or -not $cfg.ServerUrl -or -not $cfg.PublicKey) { Write-Log 'Not installed: run Install-SpoolfreeAgent.ps1.'; exit 2 }
if (-not $cfg.MachineToken) { Write-Log 'No machine token: re-run Install-SpoolfreeAgent.ps1 to enroll.'; exit 3 }

$identity = Get-SpoolfreeComputerIdentity
$base = $cfg.ServerUrl.TrimEnd('/')
# 0.8.1 (M2): cache the objectGUID for the minute command poll, which never asks AD.
try { Set-SpoolfreeIdentityCache -ObjectGuid $identity.ObjectGuid | Out-Null } catch { Write-Log "Caching the computer identity failed: $($_.Exception.Message)" }
# Leftovers of an interrupted test print (one-off tasks in a user's session).
try { Remove-SpoolfreeTestPageTasks } catch { }

try {
    $envelope = Invoke-SpoolfreeHttp -Uri "$base/api/agent/manifest" -Token $cfg.MachineToken
} catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    Write-Log "Manifest download failed (HTTP $status): $($_.Exception.Message)"
    if ($status -eq 401) {
        # Token revoked or unknown: drop it so the next startup re-enrolls.
        Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Spoolfree' -Name MachineToken -ErrorAction SilentlyContinue
    }
    exit 4
}

try {
    $manifest = ConvertFrom-SpoolfreeManifest -Envelope $envelope -PublicKey $cfg.PublicKey -ObjectGuid $identity.ObjectGuid
} catch {
    Write-Log "Rejected manifest: $($_.Exception.Message)"
    exit 5
}

# A version installed by self-update is pending until it gets this far; the launcher then clears it.
try { if (Confirm-SpoolfreeAgentRun) { Write-Log "Agent $(Get-SpoolfreeAgentVersion) verified a manifest after its update." } } catch { Write-Log "Confirming the agent update failed: $($_.Exception.Message)" }

$wpp = Test-SpoolfreeProtectedPrintMode
$method = Get-SpoolfreeInstallMethod -IppUrlSupported (Test-SpoolfreeIppUrlSupported) -ProtectedPrintMode $wpp
# Queues created with the TCP/IP fallback after Add-Printer -IppURL failed, and printers this PC is left without.
$fallbacks = New-Object System.Collections.Generic.List[object]
$critical = New-Object System.Collections.Generic.List[string]
# This server's identity: queue comments name it, so queues left by another Spoolfree server can be told apart.
$serverId = Get-SpoolfreeServerId $cfg.PublicKey
$serverPrinterIds = @(Get-SpoolfreeProperty $manifest 'serverPrinterIds' | Where-Object { $_ } | ForEach-Object { [string]$_ })

# Legacy queue takeover (opt-in per printer): remove non-Spoolfree queues for the same device BEFORE
# creating the Spoolfree queue (Windows allows one IPP queue per device). Dry-run only reports.
$legacy = New-Object System.Collections.Generic.List[object]
$legacyRemoved = @{}
$legacyRules = New-Object System.Collections.Generic.List[object]
$legacyServers = @(Get-SpoolfreeProperty $manifest 'legacyPrintServers' | Where-Object { $_ } | ForEach-Object { [string]$_ })
$queues = $null; $ports = $null
$installedNames = @(Get-SpoolfreeInstalled | ForEach-Object { [string]$_.Name })
foreach ($p in @($manifest.printers)) {
    $mode = Get-SpoolfreeLegacyMode $p
    if ($mode -eq 'off') { continue }
    try {
        $addresses = Get-SpoolfreePrinterAddressSet -Printer $p
        $shares = @(Get-SpoolfreeProperty (Get-SpoolfreeProperty $p 'legacy') 'shares' | Where-Object { $_ } | ForEach-Object { [string]$_ })
        $legacyRules.Add([ordered]@{ printer = [string]$p.name; mode = $mode; shares = $shares; addresses = @($addresses) })
        if ($null -eq $queues) { $queues = Get-SpoolfreeQueueInventory; $ports = Get-SpoolfreePortInventory }
        $found = @(Get-SpoolfreeLegacyMatches -Printer $p -Queues $queues -Ports $ports -PrinterAddresses $addresses -LegacyServers $legacyServers -Installed $installedNames -ServerId $serverId -ServerPrinterIds $serverPrinterIds)
        foreach ($m in $found) {
            $entry = [ordered]@{ printer = [string]$p.name; queue = $m.Queue; reason = $m.Reason; action = 'would-remove'; scope = 'machine' }
            if ($mode -eq 'on' -and $PSCmdlet.ShouldProcess($m.Queue, "Remove legacy queue (replaced by $($p.name))")) {
                try {
                    # Remember the queue's model driver for the TCP/IP fallback (never leave the PC without the printer).
                    $drv = Get-SpoolfreeLegacyDriverChoice -Queues @($queues | Where-Object { $_.Name -eq $m.Queue })
                    if ($drv -and -not (Get-SpoolfreeLegacyDriver -Printer ([string]$p.name))) { Set-SpoolfreeLegacyDriver -Printer ([string]$p.name) -Driver $drv }
                    Remove-SpoolfreeQueue -Name $m.Queue
                    $entry.action = 'removed'
                    $legacyRemoved[$m.Queue] = [string]$p.name
                    Write-Log "Legacy queue '$($m.Queue)' removed ($($m.Reason)); replaced by '$($p.name)'."
                } catch {
                    $entry.action = 'failed'
                    $entry['error'] = $_.Exception.Message
                    $errors.Add("$($m.Queue): legacy takeover failed: $($_.Exception.Message)")
                    Write-Log "Legacy queue '$($m.Queue)': remove failed: $($_.Exception.Message)"
                }
            } else {
                Write-Log "Legacy queue '$($m.Queue)' would be removed ($($m.Reason)); printer '$($p.name)' is in $mode mode."
            }
            $legacy.Add([pscustomobject]$entry)
        }
    } catch {
        $errors.Add("$($p.name): legacy takeover check failed: $($_.Exception.Message)")
        Write-Log "$($p.name): legacy takeover check failed: $($_.Exception.Message)"
    }
}
foreach ($e in (Get-SpoolfreeUserTakeoverResults)) { if ($legacy.Count -lt 200) { $legacy.Add($e) } }

$existing = @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
# 0.7.7: queues the old fallback made (IPP Class Driver on a RAW 9100 port) are re-created, new queue first.
# A failed try (for example a Brother printer whose -IppURL times out) keeps the old queue and is retried after 24 h.
$migrate = @(Get-SpoolfreeInstalled | Where-Object {
        $q0 = Get-SpoolfreeQueueByName -Name ([string]$_.Name)
        $q0 -and (Test-SpoolfreeClassOnRawQueue -Method ([string]$_.Method) -DriverName ([string]$q0.DriverName)) -and (Test-SpoolfreeMigrateDue $_.MigrateTried)
    } | ForEach-Object { [string]$_.Name })
if ($migrate.Count) { Write-Log "Old-fallback queues (IPP Class Driver on a RAW port) to re-create: $($migrate -join '; ')" }
# 0.8.1: per-PC vendor fallback. A driverless printer whose queue here was created with its fallbackDriver (because
# Add-Printer -IppURL failed on this PC) keeps that vendor queue; a new package re-creates it make-before-break. When the
# manifest no longer offers a fallback, the driverless queue is tried (new queue first) and the vendor queue kept if that
# fails, retried after 24 h.
$markerByName = @{}
foreach ($m in @(Get-SpoolfreeInstalled)) { $markerByName[([string]$m.Name).ToLowerInvariant()] = $m }
$desired = @(foreach ($p in @($manifest.printers)) { Get-SpoolfreeEffectivePrinter -Printer $p -Marker $markerByName[([string]$p.name).ToLowerInvariant()] -VendorAllowed (-not $wpp) })
$holdFallback = @(foreach ($d in $desired) {
        $m = $markerByName[([string]$d.name).ToLowerInvariant()]
        if ($m -and $m.VendorFallback -and -not (Test-SpoolfreeVendorFallbackPrinter $d) -and -not (Test-SpoolfreeMigrateDue $m.MigrateTried)) { [string]$d.name }
    })
$plan = Get-SpoolfreePlan -Desired $desired -Installed @(Get-SpoolfreeInstalled) -Existing $existing -DefaultPrinter $manifest.defaultPrinter -VendorAllowed (-not $wpp) -Migrate $migrate
foreach ($step in $plan) { if ($step.Action -eq 'Replace' -and $holdFallback -contains [string]$step.Name) { $step.Action = 'Keep' } }

# Vendor drivers (0.7): not allowed under Windows Protected Print Mode; those printers stay driverless.
$driverResults = New-Object System.Collections.Generic.List[object]
foreach ($p in $desired) {
    $v = Get-SpoolfreeVendorDriver $p
    if ($v -and $wpp) {
        $driverResults.Add([ordered]@{ printer = [string]$p.name; status = 'wpp-blocked'; driverName = $v.DriverName; message = 'vendor driver not allowed under WPP; driverless queue used' })
        Write-Log "$($p.name): vendor driver not allowed under Windows Protected Print Mode; using the driverless queue."
    } elseif ([string](Get-SpoolfreeProperty $p 'driverMode') -eq 'vendor' -and -not $v) {
        $driverResults.Add([ordered]@{ printer = [string]$p.name; status = 'failed'; driverName = $null; message = 'invalid vendor driver entry in the manifest; driverless queue used' })
    }
}
Write-Log ("Manifest {0}: {1} printer(s); method {2}; plan: {3}" -f $manifest.serial, @($manifest.printers).Count, $method, (($plan | ForEach-Object { "$($_.Action) $($_.Name)" }) -join '; '))

# Rename/replace re-creates queues; users whose default was such a queue get it back at their next logon.
$recreated = Get-SpoolfreeRecreatedQueues -Plan $plan -Installed @(Get-SpoolfreeInstalled)
if ($PSCmdlet.ShouldProcess('legacy takeover rules', 'publish')) {
    try {
        Set-SpoolfreeTakeoverState -Servers $legacyServers -Rules $legacyRules.ToArray() -Removed $legacyRemoved -Recreated $recreated
    } catch { Write-Log "Publishing takeover rules failed: $($_.Exception.Message)" }
}

# Sync interval from the server (AGENT_SYNC_INTERVAL_MINUTES): update this task's trigger when it changes.
if ($PSCmdlet.ShouldProcess('Spoolfree Sync task', 'set interval')) {
    try {
        $newInterval = Update-SpoolfreeSyncInterval (Get-SpoolfreeProperty $manifest 'syncIntervalMinutes')
        if ($newInterval) { Write-Log "Sync interval set to $newInterval minutes." }
    } catch {
        $errors.Add("sync interval: $($_.Exception.Message)")
        Write-Log "Updating the sync interval failed: $($_.Exception.Message)"
    }
}

# Creates one queue (Add/Replace). 0.6.2: when takeover is on for the printer or already removed a legacy queue for it
# here, an "already exists" failure is recovered (blocking queue removed, stale device association cleared, TCP/IP
# fallback with the old queue's driver) so the PC is never left without the printer.
$takeoverPrinters = Get-SpoolfreeTakeoverPrinters -RemovedMap (Get-SpoolfreeProperty (Get-SpoolfreeTakeoverState) 'removedMap') -Removed $legacyRemoved
$lateRemoved = @{}

# Installs the printer's vendor driver (download, hash + signature checks, pnputil) and creates its queue under
# $QueueName. Throws on failure.
function Install-VendorQueue($printer, [string]$QueueName, [string]$Status, [string]$Message) {
    $v = Get-SpoolfreeVendorDriver $printer
    $state = Install-SpoolfreeVendorDriver -Vendor $v -BaseUrl $base -Token $cfg.MachineToken
    if ($state -eq 'installed') { Write-Log "$($printer.name): installed vendor driver '$($v.DriverName)' from package '$($v.PackageName)' (sha256 $($v.Sha256))." }
    Install-SpoolfreePrinter -Printer $printer -Method 'Vendor' -ServerId $serverId -QueueName $QueueName
    # 0.8.1: a vendor fallback queue is marked, so later syncs keep it (Get-SpoolfreeEffectivePrinter).
    if ((Test-SpoolfreeVendorFallbackPrinter $printer) -and $QueueName -eq [string]$printer.name) { Set-SpoolfreeMarkerValue -Name $QueueName -Property 'VendorFallback' -Value (Get-FallbackLabel $printer) }
    $port = "$($v.Protocol) port $(Get-SpoolfreeVendorPortName -Printer $printer -Vendor $v)"
    $driverResults.Add([ordered]@{ printer = [string]$printer.name; status = $(if ($Status) { $Status } else { $state }); driverName = $v.DriverName; message = $(if ($Message) { "$Message; $port" } else { $port }) })
}

# The package a vendor fallback queue uses (marker VendorFallback, report queues[].vendorFallback).
function Get-FallbackLabel($printer) {
    $v = Get-SpoolfreeVendorDriver $printer
    if ($v.PackageName) { return $v.PackageName }
    if ($v.PackageId) { return $v.PackageId }
    return $v.DriverName
}

function Install-SyncStep($step) {
    $name = [string]$step.Name
    # Vendor driver first (0.7); when it fails the driverless queue is created instead, so the PC is never left
    # without the printer. The next sync tries the vendor driver again (make-before-break).
    $v = Get-SpoolfreeVendorDriver $step.Printer
    if ($v -and -not $wpp) {
        try {
            Install-VendorQueue $step.Printer $name
            $added.Add($name)
            return
        } catch {
            $why = $_.Exception.Message
            $errors.Add("${name}: vendor driver failed: $why")
            $driverResults.Add([ordered]@{ printer = $name; status = 'fallback'; driverName = $v.DriverName; message = "vendor driver failed ($why); driverless queue created instead" })
            Write-Log "${name}: vendor driver failed: $why. Creating the driverless queue instead."
            if (Get-SpoolfreeQueueByName -Name $name) { throw "a queue named $name exists after the failed vendor install" }
        }
    }
    $on = (Get-SpoolfreeLegacyMode $step.Printer) -eq 'on'
    $recovery = $on -or $takeoverPrinters.ContainsKey($name.ToLowerInvariant())
    $find = $null
    if ($on) {
        $find = {
            $q2 = Get-SpoolfreeQueueInventory
            $p2 = Get-SpoolfreePortInventory
            @(Get-SpoolfreeLegacyMatches -Printer $step.Printer -Queues $q2 -Ports $p2 -PrinterAddresses (Get-SpoolfreePrinterAddressSet -Printer $step.Printer) -LegacyServers $legacyServers -Installed @(Get-SpoolfreeInstalled | ForEach-Object { [string]$_.Name }) -ServerId $serverId -ServerPrinterIds $serverPrinterIds) |
                Where-Object { $_.Kind -ne 'connection' -and -not ([string]$_.Queue).StartsWith('\') } | ForEach-Object { [string]$_.Queue }
        }
    }
    try {
        $r = Install-SpoolfreePrinterResilient -Printer $step.Printer -Method $method -ServerId $serverId -ProtectedPrintMode $wpp `
            -TakeoverRecovery $recovery -FindBlocking $find -FallbackDriver (Get-SpoolfreeLegacyDriver -Printer $name)
    } catch {
        # 0.8.1: the driverless queue cannot be created on this PC; use the printer's vendor fallback package, if any.
        $why = $_.Exception.Message
        $fp = if (-not $wpp -and -not (Test-SpoolfreeVendorFallbackPrinter $step.Printer)) { ConvertTo-SpoolfreeFallbackPrinter $step.Printer } else { $null }
        if (-not $fp -or (Get-SpoolfreeQueueByName -Name $name)) { throw }
        $fv = Get-SpoolfreeVendorDriver $fp
        Write-Log "${name}: the driverless queue failed on this PC ($why); using the vendor fallback driver '$($fv.DriverName)' from package '$($fv.PackageName)'."
        try {
            Install-VendorQueue $fp $name 'vendor-fallback' "Add-Printer -IppURL failed on this PC; vendor driver used on this PC only"
        } catch {
            if (Get-SpoolfreeQueueByName -Name $name) { try { Remove-SpoolfreeQueue -Name $name } catch { } }
            throw "$why; the vendor fallback driver '$($fv.DriverName)' failed too: $($_.Exception.Message)"
        }
        $added.Add($name)
        return
    }
    foreach ($n in @($r.Notes)) { Write-Log "${name}: $n" }
    foreach ($rq in @($r.RemovedQueues)) {
        $lateRemoved[$rq] = $name
        $legacy.Add([pscustomobject][ordered]@{ printer = $name; queue = $rq; reason = 'held the device when the Spoolfree queue was created'; action = 'removed'; scope = 'machine' })
        Write-Log "Legacy queue '$rq' removed (held the device of '$name')."
    }
    if ($r.Fallback) { $fallbacks.Add([ordered]@{ printer = $name; method = $r.Method; reason = (@($r.Notes) | Select-Object -First 1) }) }
    $added.Add($name)
}

# Make-before-break switch (0.7) to or from a vendor-driver queue: the new queue is created under a temporary name next
# to the old one, then the old one is removed and the new one renamed. If the new vendor queue cannot be created the
# old queue stays; a new driverless queue that cannot be created next to the old one falls back to remove-then-add.
function Switch-SyncQueue($step) {
    $name = [string]$step.Name
    $tmp = "$name (Spoolfree)"
    $left = Get-SpoolfreeQueueByName -Name $tmp
    if ($left -and ([string]$left.Comment).StartsWith('Managed by Spoolfree')) { Remove-SpoolfreeQueue -Name $tmp }
    $v = Get-SpoolfreeVendorDriver $step.Printer
    $useVendor = [bool]($v -and -not $wpp)
    $isMigration = $migrate -contains $name
    $target = $step.Printer
    $oldMarker = $markerByName[$name.ToLowerInvariant()]
    $wasFallback = [bool]($oldMarker -and $oldMarker.VendorFallback)
    try {
        if ($useVendor) { Install-VendorQueue $step.Printer $tmp }
        else { Install-SpoolfreePrinter -Printer $step.Printer -Method $method -ServerId $serverId -QueueName $tmp }
    } catch {
        $why = $_.Exception.Message
        if (Get-SpoolfreeQueueByName -Name $tmp) { try { Remove-SpoolfreeQueue -Name $tmp } catch { Write-Log "${name}: could not remove ${tmp}: $($_.Exception.Message)" } }
        if ($useVendor) {
            $errors.Add("${name}: vendor driver failed, kept the current queue: $why")
            $driverResults.Add([ordered]@{ printer = $name; status = 'fallback'; driverName = $v.DriverName; message = "vendor driver failed ($why); current queue kept" })
            Write-Log "${name}: vendor driver failed ($why); the current queue stays."
            return
        }
        if ($isMigration -or $wasFallback) {
            # 0.7.7: an old-fallback queue (IPP Class Driver on a RAW port) is only replaced by a working queue.
            # 0.8.1: with the printer's vendor fallback package when -IppURL fails here; a vendor fallback queue whose
            # package the manifest no longer offers is kept the same way until the driverless queue works.
            $fp = if ($isMigration -and -not $wasFallback -and -not $wpp) { ConvertTo-SpoolfreeFallbackPrinter $step.Printer } else { $null }
            $fbWhy = $null
            if ($fp) {
                try {
                    Install-VendorQueue $fp $tmp 'vendor-fallback' "Add-Printer -IppURL failed on this PC ($why); vendor driver used on this PC only"
                } catch {
                    $fbWhy = $_.Exception.Message
                    if (Get-SpoolfreeQueueByName -Name $tmp) { try { Remove-SpoolfreeQueue -Name $tmp } catch { } }
                }
            }
            if (-not $fp -or $fbWhy) {
                Set-SpoolfreeMarkerValue -Name $name -Property 'MigrateTried' -Value ((Get-Date).ToUniversalTime().ToString('o'))
                $more = if ($fbWhy) { "; the vendor fallback driver failed too ($fbWhy)" } else { '' }
                if ($wasFallback) {
                    $errors.Add("${name}: the vendor fallback package is no longer offered and Add-Printer -IppURL failed ($why); the vendor queue is kept, retried in 24 h")
                    Write-Log "${name}: Add-Printer -IppURL failed ($why); the vendor fallback queue stays; retried in 24 h."
                } else {
                    $errors.Add("${name}: needs a vendor driver: the queue uses the IPP Class Driver on a RAW port (prints raster as text on many printers) and Add-Printer -IppURL failed ($why)$more; kept, retried in 24 h")
                    Write-Log "${name}: Add-Printer -IppURL failed ($why)$more; the old queue (IPP Class Driver on a RAW port) stays; retried in 24 h. Set a vendor driver for this printer."
                }
                return
            }
            $target = $fp
            $useVendor = $true
            $v = Get-SpoolfreeVendorDriver $fp
        } else {
            Write-Log "${name}: the driverless queue could not be created next to the old one ($why); removing the old queue first."
            Uninstall-SpoolfreePrinter -Name $name
            Install-SyncStep $step
            return
        }
    }
    Uninstall-SpoolfreePrinter -Name $name
    $q = Get-SpoolfreeQueueByName -Name $tmp
    Rename-Printer -InputObject $q -NewName $name -ErrorAction Stop
    $q = Get-SpoolfreeQueueByName -Name $name
    if (-not $q) { throw "renaming $tmp to $name failed" }
    if ($useVendor) { Set-SpoolfreeMarker -Printer $target -Method 'Vendor' -PortName ([string]$q.PortName) -ServerId $serverId -Target (Get-SpoolfreeQueueTarget $target) }
    else { Set-SpoolfreeMarker -Printer $target -Method $method -PortName ([string]$q.PortName) -ServerId $serverId }
    $isFallback = Test-SpoolfreeVendorFallbackPrinter $target
    if ($isFallback) { Set-SpoolfreeMarkerValue -Name $name -Property 'VendorFallback' -Value (Get-FallbackLabel $target) }
    $what = if (-not $useVendor) { 'driverless queue' } elseif ($isFallback) { "vendor driver '$($v.DriverName)' (vendor fallback on this PC)" } else { "vendor driver '$($v.DriverName)'" }
    Write-Log "${name}: switched to the $what (new queue created first)."
    $added.Add($name)
}

foreach ($step in $plan) {
    if (-not $PSCmdlet.ShouldProcess($step.Name, $step.Action)) { continue }
    try {
        switch ($step.Action) {
            'Add' { Install-SyncStep $step }
            'Replace' {
                if ((Get-SpoolfreeProperty $step 'MakeBeforeBreak') -and (Get-SpoolfreeQueueByName -Name $step.Name)) { Switch-SyncQueue $step }
                else {
                    if (Get-SpoolfreeQueueByName -Name $step.Name) { Uninstall-SpoolfreePrinter -Name $step.Name }
                    Install-SyncStep $step
                }
            }
            'Remove' { Uninstall-SpoolfreePrinter -Name $step.Name; $removed.Add($step.Name) }
            'Conflict' { $errors.Add("$($step.Name): a queue with this name exists and was not created by Spoolfree; skipped.") }
            'SetDefault' { }
            'Keep' {
                $q = Get-SpoolfreeQueueByName -Name $step.Name
                if ($q) {
                    $update = Get-SpoolfreeQueueUpdate -Printer $step.Printer -Queue $q -ServerId $serverId
                    if ($update.Count) {
                        Set-Printer -InputObject $q @update -ErrorAction Stop
                        Write-Log "$($step.Name): updated $(@($update.Keys) -join ', ')."
                    }
                }
            }
        }
    } catch {
        $msg = "$($step.Name): $($step.Action) failed: $($_.Exception.Message)"
        if ($step.Action -eq 'Add' -or $step.Action -eq 'Replace') {
            # Windows allows one WSD/IPP queue per device: name the queue that holds it, if there is one.
            try {
                $winError = $_.Exception.Message
                $q2 = Get-SpoolfreeQueueInventory
                $p2 = Get-SpoolfreePortInventory
                $blocking = @(Get-SpoolfreeLegacyMatches -Printer $step.Printer -Queues $q2 -Ports $p2 -PrinterAddresses (Get-SpoolfreePrinterAddressSet -Printer $step.Printer) -LegacyServers $legacyServers -Installed @(Get-SpoolfreeInstalled | ForEach-Object { [string]$_.Name }) -ServerId $serverId -ServerPrinterIds $serverPrinterIds -AnyMode)
                $msg = Get-SpoolfreeAddFailureMessage -Name $step.Name -Action $step.Action -Message $winError -Blocking $blocking -Mode (Get-SpoolfreeLegacyMode $step.Printer)
            } catch { Write-Log "$($step.Name): could not check for a blocking queue: $($_.Exception.Message)" }
        }
        $errors.Add($msg)
        Write-Log $msg
    }
}
# Queues removed while creating a Spoolfree queue count as taken over (user default carry-over, orphan check).
if ($lateRemoved.Count -and $PSCmdlet.ShouldProcess('legacy takeover rules', 'publish')) {
    foreach ($k in $lateRemoved.Keys) { $legacyRemoved[$k] = $lateRemoved[$k] }
    try { Set-SpoolfreeTakeoverState -Servers $legacyServers -Rules $legacyRules.ToArray() -Removed $lateRemoved -Recreated @{} }
    catch { Write-Log "Publishing takeover rules failed: $($_.Exception.Message)" }
}
# Takeover safety: a printer whose legacy queue was removed here (this or an earlier sync) but that could not be
# created leaves the PC without that printer. Reported as critical (Agents page) until it is fixed.
try {
    $orphans = @(Get-SpoolfreeOrphanedPrinters -Desired @($manifest.printers | ForEach-Object { [string]$_.name }) `
            -Installed @(Get-SpoolfreeInstalled | ForEach-Object { [string]$_.Name }) `
            -RemovedMap (Get-SpoolfreeProperty (Get-SpoolfreeTakeoverState) 'removedMap'))
    foreach ($o in $orphans) {
        $why = @($errors | Where-Object { ([string]$_).StartsWith("$($o.Printer):") }) | Select-Object -First 1
        $msg = "PC left without printer $($o.Printer): legacy queue(s) $((@($o.Queues) | ForEach-Object { "'$_'" }) -join ', ') were removed and the Spoolfree queue could not be created$(if ($why) { " ($why)" })"
        $critical.Add($msg)
        Write-Log "CRITICAL: $msg"
    }
} catch { Write-Log "Checking for printers lost by takeover failed: $($_.Exception.Message)" }

# Default duplex: applied after the queue exists, re-applied only when the manifest value changes
# (recorded in the marker) or the queue was re-created. A failure is retried at the next sync.
# 0.7.7: vendor queues get the driver's automatic two-sided mode (some start in manual duplex), once per queue.
foreach ($m in @(Get-SpoolfreeInstalled | Where-Object { $_.Method -eq 'Vendor' -and -not $_.AutoDuplex })) {
    if (-not $PSCmdlet.ShouldProcess([string]$m.Name, 'Enable automatic duplex')) { continue }
    try {
        $r = Enable-SpoolfreeAutoDuplex -Name ([string]$m.Name)
        Set-SpoolfreeMarkerValue -Name ([string]$m.Name) -Property 'AutoDuplex' -Value $r
        if ($r -eq 'automatic') { Write-Log "$($m.Name): automatic two-sided printing (duplex unit) selected in the vendor driver." }
    } catch { Write-Log "$($m.Name): could not select automatic duplex: $($_.Exception.Message)" }
}

$sides = [ordered]@{}
$markers = @{}
foreach ($m in @(Get-SpoolfreeInstalled)) { $markers[([string]$m.Name).ToLowerInvariant()] = $m }
foreach ($p in @($manifest.printers)) {
    $name = [string]$p.name
    $marker = $markers[$name.ToLowerInvariant()]
    if (-not $marker) { continue }
    $want = Get-SpoolfreeDesiredSides $p
    if ($want -eq 'auto') {
        if ($marker.Sides -ne 'auto') { Set-SpoolfreeMarkerSides -Name $name -Sides 'auto' }
        $sides[$name] = 'auto'
        continue
    }
    if (Test-SpoolfreeDuplexNeeded -Desired $want -Applied $marker.Sides -Recreated ($added -contains $name)) {
        if (-not $PSCmdlet.ShouldProcess($name, "Set default duplex $want")) { continue }
        try {
            Set-SpoolfreeQueueDuplex -Name $name -Sides $want
            Set-SpoolfreeMarkerSides -Name $name -Sides $want
            $sides[$name] = $want
            Write-Log "${name}: default duplex set to $want."
        } catch {
            if ($marker.Method -eq 'Vendor') {
                # Not every vendor driver supports setting duplex this way: noted, not an error; tried once per queue.
                $sides[$name] = "unsupported:$want"
                Set-SpoolfreeMarkerSides -Name $name -Sides $want
                Write-Log "${name}: the vendor driver did not accept default duplex ${want}: $($_.Exception.Message)"
            } else {
                $sides[$name] = "failed:$want"
                $errors.Add("${name}: default duplex $want failed: $($_.Exception.Message)")
                Write-Log "${name}: default duplex $want failed: $($_.Exception.Message)"
            }
        }
    } else {
        $sides[$name] = $want
    }
}

if ($PSCmdlet.ShouldProcess('default printer', 'set')) {
    Set-SpoolfreeDefaultPrinter -Name ([string]$manifest.defaultPrinter)
}

# Unmanaged printers (0.9.0): every non-Spoolfree queue is reported with a class; manifest.unmanaged decides what is
# removed (off | dry-run | on, keep list, keep USB/local). Runs after the Spoolfree queues were created, so the safety
# rule (nothing is removed on a PC without a Spoolfree queue) sees this sync's result. Per-user \\server\share
# connections are left to the logon task, which gets the rules through the published takeover state.
$unmanagedSettings = Get-SpoolfreeUnmanagedSettings $manifest
$unmanagedEntries = New-Object System.Collections.Generic.List[object]
$unmanagedPolicy = [ordered]@{ mode = $unmanagedSettings.Mode; keepLocal = $unmanagedSettings.KeepLocal; keep = @($unmanagedSettings.Keep); blocked = $null }
$spoolfreeQueues = @()
$portsAfter = $null
try {
    $wanted = @{}
    foreach ($p in @($manifest.printers)) { $wanted[([string]$p.name).ToLowerInvariant()] = $true }
    $queuesAfter = Get-SpoolfreeQueueInventory
    $portsAfter = Get-SpoolfreePortInventory
    $existingNames = @{}
    foreach ($q in $queuesAfter) { $existingNames[$q.Name.ToLowerInvariant()] = $true }
    $installedAfter = @(Get-SpoolfreeInstalled | ForEach-Object { [string]$_.Name })
    $spoolfreeQueues = @($installedAfter | Where-Object { $wanted.ContainsKey($_.ToLowerInvariant()) -and $existingNames.ContainsKey($_.ToLowerInvariant()) })
    $printerSets = @(foreach ($p in @($manifest.printers)) { [pscustomobject]@{ Printer = $p; Addresses = @(Get-SpoolfreePrinterAddressSet -Printer $p) } })
    $found = @(Get-SpoolfreeUnmanagedQueues -Queues $queuesAfter -Ports $portsAfter -Printers $printerSets -LegacyServers $legacyServers -Installed $installedAfter -ServerId $serverId -ServerPrinterIds $serverPrinterIds)
    $decision = Get-SpoolfreeUnmanagedPlan -Entries $found -Mode $unmanagedSettings.Mode -Keep $unmanagedSettings.Keep -KeepLocal $unmanagedSettings.KeepLocal -SpoolfreeCount $spoolfreeQueues.Count -TakeoverModes (Get-SpoolfreeTakeoverModes -Printers $printerSets)
    $unmanagedPolicy.blocked = $decision.Blocked
    if ($decision.Blocked) { Write-Log "Unmanaged printers: $($decision.Blocked)." }
    $unmanagedRemoved = @{}
    foreach ($e in @($decision.Entries)) {
        if ($e['action'] -eq 'remove') {
            if ($PSCmdlet.ShouldProcess([string]$e['queue'], 'Remove unmanaged printer')) {
                try {
                    Remove-SpoolfreeQueue -Name ([string]$e['queue'])
                    $e['action'] = 'removed'
                    $replacement = Get-SpoolfreeUnmanagedReplacement -Entry $e -DefaultPrinter ([string]$manifest.defaultPrinter) -Spoolfree $spoolfreeQueues
                    if ($replacement) { $unmanagedRemoved[[string]$e['queue']] = $replacement }
                    Write-Log "Unmanaged printer '$($e['queue'])' removed ($($e['class'])$(if ($e['reason']) { ", $($e['reason'])" }))."
                } catch {
                    $e['action'] = 'failed'
                    $e['error'] = $_.Exception.Message
                    Write-Log "Unmanaged printer '$($e['queue'])': remove failed: $($_.Exception.Message)"
                }
            } else { $e['action'] = 'would-remove' }
        } elseif ($e['action'] -eq 'would-remove') {
            Write-Log "Unmanaged printer '$($e['queue'])' would be removed ($($e['class'])); $(if ($unmanagedSettings.Mode -eq 'on') { $e['reason'] } else { 'Remove unmanaged printers is in dry-run' })"
        }
        $unmanagedEntries.Add($e)
    }
    # Users whose default was a removed queue get the replacement at their next logon (removed map), and the logon
    # task removes their own connections by the same rules.
    if ($PSCmdlet.ShouldProcess('unmanaged printer rules', 'publish')) {
        $publish = [ordered]@{ mode = $unmanagedSettings.Mode; keep = @($unmanagedSettings.Keep); keepLocal = $unmanagedSettings.KeepLocal; spoolfree = @($spoolfreeQueues); defaultQueue = [string]$manifest.defaultPrinter; servers = @($legacyServers) }
        try { Set-SpoolfreeTakeoverState -Servers $legacyServers -Rules $legacyRules.ToArray() -Removed $unmanagedRemoved -Recreated @{} -Unmanaged $publish }
        catch { Write-Log "Publishing the unmanaged printer rules failed: $($_.Exception.Message)" }
    }
} catch {
    $errors.Add("unmanaged printers: $($_.Exception.Message)")
    Write-Log "Checking unmanaged printers failed: $($_.Exception.Message)"
}
foreach ($e in (Get-SpoolfreeUserUnmanagedResults)) { if ($unmanagedEntries.Count -lt 300) { $unmanagedEntries.Add($e) } }
$unmanagedReport = @($unmanagedEntries | Select-Object -First 300)

# Self-update (0.4.3+): install the agent version the server offers; it runs at the next sync. Only from the
# installed layout (<InstallDir>\current, run by the launcher), never from a copy run by hand.
if ((Split-Path $PSScriptRoot -Leaf) -eq 'current' -and $PSCmdlet.ShouldProcess('Spoolfree agent', 'self-update')) {
    try {
        $msg = Invoke-SpoolfreeAgentUpdate -Manifest $manifest -BaseUrl $base -Token $cfg.MachineToken -PublicKey $cfg.PublicKey -Root (Split-Path $PSScriptRoot -Parent)
        if ($msg) { Write-Log $msg }
    } catch {
        $errors.Add("agent update: $($_.Exception.Message)")
        Write-Log $_.Exception.Message
    }
}

# Commands (0.8): test prints that came with the manifest (the "Spoolfree Commands" task usually runs them sooner),
# and the poll task's interval (manifest commandPollMinutes; 0 removes the task). Never fails the sync.
# 0.8.1 (M3): when the poll task exists it runs them; the sync never waits for the command lock or a test print, so a
# stuck job cannot push the sync past the launcher's time limit (which counts against a freshly updated version).
# Without the task the sync runs them itself with no lock wait and at most 60 s in total.
$commandState = [ordered]@{ pollMinutes = (Get-SpoolfreeCommandPollMinutes (Get-SpoolfreeProperty $manifest 'commandPollMinutes')); ran = 0; deferred = 0; error = $null }
if ($PSCmdlet.ShouldProcess('commands', 'run test prints and update the poll task')) {
    if ((Split-Path $PSScriptRoot -Leaf) -eq 'current') {
        try {
            $poll = Update-SpoolfreeCommandTask -Minutes (Get-SpoolfreeProperty $manifest 'commandPollMinutes') -Root (Split-Path $PSScriptRoot -Parent)
            if ($null -ne $poll) { Write-Log $(if ($poll -eq 0) { 'Command poll task removed.' } else { "Command poll task set to every $poll minute(s)." }) }
        } catch {
            $commandState.error = "command poll task: $($_.Exception.Message)"
            Write-Log "Updating the command poll task failed: $($_.Exception.Message)"
        }
    }
    try {
        $pendingCommands = @(Get-SpoolfreeProperty $manifest 'commands' | Where-Object { $_ })
        $taskExists = $false
        if ($pendingCommands.Count) { try { $taskExists = Test-SpoolfreeCommandTask } catch { } }
        $cp = Get-SpoolfreeSyncCommandPlan -PollMinutes $commandState.pollMinutes -TaskExists $taskExists -Count $pendingCommands.Count
        if ($cp.Action -eq 'defer') {
            $commandState.deferred = $pendingCommands.Count
            Write-Log "$($pendingCommands.Count) command(s) in the manifest: left to the Spoolfree Commands task."
        } elseif ($cp.Action -eq 'run') {
            $commandState.ran = Invoke-SpoolfreeCommands -Commands $pendingCommands -PublicKey $cfg.PublicKey -ObjectGuid $identity.ObjectGuid -BaseUrl $base -Token $cfg.MachineToken -ServerId $serverId -Log ${function:Write-Log} -LockWaitSeconds $cp.LockWaitSeconds -BudgetSeconds $cp.BudgetSeconds
        }
    } catch {
        $commandState.error = "commands: $($_.Exception.Message)"
        Write-Log "Running commands failed: $($_.Exception.Message)"
    }
}

# Print analytics (0.5.0, manifest analytics.enabled): event 307 records from the PrintService log go to
# /api/agent/jobs. Runs before the report so the report carries its outcome; it never fails the sync.
$analytics = [ordered]@{ enabled = $false; logEnabled = $null; sent = 0; error = $null }
if ($PSCmdlet.ShouldProcess('print analytics', 'collect and send')) {
    try {
        $analytics = Invoke-SpoolfreeAnalytics -Manifest $manifest -BaseUrl $base -Token $cfg.MachineToken -ServerId $serverId -ServerPrinterIds $serverPrinterIds -Log ${function:Write-Log}
        if ($analytics.error) { Write-Log "Print analytics: $($analytics.error)" }
    } catch {
        $analytics.error = $_.Exception.Message
        Write-Log "Print analytics failed: $($_.Exception.Message)"
    }
}

$applied = @(Get-SpoolfreeInstalled | ForEach-Object { $_.Name })
$queueReport = @(Get-SpoolfreeInstalled | ForEach-Object {
        $q = Get-SpoolfreeQueueByName -Name ([string]$_.Name)
        # 0.9.0: the device UUIDs the queue's WSD-monitor port stores, so the server learns the printer's WSD UUIDs.
        $portInfo = if ($q -and $portsAfter -and $portsAfter.ContainsKey([string]$q.PortName)) { $portsAfter[[string]$q.PortName] } else { $null }
        $uuids = @(@(Get-SpoolfreeProperty $portInfo 'Uuids') | Where-Object { $_ } | ForEach-Object { [string]$_ } | Select-Object -First 8)
        [ordered]@{ name = [string]$_.Name; driver = $(if ($q) { [string]$q.DriverName } else { $null }); port = $(if ($q) { [string]$q.PortName } else { $null }); method = [string]$_.Method; vendorFallback = $(if ($_.VendorFallback) { [string]$_.VendorFallback } else { $null }); uuids = $uuids }
    } | Select-Object -First 200)
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$report = [ordered]@{
    agentVersion   = Get-SpoolfreeAgentVersion
    osVersion      = $(if ($os) { "$($os.Caption) ($($os.BuildNumber))" } else { [Environment]::OSVersion.VersionString })
    manifestSerial = [string]$manifest.serial
    applied        = $applied
    added          = $added.ToArray()
    removed        = $removed.ToArray()
    defaultPrinter = $manifest.defaultPrinter
    errors         = $errors.ToArray()
    method         = $method
    legacy         = @($legacy | Select-Object -First 200)
    sides          = $sides
    update         = $(try { Get-SpoolfreeUpdateReport } catch { [ordered]@{ state = 'current' } })
    critical       = $critical.ToArray()
    fallbacks      = $fallbacks.ToArray()
    analytics      = $analytics
    commands       = $commandState
    queues         = $queueReport
    drivers        = @($driverResults | Select-Object -First 200)
    unmanaged      = $unmanagedReport
    unmanagedPolicy = $unmanagedPolicy
    durationMs     = [int]((Get-Date) - $started).TotalMilliseconds
}
try {
    Invoke-SpoolfreeHttp -Uri "$base/api/agent/report" -Method POST -Token $cfg.MachineToken -Body $report | Out-Null
} catch {
    Write-Log "Report failed: $($_.Exception.Message)"
}
Write-Log ("Done: {0} applied, {1} added, {2} removed, {3} error(s)." -f $applied.Count, $added.Count, $removed.Count, $errors.Count)
if ($errors.Count) { exit 1 }
exit 0
