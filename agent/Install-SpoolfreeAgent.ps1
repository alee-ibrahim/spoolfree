#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or updates the Spoolfree agent. Run once per boot from a GPO
    computer startup script (it is idempotent and quick when nothing changed).

.DESCRIPTION
    1. Copies the agent files to %ProgramFiles%\Spoolfree.
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
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^https?://')][string]$ServerUrl,
    [Parameter(Mandatory)][string]$PublicKey,
    [Parameter(Mandatory)][string]$EnrollmentTokenPath,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Spoolfree'),
    [ValidateRange(5, 240)][int]$SyncIntervalMinutes = 15,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$files = 'Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Install-SpoolfreeAgent.ps1 must run as SYSTEM (GPO startup script) or an administrator.'
}
if ($ServerUrl -like 'http://*' -and $ServerUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
    Write-Warning 'ServerUrl is not HTTPS. Machine tokens would travel in clear text.'
}
try {
    $pk = [Convert]::FromBase64String($PublicKey)
    if ($pk.Length -ne 32) { throw 'bad length' }
} catch { throw 'PublicKey must be the base64 Ed25519 public key from `pnpm keygen` (32 bytes).' }

# 1. Files ---------------------------------------------------------------------
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
foreach ($f in $files) {
    $src = Join-Path $source $f
    $dst = Join-Path $InstallDir $f
    if (-not (Test-Path $dst) -or (Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash) {
        Copy-Item -Path $src -Destination $dst -Force
    }
}
Import-Module (Join-Path $InstallDir 'Spoolfree.Agent.psm1') -Force

# 2. Configuration ---------------------------------------------------------------
$reg = 'HKLM:\SOFTWARE\Spoolfree'
if (-not (Test-Path $reg)) {
    New-Item -Path $reg -Force | Out-Null
    Set-SpoolfreeRegistryAcl -Path $reg
}
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
$syncScript = Join-Path $InstallDir 'Invoke-SpoolfreeSync.ps1'
$syncAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$syncScript`""
# The server's AGENT_SYNC_INTERVAL_MINUTES (applied by the sync, stored in the registry) wins over the
# -SyncIntervalMinutes parameter, so re-running this script at every startup does not undo it.
$serverInterval = Get-ItemProperty -Path $reg -Name SyncIntervalMinutes -ErrorAction SilentlyContinue
$interval = if ($serverInterval) { [int]$serverInterval.SyncIntervalMinutes } else { $SyncIntervalMinutes }
$triggers = New-SpoolfreeSyncTriggers -IntervalMinutes ((Get-SpoolfreeSyncSchedule $interval).IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' -Action $syncAction `
    -Trigger $triggers -Settings $settings -Principal $system -Force | Out-Null

$userScript = Join-Path $InstallDir 'Set-SpoolfreeUserDefault.ps1'
$userAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$userScript`""
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = 'PT1M'
$users = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
Register-ScheduledTask -TaskName 'Spoolfree User Default' -TaskPath '\Spoolfree\' -Action $userAction `
    -Trigger $logon -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)) `
    -Principal $users -Force | Out-Null

if ($needsEnroll) { Start-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' }
Write-Output "Spoolfree agent $(Get-SpoolfreeAgentVersion) installed for $($identity.Name)."
