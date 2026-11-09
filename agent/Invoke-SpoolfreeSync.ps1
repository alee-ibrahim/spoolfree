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
$plan = Get-SpoolfreePlan -Desired @($manifest.printers) -Installed @(Get-SpoolfreeInstalled) -Existing $existing -DefaultPrinter $manifest.defaultPrinter -VendorAllowed (-not $wpp) -Migrate $migrate

# Vendor drivers (0.7): not allowed under Windows Protected Print Mode; those printers stay driverless.
$driverResults = New-Object System.Collections.Generic.List[object]
foreach ($p in @($manifest.printers)) {
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
function Install-VendorQueue($printer, [string]$QueueName) {
    $v = Get-SpoolfreeVendorDriver $printer
    $state = Install-SpoolfreeVendorDriver -Vendor $v -BaseUrl $base -Token $cfg.MachineToken
    if ($state -eq 'installed') { Write-Log "$($printer.name): installed vendor driver '$($v.DriverName)' from package '$($v.PackageName)' (sha256 $($v.Sha256))." }
    Install-SpoolfreePrinter -Printer $printer -Method 'Vendor' -ServerId $serverId -QueueName $QueueName
    $driverResults.Add([ordered]@{ printer = [string]$printer.name; status = $state; driverName = $v.DriverName; message = "$($v.Protocol) port $(Get-SpoolfreeVendorPortName -Printer $printer -Vendor $v)" })
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
    $r = Install-SpoolfreePrinterResilient -Printer $step.Printer -Method $method -ServerId $serverId -ProtectedPrintMode $wpp `
        -TakeoverRecovery $recovery -FindBlocking $find -FallbackDriver (Get-SpoolfreeLegacyDriver -Printer $name)
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
        if ($isMigration -and -not $useVendor) {
            # 0.7.7: an old-fallback queue (IPP Class Driver on a RAW port) is only replaced by a working queue.
            Set-SpoolfreeMarkerValue -Name $name -Property 'MigrateTried' -Value ((Get-Date).ToUniversalTime().ToString('o'))
            $errors.Add("${name}: needs a vendor driver: the queue uses the IPP Class Driver on a RAW port (prints raster as text on many printers) and Add-Printer -IppURL failed ($why); kept, retried in 24 h")
            Write-Log "${name}: Add-Printer -IppURL failed ($why); the old queue (IPP Class Driver on a RAW port) stays; retried in 24 h. Set a vendor driver for this printer."
            return
        }
        Write-Log "${name}: the driverless queue could not be created next to the old one ($why); removing the old queue first."
        Uninstall-SpoolfreePrinter -Name $name
        Install-SyncStep $step
        return
    }
    Uninstall-SpoolfreePrinter -Name $name
    $q = Get-SpoolfreeQueueByName -Name $tmp
    Rename-Printer -InputObject $q -NewName $name -ErrorAction Stop
    $q = Get-SpoolfreeQueueByName -Name $name
    if (-not $q) { throw "renaming $tmp to $name failed" }
    if ($useVendor) { Set-SpoolfreeMarker -Printer $step.Printer -Method 'Vendor' -PortName ([string]$q.PortName) -ServerId $serverId -Target (Get-SpoolfreeQueueTarget $step.Printer) }
    else { Set-SpoolfreeMarker -Printer $step.Printer -Method $method -PortName ([string]$q.PortName) -ServerId $serverId }
    Write-Log "${name}: switched to the $(if ($useVendor) { "vendor driver '$($v.DriverName)'" } else { 'driverless queue' }) (new queue created first)."
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
        [ordered]@{ name = [string]$_.Name; driver = $(if ($q) { [string]$q.DriverName } else { $null }); port = $(if ($q) { [string]$q.PortName } else { $null }); method = [string]$_.Method }
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
    queues         = $queueReport
    drivers        = @($driverResults | Select-Object -First 200)
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
