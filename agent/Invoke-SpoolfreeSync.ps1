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
#>
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Spoolfree.Agent.psm1') -Force

$logDir = Join-Path $env:ProgramData 'Spoolfree\Logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'sync.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.1" -Force }
function Write-Log([string]$Message) {
    $line = '{0:u} {1}' -f (Get-Date).ToUniversalTime(), $Message
    Add-Content -Path $log -Value $line
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

$method = Get-SpoolfreeInstallMethod -IppUrlSupported (Test-SpoolfreeIppUrlSupported) -ProtectedPrintMode (Test-SpoolfreeProtectedPrintMode)
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
                    Remove-Printer -Name $m.Queue -ErrorAction Stop
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
$plan = Get-SpoolfreePlan -Desired @($manifest.printers) -Installed @(Get-SpoolfreeInstalled) -Existing $existing -DefaultPrinter $manifest.defaultPrinter
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

foreach ($step in $plan) {
    if (-not $PSCmdlet.ShouldProcess($step.Name, $step.Action)) { continue }
    try {
        switch ($step.Action) {
            'Add' { Install-SpoolfreePrinter -Printer $step.Printer -Method $method -ServerId $serverId; $added.Add($step.Name) }
            'Replace' {
                if (Get-Printer -Name $step.Name -ErrorAction SilentlyContinue) { Uninstall-SpoolfreePrinter -Name $step.Name }
                Install-SpoolfreePrinter -Printer $step.Printer -Method $method -ServerId $serverId
                $added.Add($step.Name)
            }
            'Remove' { Uninstall-SpoolfreePrinter -Name $step.Name; $removed.Add($step.Name) }
            'Conflict' { $errors.Add("$($step.Name): a queue with this name exists and was not created by Spoolfree; skipped.") }
            'SetDefault' { }
            'Keep' {
                $q = Get-Printer -Name $step.Name -ErrorAction SilentlyContinue
                if ($q) {
                    $update = Get-SpoolfreeQueueUpdate -Printer $step.Printer -Queue $q -ServerId $serverId
                    if ($update.Count) {
                        Set-Printer -Name $step.Name @update -ErrorAction Stop
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
# Default duplex: applied after the queue exists, re-applied only when the manifest value changes
# (recorded in the marker) or the queue was re-created. A failure is retried at the next sync.
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
            $sides[$name] = "failed:$want"
            $errors.Add("${name}: default duplex $want failed: $($_.Exception.Message)")
            Write-Log "${name}: default duplex $want failed: $($_.Exception.Message)"
        }
    } else {
        $sides[$name] = $want
    }
}

if ($PSCmdlet.ShouldProcess('default printer', 'set')) {
    Set-SpoolfreeDefaultPrinter -Name ([string]$manifest.defaultPrinter)
}

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

$applied = @(Get-SpoolfreeInstalled | ForEach-Object { $_.Name })
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
