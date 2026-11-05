#Requires -Version 5.1
<#
.SYNOPSIS
    Runs at user logon (as the user). Applies the default printer chosen by
    Spoolfree policy, but only when that policy value changed since it was
    last applied for this user, so a user's own choice is otherwise kept.
#>
$ErrorActionPreference = 'SilentlyContinue'
$wanted = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Spoolfree\Public' -Name DefaultPrinter).DefaultPrinter
if (-not $wanted) { exit 0 }

$userKey = 'HKCU:\Software\Spoolfree'
if (-not (Test-Path $userKey)) { New-Item -Path $userKey -Force | Out-Null }
$applied = (Get-ItemProperty -Path $userKey -Name AppliedDefault).AppliedDefault
if ($applied -eq $wanted) { exit 0 }

$escaped = $wanted.Replace('\', '\\').Replace("'", "\'")
$printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escaped'"
if (-not $printer) { exit 0 }  # queue not installed yet; try again next logon

# Stop Windows from replacing the default with the last-used printer.
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name LegacyDefaultPrinterMode -Value 1 -PropertyType DWord -Force | Out-Null
$result = Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter
if ($result.ReturnValue -eq 0) {
    New-ItemProperty -Path $userKey -Name AppliedDefault -Value $wanted -PropertyType String -Force | Out-Null
}
