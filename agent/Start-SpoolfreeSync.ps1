#Requires -Version 5.1
<#
.SYNOPSIS
    Launcher for the "Spoolfree Sync" task: runs <InstallDir>\current\Invoke-SpoolfreeSync.ps1 and guards
    self-updates.

.DESCRIPTION
    Install-SpoolfreeAgent.ps1 installs this file next to the current\ folder. A self-update never replaces it,
    so it can still roll back a version that does not run.

    - A version installed by self-update is pending (HKLM:\SOFTWARE\Spoolfree\Update, PendingVersion) until one of
      its syncs verifies a signed manifest; the sync then writes ConfirmedVersion and the launcher clears the
      pending state.
    - A run of a pending version that ends without that confirmation counts as a failure: a crash, a script error,
      a rejected manifest or a timeout. Exit codes 3 (not enrolled) and 4 (server unreachable) say nothing about
      the code and are not counted.
    - After two failures the launcher moves current\ aside, renames previous\ back to current\, records the bundle
      hash as bad (that bundle is never installed again here) and runs the previous version at once, which reports
      the rollback.
    - An interrupted swap is repaired first: with no current\ folder, previous\ (or a complete staging\) becomes
      current\; a pending version that is not the one in current\ is forgotten.
#>
[CmdletBinding()]
param(
    # Default: this script's folder. (Not $PSScriptRoot as the default: Windows PowerShell 5.1 leaves it empty there.)
    [string]$Root,
    [string]$StateKey = 'HKLM:\SOFTWARE\Spoolfree\Update',
    [string]$LogPath = (Join-Path $env:ProgramData 'Spoolfree\Logs\sync.log'),
    [int]$TimeoutMinutes = 12
)

function Write-LauncherLog([string]$LogFile, [string]$Message) {
    try { Add-Content -Path $LogFile -Value ('{0:u} launcher: {1}' -f (Get-Date).ToUniversalTime(), $Message) } catch { }
}

function Get-LauncherState([string]$Key) {
    $s = @{}
    if (Test-Path $Key) {
        $p = Get-ItemProperty -Path $Key
        foreach ($n in 'PendingVersion', 'PendingSha256', 'FromVersion', 'Failures', 'ConfirmedVersion', 'BadSha256', 'LastState', 'LastVersion') {
            if ($p.PSObject.Properties[$n]) { $s[$n] = $p.$n }
        }
    }
    return $s
}

function Set-LauncherState([string]$Key, [hashtable]$Values) {
    if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
    foreach ($n in @($Values.Keys)) {
        $v = $Values[$n]
        if ($null -eq $v) { Remove-ItemProperty -Path $Key -Name $n -ErrorAction SilentlyContinue }
        elseif ($v -is [int]) { New-ItemProperty -Path $Key -Name $n -Value $v -PropertyType DWord -Force | Out-Null }
        else { New-ItemProperty -Path $Key -Name $n -Value ([string]$v) -PropertyType String -Force | Out-Null }
    }
}

function Get-LauncherVersion([string]$Dir) {
    $f = Join-Path $Dir 'Spoolfree.Agent.psm1'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    $m = [regex]::Match([IO.File]::ReadAllText($f), '(?m)^\$script:AgentVersion\s*=\s*''(\d+\.\d+\.\d+)''')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Repair-SpoolfreeCurrent([string]$Root) {
    <# After an interrupted swap there may be no current\ folder: restore one. Returns what was used, or $null. #>
    $current = Join-Path $Root 'current'
    if (Test-Path -LiteralPath $current) { return $null }
    $previous = Join-Path $Root 'previous'
    $staging = Join-Path $Root 'staging'
    if (Test-Path -LiteralPath (Join-Path $previous 'Invoke-SpoolfreeSync.ps1')) { [IO.Directory]::Move($previous, $current); return 'previous' }
    if (Test-Path -LiteralPath (Join-Path $staging 'Invoke-SpoolfreeSync.ps1')) { [IO.Directory]::Move($staging, $current); return 'staging' }
    return $null
}

function Clear-LauncherPending([string]$Key, [hashtable]$Extra = @{}) {
    $v = @{ PendingVersion = $null; PendingSha256 = $null; FromVersion = $null; Failures = $null; ConfirmedVersion = $null }
    foreach ($k in $Extra.Keys) { $v[$k] = $Extra[$k] }
    Set-LauncherState -Key $Key -Values $v
}

function Invoke-SpoolfreeRollback([string]$Root, [string]$Key, [string]$Reason, [string]$LogFile) {
    <# Puts previous\ back as current\ and records the pending bundle as bad. Returns $true when it rolled back. #>
    $s = Get-LauncherState $Key
    $pending = [string]$s['PendingVersion']
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $current = Join-Path $Root 'current'
    $previous = Join-Path $Root 'previous'
    $failed = Join-Path $Root 'failed'
    if (-not (Test-Path -LiteralPath (Join-Path $previous 'Invoke-SpoolfreeSync.ps1'))) {
        Clear-LauncherPending $Key @{ BadSha256 = $s['PendingSha256']; LastState = 'failed'; LastVersion = $pending
            LastError = "Agent $pending $Reason; there is no previous version to roll back to."; LastAt = $now }
        Write-LauncherLog $LogFile "agent $pending $Reason; no previous version to roll back to."
        return $false
    }
    if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
    if (Test-Path -LiteralPath $current) { [IO.Directory]::Move($current, $failed) }
    [IO.Directory]::Move($previous, $current)
    Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
    # 0.8.1 (L5): the "Spoolfree Commands" task belongs to the version that made it; the version rolled back to makes
    # its own again (0.8+) or has none (older versions do not know -CommandsOnly).
    Remove-LauncherCommandTask $LogFile
    $back = Get-LauncherVersion $current
    Clear-LauncherPending $Key @{ BadSha256 = $s['PendingSha256']; LastState = 'rolled-back'; LastVersion = $pending
        LastError = "Agent $pending $Reason; rolled back to $back."; LastAt = $now }
    Write-LauncherLog $LogFile "agent $pending $Reason; rolled back to $back."
    return $true
}

function Remove-LauncherCommandTask([string]$LogFile) {
    <# Removes the "Spoolfree Commands" poll task (and its interval) after a rollback. Never throws. #>
    try {
        if (Get-ScheduledTask -TaskName 'Spoolfree Commands' -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName 'Spoolfree Commands' -TaskPath '\Spoolfree\' -Confirm:$false -ErrorAction Stop
            Write-LauncherLog $LogFile 'removed the Spoolfree Commands task of the rolled-back version.'
        }
        Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Spoolfree' -Name CommandPollMinutes -ErrorAction SilentlyContinue
    } catch {
        Write-LauncherLog $LogFile "could not remove the Spoolfree Commands task: $($_.Exception.Message)"
    }
}

function Invoke-SpoolfreeChild([string]$Script, [int]$TimeoutMinutes) {
    <# Runs a sync script in a child Windows PowerShell; returns its exit code, or -1 after a timeout (killed). #>
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    if (-not $p.WaitForExit([Math]::Max(1, $TimeoutMinutes) * 60000)) {
        try { $p.Kill() } catch { }
        return -1
    }
    return $p.ExitCode
}

function Invoke-SpoolfreeLauncher {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Key,
        [string]$LogFile,
        [int]$TimeoutMinutes = 12
    )
    $repaired = Repair-SpoolfreeCurrent $Root
    if ($repaired) { Write-LauncherLog $LogFile "current\ was missing; restored it from $repaired\." }
    $current = Join-Path $Root 'current'
    $s = Get-LauncherState $Key
    if ($s['PendingVersion']) {
        if ((Get-LauncherVersion $current) -ne $s['PendingVersion']) {
            Write-LauncherLog $LogFile "pending agent $($s['PendingVersion']) is not in current\ (swap did not happen); forgetting it."
            Clear-LauncherPending $Key
        } elseif ([int]$s['Failures'] -ge 2) {
            Invoke-SpoolfreeRollback $Root $Key 'failed to run twice' $LogFile | Out-Null
        }
        $s = Get-LauncherState $Key
    }
    $pendingBefore = [string]$s['PendingVersion']
    $sync = Join-Path $current 'Invoke-SpoolfreeSync.ps1'
    if (-not (Test-Path -LiteralPath $sync)) {
        Write-LauncherLog $LogFile "$sync not found: re-run Install-SpoolfreeAgent.ps1."
        return 2
    }
    $code = Invoke-SpoolfreeChild $sync $TimeoutMinutes
    if (-not $pendingBefore) { return $code }

    $after = Get-LauncherState $Key
    if ([string]$after['PendingVersion'] -ne $pendingBefore) { return $code }
    if ([string]$after['ConfirmedVersion'] -eq $pendingBefore) {
        Clear-LauncherPending $Key @{ LastState = 'updated'; LastVersion = $pendingBefore; LastError = $null; LastAt = (Get-Date).ToUniversalTime().ToString('o') }
        Write-LauncherLog $LogFile "agent $pendingBefore ran and verified a manifest; update confirmed."
        return $code
    }
    if ($code -eq 3 -or $code -eq 4) {
        Write-LauncherLog $LogFile "agent $pendingBefore exited $code (not enrolled or server unreachable); not counted."
        return $code
    }
    $failures = [int]$after['Failures'] + 1
    Set-LauncherState -Key $Key -Values @{ Failures = $failures }
    Write-LauncherLog $LogFile "agent $pendingBefore failed to run (exit code $code; failure $failures of 2)."
    if ($failures -ge 2) {
        if (Invoke-SpoolfreeRollback $Root $Key "failed to run twice (last exit code $code)" $LogFile) {
            $code = Invoke-SpoolfreeChild (Join-Path $current 'Invoke-SpoolfreeSync.ps1') $TimeoutMinutes
        }
    }
    return $code
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
        $code = Invoke-SpoolfreeLauncher -Root $Root -Key $StateKey -LogFile $LogPath -TimeoutMinutes $TimeoutMinutes
        exit ([int]$code)
    } catch {
        Write-LauncherLog $LogPath "failed: $($_.Exception.Message)"
        exit 10
    }
}
