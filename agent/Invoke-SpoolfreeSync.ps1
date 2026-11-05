#Requires -Version 5.1
<#
.SYNOPSIS
    Spoolfree sync: downloads this computer's signed printer manifest,
    verifies it, reconciles driverless IPP queues and reports back.

.DESCRIPTION
    Runs as SYSTEM from the "Spoolfree Sync" scheduled task (at startup and
    hourly). Only queues this agent created (registry marker under
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

$method = Get-SpoolfreeInstallMethod -IppUrlSupported (Test-SpoolfreeIppUrlSupported) -ProtectedPrintMode (Test-SpoolfreeProtectedPrintMode)
$existing = @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$plan = Get-SpoolfreePlan -Desired @($manifest.printers) -Installed @(Get-SpoolfreeInstalled) -Existing $existing -DefaultPrinter $manifest.defaultPrinter
Write-Log ("Manifest {0}: {1} printer(s); method {2}; plan: {3}" -f $manifest.serial, @($manifest.printers).Count, $method, (($plan | ForEach-Object { "$($_.Action) $($_.Name)" }) -join '; '))

foreach ($step in $plan) {
    if (-not $PSCmdlet.ShouldProcess($step.Name, $step.Action)) { continue }
    try {
        switch ($step.Action) {
            'Add' { Install-SpoolfreePrinter -Printer $step.Printer -Method $method; $added.Add($step.Name) }
            'Replace' {
                if (Get-Printer -Name $step.Name -ErrorAction SilentlyContinue) { Uninstall-SpoolfreePrinter -Name $step.Name }
                Install-SpoolfreePrinter -Printer $step.Printer -Method $method
                $added.Add($step.Name)
            }
            'Remove' { Uninstall-SpoolfreePrinter -Name $step.Name; $removed.Add($step.Name) }
            'Conflict' { $errors.Add("$($step.Name): a queue with this name exists and was not created by Spoolfree; skipped.") }
            'SetDefault' { }
            'Keep' { }
        }
    } catch {
        $msg = "$($step.Name): $($step.Action) failed: $($_.Exception.Message)"
        $errors.Add($msg)
        Write-Log $msg
    }
}
if ($PSCmdlet.ShouldProcess('default printer', 'set')) {
    Set-SpoolfreeDefaultPrinter -Name ([string]$manifest.defaultPrinter)
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
