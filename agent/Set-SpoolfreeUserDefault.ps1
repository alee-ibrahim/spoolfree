#Requires -Version 5.1
<#
.SYNOPSIS
    Runs at user logon (as the user).
    1. Legacy takeover for the user's own \\server\share connections (per-user connections are invisible
       to SYSTEM): matched against the rules the sync task published; removed in "on" mode, only
       reported in "dry-run" mode. Results go to %ProgramData%\Spoolfree\UserTakeover\<SID>.json and
       reach the server with the next sync report.
    2. If the user's default printer was a queue removed by takeover, the replacing Spoolfree queue
       becomes the default.
    3. Applies the default printer chosen by Spoolfree policy, but only when that policy value changed
       since it was last applied for this user, so a user's own choice is otherwise kept.
#>
$ErrorActionPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'Spoolfree.Agent.psm1') -Force

function Set-UserDefault([string]$Name) {
    $escaped = $Name.Replace('\', '\\').Replace("'", "\'")
    $printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escaped'"
    if (-not $printer) { return $false }
    # Stop Windows from replacing the default with the last-used printer.
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -PropertyType DWord -Force | Out-Null
    $result = Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter
    return ($result.ReturnValue -eq 0)
}

$userKey = 'HKCU:\Software\Spoolfree'
if (-not (Test-Path $userKey)) { New-Item -Path $userKey -Force | Out-Null }

# --- 1. Legacy takeover of per-user connections ---------------------------------------------------
$currentDefault = Get-SpoolfreeUserDefaultQueue   # read BEFORE removing anything
$takeover = Get-SpoolfreeTakeoverState
$removedHere = @{}
if ($takeover) {
    $results = New-Object System.Collections.Generic.List[object]
    $servers = @(Get-SpoolfreeProperty $takeover 'servers' | Where-Object { $_ } | ForEach-Object { [string]$_ })
    $rules = @(Get-SpoolfreeProperty $takeover 'rules' | Where-Object { $_ })
    if ($rules.Count -gt 0 -and $servers.Count -gt 0) {
        $queues = Get-SpoolfreeQueueInventory -ConnectionsOnly
        foreach ($r in $rules) {
            $printer = [pscustomobject]@{
                name   = [string](Get-SpoolfreeProperty $r 'printer')
                legacy = [pscustomobject]@{ mode = [string](Get-SpoolfreeProperty $r 'mode'); shares = @(Get-SpoolfreeProperty $r 'shares') }
            }
            $found = @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues $queues -LegacyServers $servers -ConnectionsOnly)
            foreach ($m in $found) {
                $entry = [ordered]@{ printer = $printer.name; queue = $m.Queue; reason = $m.Reason; action = 'would-remove' }
                if ($printer.legacy.mode -eq 'on') {
                    try {
                        Remove-Printer -Name $m.Queue -ErrorAction Stop
                        $entry.action = 'removed'
                        $removedHere[$m.Queue] = $printer.name
                    } catch {
                        $entry.action = 'failed'
                        $entry['error'] = $_.Exception.Message
                    }
                }
                $results.Add([pscustomobject]$entry)
            }
        }
    }
    # Always overwrite, so results of rules that no longer apply disappear.
    $dir = Join-Path $env:ProgramData 'Spoolfree\UserTakeover'
    if (Test-Path $dir) {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $json = if ($results.Count) { ConvertTo-Json -InputObject @($results.ToArray()) -Depth 3 -Compress } else { '[]' }
        Set-Content -LiteralPath (Join-Path $dir "$sid.json") -Value $json -Encoding UTF8
    }
}

# --- 2. Default printer carry-over -------------------------------------------------------------------
# A carry-over that could not be applied yet (Spoolfree queue not created yet) is retried at the next logon.
$pending = (Get-ItemProperty -Path $userKey -Name PendingDefault).PendingDefault
if ($pending) {
    if (Set-UserDefault $pending) { Remove-ItemProperty -Path $userKey -Name PendingDefault }
}
if ($currentDefault) {
    $map = Merge-SpoolfreeRemovedMap -Previous (Get-SpoolfreeProperty $takeover 'removedMap') -New $removedHere
    $replacement = $null
    foreach ($k in $map.Keys) { if ($k -ieq $currentDefault) { $replacement = $map[$k]; break } }
    if ($replacement -and -not (Get-CimInstance -ClassName Win32_Printer -Filter ("Name='{0}'" -f $currentDefault.Replace('\', '\\').Replace("'", "\'")))) {
        if (-not (Set-UserDefault $replacement)) {
            New-ItemProperty -Path $userKey -Name PendingDefault -Value $replacement -PropertyType String -Force | Out-Null
        }
    }
}

# --- 2b. Default printer across rename / replace --------------------------------------------------------
# The sync re-creates a queue on Replace or rename; Windows then drops it as the user's default. The default
# recorded at the previous logon is restored when its queue was re-created since then.
$lastKnown = Get-ItemProperty -Path $userKey -ErrorAction SilentlyContinue
$lastName = if ($lastKnown -and $lastKnown.PSObject.Properties['LastKnownDefault']) { [string]$lastKnown.LastKnownDefault } else { '' }
$lastAt = if ($lastKnown -and $lastKnown.PSObject.Properties['LastKnownDefaultAt']) { [string]$lastKnown.LastKnownDefaultAt } else { '' }
$existingNames = @(Get-Printer | ForEach-Object { [string]$_.Name })
$restore = Get-SpoolfreeDefaultRestore -CurrentDefault $currentDefault -LastKnownDefault $lastName -LastKnownAt $lastAt `
    -Recreated (Get-SpoolfreeProperty $takeover 'recreated') -Existing $existingNames
if ($restore -and (Set-UserDefault $restore)) { $currentDefault = $restore }

# --- 3. Policy default --------------------------------------------------------------------------------
$wanted = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Spoolfree\Public' -Name DefaultPrinter).DefaultPrinter
$applied = (Get-ItemProperty -Path $userKey -Name AppliedDefault).AppliedDefault
if ($wanted -and $applied -ne $wanted) {
    if (Set-UserDefault $wanted) {
        New-ItemProperty -Path $userKey -Name AppliedDefault -Value $wanted -PropertyType String -Force | Out-Null
    }
}

# --- 4. Remember this user's default for the next logon (rename/replace restore) ------------------------
$now = Get-SpoolfreeUserDefaultQueue
if ($now) {
    New-ItemProperty -Path $userKey -Name LastKnownDefault -Value $now -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $userKey -Name LastKnownDefaultAt -Value ([datetime]::UtcNow.ToString('o')) -PropertyType String -Force | Out-Null
}
