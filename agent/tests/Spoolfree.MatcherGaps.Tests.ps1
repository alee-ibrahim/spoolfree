#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# 0.9.2: matcher gaps found on 0.9.1: vendor TCP/IP monitor ports read under the wrong registry key (classified dead),
# serial/alias variants (MFP<serial> vs "<model>-<serial>") and WSD ports matched by a current address.
# Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:ipp = '6a1b2c3d-0000-4000-8000-00000000aa01'
    $script:wsd = '6a1b2c3d-0000-4000-8000-00000000bb02'
    $script:far = '6a1b2c3d-0000-4000-8000-00000000ee05'
    $script:mac = '001122334455'
    $script:addr = @('copier1.example.org', '192.0.2.20')
    function P([string[]]$aliases = @(), [string[]]$serials = @(), [string[]]$macs = @($script:mac)) {
        [pscustomobject]@{ id = 'p1'; name = 'Office Copier'; host = 'copier1.example.org'; ippUrl = 'http://copier1.example.org:631/ipp/print'; revision = 1
            legacy = [pscustomobject]@{ mode = 'on'; shares = @() }
            deviceUuid = $script:ipp; deviceUuids = @($script:ipp); macAddresses = $macs; serialNumbers = $serials; legacyAliases = $aliases }
    }
    function Q([string]$name, [string]$port) { [pscustomobject]@{ Name = $name; Type = 'Local'; PortName = $port; DriverName = 'Generic Vendor PCL6'; Comment = '' } }
    function Wsd([string[]]$uuids, [string[]]$addresses = @(), [string[]]$current = @(), [string[]]$macs = @(), [string[]]$names = @()) {
        [pscustomobject]@{ Monitor = 'WSD Port'; Description = 'WSD Port'; HostAddress = ''; Addresses = $addresses; Uuids = $uuids; Mac = $null; Macs = $macs; Names = $names; CurrentAddresses = $current }
    }
    function M($queues, $ports, $printer = (P)) {
        return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @($queues) -Ports $ports -PrinterAddresses $script:addr -AnyMode)
    }
}

Describe 'Vendor TCP/IP monitor ports (fix 1)' {
    BeforeAll {
        $script:root = 'HKCU:\Software\SpoolfreePesterTest\Monitors'
        Remove-Item -LiteralPath 'HKCU:\Software\SpoolfreePesterTest' -Recurse -Force -ErrorAction SilentlyContinue
        # Created with .NET: New-Item treats the "/" in "TCP/IP" as a path separator.
        $base = 'Software\SpoolfreePesterTest\Monitors'
        $hp = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$base\HP Standard TCP/IP Port\Ports\HPGenericLaserMFP")
        $hp.SetValue('IPAddress', '192.0.2.20'); $hp.SetValue('HostName', ''); $hp.SetValue('HWAddress', '00-11-22-33-44-55')
        $hp.SetValue('PortNumber', 9100, [Microsoft.Win32.RegistryValueKind]::DWord); $hp.Close()
        $std = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$base\Standard TCP/IP Port\Ports\IP_198.51.100.9")
        $std.SetValue('HostName', '198.51.100.9'); $std.Close()
        foreach ($k in "$base\Local Port", "$base\WSD Port\Ports") { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($k).Close() }
    }
    AfterAll { Remove-Item -LiteralPath 'HKCU:\Software\SpoolfreePesterTest' -Recurse -Force -ErrorAction SilentlyContinue }

    It 'finds the port when Get-PrinterPort reports a monitor name that is not the registry key' {
        # PortMonitor is the name the monitor reports ("WSD Port Monitor" is the key "WSD Port"); 0.9.0 only looked there.
        foreach ($monitor in 'HP Standard TCP/IP Port Monitor', 'HPTCPMON', '', 'HP Standard TCP/IP Port') {
            $v = Get-SpoolfreeMonitorPortValues -PortName 'HPGenericLaserMFP' -Monitor $monitor -Root $script:root
            $mv = ConvertFrom-SpoolfreeMonitorPortValues -Values $v
            $mv.Host | Should -Be '192.0.2.20'
            $mv.Mac | Should -Be $script:mac
        }
        $std = ConvertFrom-SpoolfreeMonitorPortValues -Values (Get-SpoolfreeMonitorPortValues -PortName 'IP_198.51.100.9' -Monitor 'Standard TCP/IP Port' -Root $script:root)
        $std.Host | Should -Be '198.51.100.9'
        (Get-SpoolfreeMonitorPortValues -PortName 'NO_SUCH_PORT' -Monitor 'HPTCPMON' -Root $script:root).Count | Should -Be 0
    }
    It 'orders the monitor keys: reported name, name without " Monitor", description, HP, Standard, then the rest' {
        $keys = @('Local Port', 'Standard TCP/IP Port', 'HP Standard TCP/IP Port', 'WSD Port', 'Vendor Port', 'USB Monitor')
        Get-SpoolfreeMonitorKeyOrder -Monitor 'HP Standard TCP/IP Port Monitor' -Description 'HP Standard TCP/IP Port' -Keys $keys |
            Should -Be @('HP Standard TCP/IP Port', 'Standard TCP/IP Port', 'Vendor Port')
        Get-SpoolfreeMonitorKeyOrder -Monitor 'vendor port' -Keys $keys | Select-Object -First 1 | Should -Be 'Vendor Port'
    }
    It 'classifies a model-named HP port with a registry host as legacy-of-managed, not dead' {
        $ports = @{ 'HPGenericLaserMFP' = [pscustomobject]@{ Monitor = 'HP Standard TCP/IP Port Monitor'; Description = 'HP Standard TCP/IP Port'; HostAddress = '192.0.2.20'; Addresses = @('192.0.2.20'); Uuids = @(); Mac = $script:mac; Macs = @(); Names = @() } }
        $u = @(Get-SpoolfreeUnmanagedQueues -Queues @((Q 'HP Generic Laser MFP' 'HPGenericLaserMFP')) -Ports $ports -Printers @([pscustomobject]@{ Printer = (P); Addresses = $script:addr }))
        $u[0]['class'] | Should -Be 'legacy-of-managed'
        $u[0]['host'] | Should -Be '192.0.2.20'
    }
    It 'matches a vendor port that only has a MAC in the registry' {
        $ports = @{ 'HPX' = [pscustomobject]@{ Monitor = 'HPTCPMON'; Description = ''; HostAddress = ''; Addresses = @(); Uuids = @(); Mac = $script:mac; Macs = @(); Names = @() } }
        $r = M (Q 'HP X' 'HPX') $ports
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'mac'
    }
}

Describe 'Serial and alias variants (fix 2)' {
    It 'matches an MFP+serial alias to a "model-serial (Copy 1)" WSD queue name' {
        $ports = @{ 'WSD-t' = (Wsd @($script:wsd)) }
        $r = M (Q 'VENDOR e-MODEL2518A-CXA912345 (Copy 1)' 'WSD-t') $ports (P @('MFP12345678'))
        $r.Count | Should -Be 0
        $r = M (Q 'VENDOR e-MODEL2518A-12345678 (Copy 1)' 'WSD-t') $ports (P @('MFP12345678'))
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'alias'
        (M (Q 'Copier WSD' 'WSD-t') @{ 'WSD-t' = (Wsd @($script:wsd) @() @() @() @('VENDOR e-MODEL2518A-12345678')) } (P @('mfp12345678')))[0].MatchBy | Should -Be 'alias'
    }
    It 'strips common prefixes and compares case-insensitively' {
        Find-SpoolfreeNameToken -Text 'Vendor MFP abc12x99' -Tokens @('MFP-ABC12X99') | Should -Be 'MFP-ABC12X99'
        Find-SpoolfreeNameToken -Text 'Vendor 123456789' -Tokens @('SN123456789') | Should -Be 'SN123456789'
    }
    It 'needs a whole run of at least 6 digits' {
        Find-SpoolfreeNameToken -Text 'VENDOR e-MODEL2518A-12345 (Copy 1)' -Tokens @('MFP12345') | Should -BeNullOrEmpty
        Find-SpoolfreeNameToken -Text 'VENDOR 9123456789' -Tokens @('MFP12345678') | Should -BeNullOrEmpty
        Find-SpoolfreeNameToken -Text 'VENDOR 1234567890' -Tokens @('MFP12345678') | Should -BeNullOrEmpty
        Find-SpoolfreeNameToken -Text 'Model 2518' -Tokens @('MFP25180') | Should -BeNullOrEmpty
    }
}

Describe 'WSD ports matched by a current address (fix 2)' {
    It 'matches a WSD port with another UUID whose present device reports the printer''s IP' {
        # 0.9.3: and the printer's MAC (the node of the device's version-1 UUID) and model.
        $v1 = 'e3248000-80ce-11db-8000-001122334455'
        $p = P; $p | Add-Member -NotePropertyName model -NotePropertyValue 'VENDOR MFP 4520'
        $r = M (Q 'VENDOR MFP (Copy 1)' 'WSD-t') @{ 'WSD-t' = (Wsd @($v1) @('192.0.2.20') @('192.0.2.20') @() @('VENDOR MFP 4520 series')) } $p
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'address'
        $r[0].Reason | Should -Match 'current address 192\.0\.2\.20'
        # The PC's own Spoolfree IPP port of the printer at the same address does not make it ambiguous.
        $ports = @{ 'WSD-t' = (Wsd @($v1) @('192.0.2.20') @('192.0.2.20') @() @('VENDOR MFP 4520 series')); 'SF' = (Wsd @($script:ipp) @('192.0.2.20') @('192.0.2.20')) }
        (M (Q 'VENDOR MFP (Copy 1)' 'WSD-t') $ports $p).Count | Should -Be 1
    }
    It 'keeps the 0.4.5 protection: a recorded (possibly stale) address alone never matches' {
        (M (Q 'Other MFP' 'WSD-t') @{ 'WSD-t' = (Wsd @($script:wsd) @('192.0.2.20')) }).Count | Should -Be 0
    }
    It 'does not match when the device''s MAC contradicts, the address is a host name, or another device reports it' {
        (M (Q 'Other MFP' 'WSD-t') @{ 'WSD-t' = (Wsd @($script:wsd) @('192.0.2.20') @('192.0.2.20') @('00aabbccddee')) }).Count | Should -Be 0
        (M (Q 'Other MFP' 'WSD-t') @{ 'WSD-t' = (Wsd @($script:wsd) @('copier1.example.org') @('copier1.example.org')) }).Count | Should -Be 0
        $ports = @{ 'WSD-t' = (Wsd @($script:wsd) @('192.0.2.20') @('192.0.2.20')); 'WSD-far' = (Wsd @($script:far) @('192.0.2.20') @('192.0.2.20')) }
        (M (Q 'Other MFP' 'WSD-t') $ports).Count | Should -Be 0
    }
    It 'takes current addresses only from present device nodes' {
        $devices = @(
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDProvider\urn:uuid:$($script:wsd)"; ContainerId = ''; Values = @('http://192.0.2.20:5357/x'); Names = @(); Present = $true },
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDProvider\urn:uuid:$($script:far)"; ContainerId = ''; Values = @('http://192.0.2.21:5357/x'); Names = @(); Present = $false },
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDProvider\urn:uuid:$($script:far)"; ContainerId = ''; Values = @('http://192.0.2.22:5357/x'); Names = @() }
        )
        $info = ConvertTo-SpoolfreeDeviceInfo -Devices $devices
        $info[$script:wsd].CurrentHosts | Should -Be @('192.0.2.20')
        @($info[$script:far].CurrentHosts).Count | Should -Be 0
        $info[$script:far].Hosts | Should -Contain '192.0.2.21'
        (Get-SpoolfreeWsdPortData -Values @{ 'Printer UUID' = $script:wsd } -DeviceInfo $info).CurrentHosts | Should -Be @('192.0.2.20')
    }
}
