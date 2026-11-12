#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# 0.9.3: false legacy matches seen on 0.9.2. A WSD/IPP queue of one device (MAC in its queue name BRN<mac> and in its
# UUID) was matched to a different Spoolfree printer (another MAC, another model) at an address that the old
# device's stale Plug and Play record or current-address lookup reported. Every test here fails on 0.9.2.
# Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    # The Spoolfree printer: MAC Y, model "Vendor DCP-L1234CDW", at 192.0.2.30.
    $script:macY = '00aa00bb00cc'
    $script:uuidY = 'e3248000-80ce-11db-8000-00aa00bb00cc'
    # The old device: MAC X, another model; its IPP/WSD UUID ends in X and its default queue name is BRN<X>.
    $script:macX = '0011aa22bb33'
    $script:uuidX = 'e3248000-80ce-11db-8000-0011aa22bb33'
    $script:queueX = 'BRN0011AA22BB33'
    $script:addr = @('copier.example.org', '192.0.2.30')
    function P([string]$mode = 'on', [string[]]$macs = @($script:macY), [string]$model = 'Vendor DCP-L1234CDW', [string[]]$serials = @()) {
        [pscustomobject]@{ id = 'p1'; name = 'Office Copier'; host = 'copier.example.org'; ippUrl = 'http://copier.example.org:631/ipp/print'; revision = 1; model = $model
            legacy = [pscustomobject]@{ mode = $mode; shares = @() }
            deviceUuid = $script:uuidY; deviceUuids = @($script:uuidY); macAddresses = $macs; serialNumbers = $serials; legacyAliases = @() }
    }
    function Q([string]$name, [string]$port, [string]$driver = 'Microsoft IPP Class Driver') { [pscustomobject]@{ Name = $name; Type = 'Local'; PortName = $port; DriverName = $driver; Comment = '' } }
    function Wsd([string[]]$uuids, [string[]]$addresses = @(), [string[]]$current = @(), [string[]]$macs = @(), [string[]]$names = @(), [string]$description = 'WSD Port', [string[]]$serials = @()) {
        [pscustomobject]@{ Monitor = 'WSD Port'; Description = $description; HostAddress = ''; Addresses = $addresses; Uuids = $uuids; Mac = $null; Macs = $macs; Names = $names; CurrentAddresses = $current; Serials = $serials; Models = @() }
    }
    function Tcp([string]$hostAddress, [string[]]$addresses = @(), [string]$mac = $null) {
        [pscustomobject]@{ Monitor = 'Standard TCP/IP Port'; Description = 'Standard TCP/IP Port'; HostAddress = $hostAddress; Addresses = $addresses; Uuids = @(); Mac = $mac; Macs = @(); Names = @() }
    }
    function M($queues, $ports, $printer = (P)) {
        return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @($queues) -Ports $ports -PrinterAddresses $script:addr -AnyMode)
    }
    function U($queues, $ports, $printer = (P)) {
        return , @(Get-SpoolfreeUnmanagedQueues -Queues @($queues) -Ports $ports -Printers @([pscustomobject]@{ Printer = $printer; Addresses = $script:addr }))
    }
}

Describe 'A conflicting identity wins over an address match (fix 1)' {
    It 'does not match an IPP queue named BRN<X> whose UUID ends in X at the printer''s current address' {
        $ports = @{ 'WSD-ipp-x' = (Wsd @($script:uuidX) @('192.0.2.30') @('192.0.2.30') -description 'IPP Port') }
        (M (Q $script:queueX 'WSD-ipp-x') $ports).Count | Should -Be 0
        $u = U (Q $script:queueX 'WSD-ipp-x') $ports
        $u[0]['class'] | Should -Be 'other-network'
        $u[0]['matchedPrinter'] | Should -BeNullOrEmpty
    }
    It 'does not match a WSD queue whose UUID ends in another MAC, even by a recorded address' {
        $ports = @{ 'WSD-x' = (Wsd @($script:uuidX) @('192.0.2.30') @('192.0.2.30') -names @('Vendor HL-L5678DN series')) }
        (M (Q 'Vendor HL-L5678DN series Printer' 'WSD-x' 'Vendor Laser Type1 Class Driver') $ports).Count | Should -Be 0
        $p = P; $p.deviceUuids = @(); $p.deviceUuid = $null
        (M (Q 'Vendor HL-L5678DN series Printer' 'WSD-x') $ports $p).Count | Should -Be 0
    }
    It 'does not match a TCP/IP port at the printer''s IP whose host name or port MAC is another device''s' {
        (M (Q 'Vendor HL-L5678DN series' $script:queueX 'Vendor HL-L5678DN series') @{ $script:queueX = (Tcp $script:queueX @('192.0.2.30')) }).Count | Should -Be 0
        (M (Q 'Old Laser' 'IP_192.0.2.30' 'Generic PCL Driver') @{ 'IP_192.0.2.30' = (Tcp '192.0.2.30' @('192.0.2.30') $script:macX) }).Count | Should -Be 0
        $u = U (Q 'Old Laser' 'IP_192.0.2.30' 'Generic PCL Driver') @{ 'IP_192.0.2.30' = (Tcp '192.0.2.30' @('192.0.2.30') $script:macX) }
        $u[0]['class'] | Should -Be 'other-network'
        # The printer's own MAC in the host name still matches, and so does its UUID.
        $r = M (Q 'Vendor DCP-L1234CDW series' 'BRN00AA00BB00CC') @{ 'BRN00AA00BB00CC' = (Tcp 'BRN00AA00BB00CC') }
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'mac'
        (M (Q 'X' 'WSD-y') @{ 'WSD-y' = (Wsd @($script:uuidY)) })[0].MatchBy | Should -Be 'uuid'
    }
    It 'does not match when the device reports another serial number, even if its MAC agrees' {
        $p = P -serials @('SERIALA1001')
        $ports = @{ 'WSD-s' = (Wsd @('6a1b2c3d-0000-4000-8000-0000000000c1') -macs @($script:macY) -serials @('SERIALB2002')) }
        (M (Q 'Vendor DCP-L1234CDW series Printer' 'WSD-s') $ports $p).Count | Should -Be 0
    }
    It 'reads MACs from Brother names and version-1 UUIDs only' {
        Get-SpoolfreeNameMacs @('BRN0011AA22BB33', 'brw0011aa22bb34.local', 'Printer BRN0011AA22BB35 (Copy 1)', '0011aa22bb36', 'BRNX0011AA22BB37') |
            Should -Be @('0011aa22bb33', '0011aa22bb34', '0011aa22bb35', '0011aa22bb36')
        Get-SpoolfreeUuidMac $script:uuidX | Should -Be $script:macX
        Get-SpoolfreeUuidMac '6a1b2c3d-0000-4000-8000-0011aa22bb33' | Should -BeNullOrEmpty
        # A random version-1 node has the multicast bit set and is not a MAC.
        Get-SpoolfreeUuidMac 'e3248000-80ce-11db-8000-0111aa22bb33' | Should -BeNullOrEmpty
    }
}

Describe 'Address-only matches need the device there to report the printer''s model and MAC (fix 2)' {
    It 'does not match a WSD port by current address when its device reports no MAC' {
        $ports = @{ 'WSD-v' = (Wsd @('6a1b2c3d-0000-4000-8000-0000000000a1') @('192.0.2.30') @('192.0.2.30') -names @('Vendor DCP-L1234CDW series')) }
        (M (Q 'Copier WSD' 'WSD-v') $ports).Count | Should -Be 0
    }
    It 'does not match a WSD port by current address when its device reports another model' {
        $v1 = 'e3248000-80ce-11db-8001-00aa00bb00cc'
        $ports = @{ 'WSD-v' = (Wsd @($v1) @('192.0.2.30') @('192.0.2.30') -names @('Vendor HL-L5678DN series')) }
        (M (Q 'Copier WSD' 'WSD-v') $ports).Count | Should -Be 0
        # Same MAC and model: it counts.
        $ports = @{ 'WSD-v' = (Wsd @($v1) @('192.0.2.30') @('192.0.2.30') -names @('Vendor DCP-L1234CDW series')) }
        $r = M (Q 'Copier WSD' 'WSD-v') $ports
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'address'
    }
    It 'does not match a WSD port without a UUID by its recorded address alone' {
        $p = P; $p.deviceUuids = @(); $p.deviceUuid = $null
        (M (Q 'Copier WSD' 'WSD-n') @{ 'WSD-n' = (Wsd @() @('192.0.2.30')) } $p).Count | Should -Be 0
    }
    It 'does not match a TCP/IP port by address when the printer''s MAC is unknown or the driver names another model' {
        $ports = @{ 'IP_192.0.2.30' = (Tcp '192.0.2.30' @('192.0.2.30')) }
        (M (Q 'Laser' 'IP_192.0.2.30' 'Generic PCL Driver') $ports (P -macs @())).Count | Should -Be 0
        (M (Q 'Laser' 'IP_192.0.2.30' 'Vendor HL-L5678DN series') $ports).Count | Should -Be 0
        (M (Q 'Laser' 'IP_192.0.2.30' 'Vendor DCP-L1234CDW series') $ports).Count | Should -Be 1
        (M (Q 'Laser' 'IP_192.0.2.30' 'Vendor Universal Printing PCL 6') $ports).Count | Should -Be 1
    }
    It 'compares models by their model numbers, including driver ranges' {
        Test-SpoolfreeModelMatch -Model 'Vendor DCP-L1234CDW' -Candidates @('Vendor DCP-L1234CDW series') | Should -BeTrue
        Test-SpoolfreeModelMatch -Model 'Vendor Color Laser Pro M252n' -Candidates @('Vendor Color Laser Pro M252 PCL 6') | Should -BeTrue
        Test-SpoolfreeModelMatch -Model 'Vendor Color MFP M283fdw' -Candidates @('Vendor Color MFP M282-M285 PCL-6 (V4)') | Should -BeTrue
        Test-SpoolfreeModelMatch -Model 'Vendor DCP-L1234CDW' -Candidates @('Vendor HL-L5678DN series') | Should -BeFalse
        Test-SpoolfreeModelMatch -Model 'Vendor DCP-L1234CDW' -Candidates @('Microsoft IPP Class Driver', 'Vendor Laser Type1 Class Driver') | Should -BeNullOrEmpty
        Test-SpoolfreeModelMatch -Model '' -Candidates @('Vendor HL-L5678DN') | Should -BeNullOrEmpty
    }
    It 'takes PnP-X serial numbers and model names from device properties' {
        Get-SpoolfreePnpxKind '{656A3BB3-ECC0-43FD-8477-4AE0404A96CD} 12290' | Should -Be 'serial'
        Get-SpoolfreePnpxKind 'DEVPKEY_PNPX_ModelName' | Should -Be 'model'
        Get-SpoolfreePnpxKind 'DEVPKEY_Device_FriendlyName' | Should -BeNullOrEmpty
        $info = ConvertTo-SpoolfreeDeviceInfo -Devices @([pscustomobject]@{ InstanceId = "SWD\DAFWSDProvider\urn:uuid:$($script:uuidX)"; ContainerId = ''; Values = @(); Names = @(); Present = $true; Serials = @('SERIALB2002'); Models = @('Vendor HL-L5678DN') })
        $d = Get-SpoolfreeWsdPortData -Values @{ 'Printer UUID' = $script:uuidX } -DeviceInfo $info
        $d.Serials | Should -Be @('SERIALB2002')
        $d.Models | Should -Be @('Vendor HL-L5678DN')
    }
}

Describe 'Unmanaged removal respects legacy takeover (fix 3)' {
    BeforeAll {
        function E([string]$queue, [string]$printer) { [ordered]@{ queue = $queue; class = 'legacy-of-managed'; driver = 'd'; matchedPrinter = $printer; action = 'report'; reason = 'TCP/IP port 192.0.2.30' } }
    }
    It 'keeps a legacy-of-managed queue whose printer''s takeover is dry-run, as would-remove' {
        $r = Get-SpoolfreeUnmanagedPlan -Entries @((E 'Old Copier' 'Office Copier')) -Mode 'on' -SpoolfreeCount 1 -TakeoverModes @{ 'office copier' = 'dry-run' }
        $r.Entries[0]['action'] | Should -Be 'would-remove'
        $r.Entries[0]['reason'] | Should -Match '^takeover dry-run for Office Copier'
        $r.Entries[0]['reason'] | Should -Match 'TCP/IP port 192\.0\.2\.30'
        # Takeover on: removed; other classes are not affected by takeover.
        $other = [ordered]@{ queue = 'Other Laser'; class = 'other-network'; driver = 'd'; action = 'report'; reason = $null }
        $r = Get-SpoolfreeUnmanagedPlan -Entries @((E 'Old Copier' 'Office Copier'), $other) -Mode 'on' -SpoolfreeCount 1 -TakeoverModes @{ 'office copier' = 'on' }
        $r.Entries[0]['action'] | Should -Be 'remove'
        $r.Entries[1]['action'] | Should -Be 'remove'
    }
    It 'keeps it when the takeover is off or the printer is unknown' {
        $r = Get-SpoolfreeUnmanagedPlan -Entries @((E 'A' 'Office Copier'), (E 'B' 'Gone Printer')) -Mode 'on' -SpoolfreeCount 1 -TakeoverModes @{ 'office copier' = 'off' }
        @($r.Entries | Where-Object { $_['action'] -ne 'would-remove' }).Count | Should -Be 0
        $r.Entries[0]['reason'] | Should -Match '^takeover off'
    }
    It 'reads the takeover modes of the manifest printers' {
        $m = Get-SpoolfreeTakeoverModes -Printers @([pscustomobject]@{ Printer = (P 'dry-run') }, [pscustomobject]@{ Printer = [pscustomobject]@{ name = 'Plain' } })
        $m['office copier'] | Should -Be 'dry-run'
        $m['plain'] | Should -Be 'off'
        # End to end: a queue matched to a dry-run printer stays.
        $u = U (Q 'Old Laser' 'IP_192.0.2.30' 'Vendor DCP-L1234CDW series') @{ 'IP_192.0.2.30' = (Tcp '192.0.2.30' @('192.0.2.30')) } (P 'dry-run')
        $u[0]['class'] | Should -Be 'legacy-of-managed'
        $plan = Get-SpoolfreeUnmanagedPlan -Entries $u -Mode 'on' -SpoolfreeCount 1 -TakeoverModes (Get-SpoolfreeTakeoverModes -Printers @([pscustomobject]@{ Printer = (P 'dry-run') }))
        $plan.Entries[0]['action'] | Should -Be 'would-remove'
    }
}
