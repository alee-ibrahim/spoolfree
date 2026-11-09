#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or updates the Spoolfree agent. Run once per boot from a GPO
    computer startup script (it is idempotent and quick when nothing changed).

.DESCRIPTION
    1. Installs the agent files in %ProgramFiles%\Spoolfree\current (staged, then swapped in; the replaced
       version is kept in previous\) and the launcher Start-SpoolfreeSync.ps1 in %ProgramFiles%\Spoolfree.
       A newer agent that the PC installed by self-update is kept: this script never downgrades it (unless -Force).
       Files from agents before 0.4.3 (directly in %ProgramFiles%\Spoolfree) are removed.
    2. Stores the server URL and pins the manifest public key in
       HKLM:\SOFTWARE\Spoolfree (ACL: SYSTEM and Administrators only).
    3. If this PC has no machine token yet, reads the shared enrollment token
       from -EnrollmentTokenPath, enrolls, and stores the per-machine token
       encrypted with DPAPI (LocalMachine scope).
    4. Registers the "Spoolfree Sync" task (SYSTEM; at startup and every -SyncIntervalMinutes, later
       the server's AGENT_SYNC_INTERVAL_MINUTES,
       with a random delay) and the "Spoolfree User Default" logon task.

.PARAMETER ServerUrl
    Base URL of the Spoolfree server, e.g. https://spoolfree.example.org

.PARAMETER PublicKey
    Base64 Ed25519 public key printed by `pnpm keygen`. Pinned on first
    install; a different value is ignored unless -Force is given.

.PARAMETER EnrollmentTokenPath
    UNC path of a file containing the enrollment token, on a share that only
    Domain Computers (and admins) can read. Never pass the token itself on
    the command line: GPO script parameters are readable by every user.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\example.org\NETLOGON\spoolfree\Install-SpoolfreeAgent.ps1 `
      -ServerUrl https://spoolfree.example.org -PublicKey "BASE64KEY=" `
      -EnrollmentTokenPath \\fs01.example.org\spoolfree$\enroll.token
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Install')][ValidatePattern('^https?://')][string]$ServerUrl,
    [Parameter(Mandatory, ParameterSetName = 'Install')][string]$PublicKey,
    [Parameter(Mandatory, ParameterSetName = 'Install')][string]$EnrollmentTokenPath,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Spoolfree'),
    [Parameter(ParameterSetName = 'Install')][ValidateRange(5, 240)][int]$SyncIntervalMinutes = 15,
    [Parameter(ParameterSetName = 'Install')][switch]$Force,
    # 0.8.1: stop the agent: removes its scheduled tasks (Spoolfree Sync, Spoolfree User Default, Spoolfree Commands and
    # any test page task left over). Queues, drivers, files and settings stay; see docs/agent.md to remove those too.
    [Parameter(Mandatory, ParameterSetName = 'Uninstall')][switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$files = 'Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1', 'Install-SpoolfreeAgent.ps1'
$launcherName = 'Start-SpoolfreeSync.ps1'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Install-SpoolfreeAgent.ps1 must run as SYSTEM (GPO startup script) or an administrator.'
}

if ($Uninstall) {
    $tasks = @(Get-ScheduledTask -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue)
    foreach ($t in $tasks) {
        Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath '\Spoolfree\' -Confirm:$false -ErrorAction Stop
        Write-Output "Removed scheduled task \Spoolfree\$($t.TaskName)."
    }
    Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Spoolfree' -Name CommandPollMinutes -ErrorAction SilentlyContinue
    Write-Output "Spoolfree agent stopped ($($tasks.Count) task(s) removed). Its queues and files were left in place."
    return
}
if ($ServerUrl -like 'http://*' -and $ServerUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
    Write-Warning 'ServerUrl is not HTTPS. Machine tokens would travel in clear text.'
}
try {
    $pk = [Convert]::FromBase64String($PublicKey)
    if ($pk.Length -ne 32) { throw 'bad length' }
} catch { throw 'PublicKey must be the base64 Ed25519 public key from `pnpm keygen` (32 bytes).' }

# 1. Files ---------------------------------------------------------------------
# This installer's own module (from the share) does the install; the sync later uses current\.
Import-Module (Join-Path $source 'Spoolfree.Agent.psm1') -Force
# Configuration key first (SYSTEM and Administrators only), before anything creates its subkeys.
$reg = 'HKLM:\SOFTWARE\Spoolfree'
if (-not (Test-Path $reg)) {
    New-Item -Path $reg -Force | Out-Null
    Set-SpoolfreeRegistryAcl -Path $reg
}
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Set-SpoolfreeInstallAcl -Path $InstallDir
} elseif (-not (Test-SpoolfreeInstallAcl -Path $InstallDir)) {
    Set-SpoolfreeInstallAcl -Path $InstallDir
}
$currentDir = Join-Path $InstallDir 'current'
$sourceVersion = Get-SpoolfreeFileAgentVersion -Path (Join-Path $source 'Spoolfree.Agent.psm1')
$installedVersion = Get-SpoolfreeFileAgentVersion -Path (Join-Path $currentDir 'Spoolfree.Agent.psm1')
$install = $Force -or -not $installedVersion
if (-not $install) {
    $cmp = ([version]$sourceVersion).CompareTo([version]$installedVersion)
    $missing = @($files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $currentDir $_)) })
    $install = $cmp -gt 0 -or ($cmp -eq 0 -and $missing.Count -gt 0)
    if ($cmp -lt 0) { Write-Output "Keeping agent $installedVersion (installed by self-update; this installer has $sourceVersion)." }
}
if ($install) {
    $bytes = [ordered]@{}
    foreach ($f in $files) { $bytes[$f] = [IO.File]::ReadAllBytes((Join-Path $source $f)) }
    try {
        Install-SpoolfreeAgentFiles -Root $InstallDir -Files $bytes | Out-Null
        # A version installed from the GPO share is not a pending self-update.
        Set-SpoolfreeUpdateState -Values @{ PendingVersion = $null; PendingSha256 = $null; FromVersion = $null; Failures = $null; ConfirmedVersion = $null }
    } catch {
        if (-not $installedVersion) { throw }
        Write-Warning "Installing agent $sourceVersion failed; keeping $($installedVersion): $($_.Exception.Message)"
    }
}
$launcherSrc = Join-Path $source $launcherName
$launcher = Join-Path $InstallDir $launcherName
if (-not (Test-Path $launcher) -or (Get-FileHash $launcherSrc).Hash -ne (Get-FileHash $launcher).Hash) {
    Copy-Item -Path $launcherSrc -Destination $launcher -Force
}
# Agents before 0.4.3 ran from files directly in the install directory.
foreach ($f in 'Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1') {
    Remove-Item -LiteralPath (Join-Path $InstallDir $f) -Force -ErrorAction SilentlyContinue
}

# 2. Configuration ---------------------------------------------------------------
$current = Get-ItemProperty -Path $reg
New-ItemProperty -Path $reg -Name ServerUrl -Value $ServerUrl.TrimEnd('/') -PropertyType String -Force | Out-Null
if (-not $current.PSObject.Properties['PublicKey'] -or $Force) {
    New-ItemProperty -Path $reg -Name PublicKey -Value $PublicKey -PropertyType String -Force | Out-Null
} elseif ($current.PublicKey -ne $PublicKey) {
    Write-Warning 'A different public key is already pinned; keeping it. Use -Force to rotate the key.'
}

# Per-user legacy takeover results (written by the logon task; users can create, not read others')
Initialize-SpoolfreeUserTakeoverDir

# 3. Enrollment -------------------------------------------------------------------
$identity = Get-SpoolfreeComputerIdentity
$cfg = Get-SpoolfreeConfig
$needsEnroll = (-not $cfg.MachineToken) -or ($cfg.ObjectGuid -ne $identity.ObjectGuid) -or $Force
if ($needsEnroll) {
    if (-not (Test-Path -LiteralPath $EnrollmentTokenPath)) { throw "Enrollment token file not found: $EnrollmentTokenPath" }
    $enrollmentToken = (Get-Content -LiteralPath $EnrollmentTokenPath -Raw).Trim()
    $body = @{
        enrollmentToken = $enrollmentToken
        objectGuid      = $identity.ObjectGuid
        dn              = $identity.DistinguishedName
        computerName    = $identity.Name
    }
    $res = Invoke-SpoolfreeHttp -Uri "$($ServerUrl.TrimEnd('/'))/api/agent/enroll" -Method POST -Body $body
    Remove-Variable enrollmentToken, body
    if (-not $res.token) { throw 'Enrollment failed: server returned no token.' }
    New-ItemProperty -Path $reg -Name MachineToken -Value (Protect-SpoolfreeSecret $res.token) -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $reg -Name ObjectGuid -Value $identity.ObjectGuid -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $reg -Name EnrolledAt -Value ((Get-Date).ToUniversalTime().ToString('o')) -PropertyType String -Force | Out-Null
}

# 4. Scheduled tasks ------------------------------------------------------------------
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# The task runs the launcher, which runs current\Invoke-SpoolfreeSync.ps1 and rolls back a failing self-update.
$syncAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
# The server's AGENT_SYNC_INTERVAL_MINUTES (applied by the sync, stored in the registry) wins over the
# -SyncIntervalMinutes parameter, so re-running this script at every startup does not undo it.
$serverInterval = Get-ItemProperty -Path $reg -Name SyncIntervalMinutes -ErrorAction SilentlyContinue
$interval = if ($serverInterval) { [int]$serverInterval.SyncIntervalMinutes } else { $SyncIntervalMinutes }
$triggers = New-SpoolfreeSyncTriggers -IntervalMinutes ((Get-SpoolfreeSyncSchedule $interval).IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' -Action $syncAction `
    -Trigger $triggers -Settings $settings -Principal $system -Force | Out-Null

$userScript = Join-Path $currentDir 'Set-SpoolfreeUserDefault.ps1'
$userAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$userScript`""
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = 'PT1M'
$users = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
Register-ScheduledTask -TaskName 'Spoolfree User Default' -TaskPath '\Spoolfree\' -Action $userAction `
    -Trigger $logon -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)) `
    -Principal $users -Force | Out-Null

if ($needsEnroll) { Start-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' }
Write-Output "Spoolfree agent $(Get-SpoolfreeFileAgentVersion -Path (Join-Path $currentDir 'Spoolfree.Agent.psm1')) installed for $($identity.Name)."
