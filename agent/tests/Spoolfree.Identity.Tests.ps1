#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Legacy takeover 0.4.2: WSD/IPP ports by device UUID, MAC-based host names, queues of another Spoolfree
# server, and the error for a blocked queue creation. Pure functions only. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:uuid = 'e3248000-80ce-11db-8000-0011223344aa'
    $script:mac = '0011223344aa'
    $script:server = 'ae216c2ef5247a37'
    function P([string]$mode = 'on', [string]$uuid = $script:uuid, [string[]]$macs = @($script:mac), [string]$name = 'Finance Laser') {
        [pscustomobject]@{ id = 'p1'; name = $name; host = '192.0.2.10'; ippUrl = 'http://192.0.2.10:631/ipp/print'; revision = 1
            deviceUuid = $uuid; macAddresses = $macs; legacy = [pscustomobject]@{ mode = $mode; shares = @() } }
    }
    function Q([string]$name, [string]$port, [string]$driver = 'Brother Generic Jpeg Type2 Class Driver', [string]$comment = '') {
        [pscustomobject]@{ Name = $name; Type = 'Local'; PortName = $port; DriverName = $driver; Comment = $comment }
    }
    function Wsd([string[]]$uuids = @(), [string[]]$addresses = @(), [string]$description = 'WSD Port') {
        [pscustomobject]@{ Monitor = 'WSD Port Monitor'; Description = $description; HostAddress = ''; Addresses = $addresses; Uuids = $uuids }
    }
    function Tcp([string]$hostAddress, [string[]]$addresses = @()) {
        [pscustomobject]@{ Monitor = 'Standard TCP/IP Port'; Description = 'Standard TCP/IP Port'; HostAddress = $hostAddress; Addresses = $addresses; Uuids = @() }
    }
    $script:addr = @('192.0.2.10')
    function M($queues, $ports = @{}, $printer = (P), [string]$serverId = $script:server, [string[]]$ids = @('p1', 'p2'), [switch]$AnyMode) {
        return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @($queues) -Ports $ports -PrinterAddresses $script:addr -ServerId $serverId -ServerPrinterIds $ids -AnyMode:$AnyMode)
    }
    $script:wsdPort = 'WSD-11111111-2222-4333-8444-555555555555'
}

Describe 'WSD and IPP ports' {
    It 'matches a WSD port by the printer-uuid it stores' {
        $r = M (Q 'Brother (Copy 1)' $script:wsdPort) @{ $script:wsdPort = (Wsd @($script:uuid)) }
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be "WSD port device uuid $script:uuid"
        $r[0].Kind | Should -Be 'WSD port'
    }
    It 'compares UUIDs in any notation' {
        (M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @("{$($script:uuid.ToUpperInvariant())}")) }).Count | Should -Be 1
        (M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @("urn:uuid:$script:uuid")) }).Count | Should -Be 1
        (M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @($script:uuid)) } (P -uuid "urn:uuid:$($script:uuid.ToUpperInvariant())")).Count | Should -Be 1
    }
    It 'labels IPP ports of the WSD monitor as IPP queues' {
        $r = M (Q 'IPP class queue' $script:wsdPort 'Microsoft IPP Class Driver') @{ $script:wsdPort = (Wsd @($script:uuid) -description 'IPP Port') }
        $r[0].Reason | Should -Be "IPP port device uuid $script:uuid"
    }
    It 'matches a WSD port by the device address found for its UUID' {
        $r = M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @('e3248000-80ce-11db-8000-0011223344bb') @('192.0.2.10')) } (P -uuid '')
        $r[0].Reason | Should -Be 'WSD port 192.0.2.10'
    }
    It 'ignores WSD ports of other devices and WSD ports it cannot identify' {
        $ports = @{
            'WSD-a' = (Wsd @('e3248000-80ce-11db-8000-0011223344bb') @('192.0.2.15'))
            'WSD-b' = (Wsd @())
            'WSD-c' = (Wsd @('not-a-uuid'))
        }
        (M @((Q 'Other Brother' 'WSD-a'), (Q 'Unknown' 'WSD-b'), (Q 'Garbage' 'WSD-c'), (Q 'No port data' 'WSD-d')) $ports).Count | Should -Be 0
    }
    It 'needs the printer-uuid from the server to match by UUID' {
        (M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @($script:uuid)) } (P -uuid '')).Count | Should -Be 0
        (M (Q 'W' $script:wsdPort) @{ $script:wsdPort = (Wsd @($script:uuid)) } (P -uuid 'garbage')).Count | Should -Be 0
    }
    It 'never matches virtual or local queues, even on a port with the same UUID' {
        $ports = @{ $script:wsdPort = (Wsd @($script:uuid)); 'USB001' = [pscustomobject]@{ Monitor = 'USB Monitor'; Description = 'Virtual printer port for USB'; HostAddress = ''; Addresses = @(); Uuids = @($script:uuid) } }
        $queues = @(
            (Q 'Microsoft Print to PDF' $script:wsdPort 'Microsoft Print To PDF'),
            (Q 'OneNote (Desktop)' $script:wsdPort 'Send to Microsoft OneNote 16 Driver'),
            (Q 'Brother USB' 'USB001' 'Brother DCP-L3551CDW series')
        )
        (M $queues $ports).Count | Should -Be 0
    }
}

Describe 'Host names with the MAC address' {
    It 'matches BRN/BRW + MAC and the bare MAC, any case, .local optional' {
        foreach ($h in 'BRN0011223344AA', 'brw0011223344aa', 'BRN0011223344AA.local', 'BRN0011223344AA.local.', '0011223344AA', '0011223344aa.LOCAL') {
            Get-SpoolfreeMacHostMatch -HostName $h -Macs @($script:mac) | Should -Be $script:mac -Because $h
        }
        Get-SpoolfreeMacHostMatch -HostName 'BRN0011223344AA' -Macs @('00:11:22:33:44:AA') | Should -Be $script:mac
    }
    It 'rejects anything else' {
        foreach ($h in 'BRN0011223344AB', 'BRN0011223344AA.example.org', 'xBRN0011223344AA', 'BRN0011223344AA0', 'BRN_0011223344AA',
            'BRN11223344AA', 'NPI0011223344AA', 'BRN0011223344AA-1', 'BRN00-11-22-33-44-AA', 'printer-0011223344aa', '', $null) {
            Get-SpoolfreeMacHostMatch -HostName $h -Macs @($script:mac) | Should -BeNullOrEmpty -Because "'$h'"
        }
        Get-SpoolfreeMacHostMatch -HostName 'BRN0011223344AA' -Macs @() | Should -BeNullOrEmpty
        Get-SpoolfreeMacHostMatch -HostName 'BRN000000000000' -Macs @('000000000000') | Should -BeNullOrEmpty
    }
    It 'matches a TCP/IP port whose host name is not in DNS' {
        $r = M (Q 'Old Brother' 'IP_BRN0011223344AA') @{ 'IP_BRN0011223344AA' = (Tcp 'BRN0011223344AA') }
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be "TCP/IP port brn0011223344aa (host name has the printer's MAC $script:mac)"
    }
    It 'matches an IPP URL port on a .local name' {
        $r = M (Q 'IPP Brother' 'http://BRW0011223344AA.local:631/ipp/print' 'Microsoft IPP Class Driver') @{}
        $r[0].Reason | Should -Match "^IPP port brw0011223344aa\.local \(host name has the printer's MAC"
    }
    It 'needs the printer MAC from the server and never matches other MACs or local ports' {
        $ports = @{ 'IP_BRN' = (Tcp 'BRN0011223344AA'); 'IP_OTHER' = (Tcp 'BRN0011223344BB'); 'USB001' = [pscustomobject]@{ Monitor = 'USB Monitor'; Description = ''; HostAddress = ''; Addresses = @(); Uuids = @() } }
        (M (Q 'Old' 'IP_BRN') $ports (P -macs @())).Count | Should -Be 0
        (M (Q 'Other' 'IP_OTHER') $ports).Count | Should -Be 0
        (M (Q 'BRN0011223344AA' 'USB001') $ports).Count | Should -Be 0
        (M (Q 'PDF' 'IP_BRN' 'Microsoft Print To PDF') $ports).Count | Should -Be 0
    }
}

Describe 'Queues of another Spoolfree server' {
    It 'parses Spoolfree comments, with and without the server id' {
        $c = ConvertFrom-SpoolfreeComment 'Managed by Spoolfree [p1 rev 3 server AE216C2EF5247A37]'
        $c.PrinterId | Should -Be 'p1'; $c.Revision | Should -Be 3; $c.ServerId | Should -Be $script:server
        (ConvertFrom-SpoolfreeComment 'Managed by Spoolfree [p1 rev 3]').ServerId | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreeComment 'Installed by IT' | Should -BeNullOrEmpty
        (ConvertFrom-SpoolfreeComment 'Managed by Spoolfree (edited)').PrinterId | Should -BeNullOrEmpty
    }
    It 'decides the origin conservatively' {
        Get-SpoolfreeQueueOrigin -Comment '' -ServerId $script:server | Should -Be 'none'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p1 rev 1 server ae216c2ef5247a37]' -ServerId $script:server | Should -Be 'this'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p9 rev 1 server 0123456789abcdef]' -ServerId $script:server | Should -Be 'other'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p1 rev 1]' -ServerId $script:server -ServerPrinterIds @('p1') | Should -Be 'this'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p9 rev 1]' -ServerId $script:server -ServerPrinterIds @('p1') | Should -Be 'other'
        # Unclear cases stay this server's (never taken over).
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p9 rev 1]' -ServerId $script:server -ServerPrinterIds @() | Should -Be 'this'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree [p9 rev 1 server 0123456789abcdef]' -ServerId '' | Should -Be 'this'
        Get-SpoolfreeQueueOrigin -Comment 'Managed by Spoolfree (edited)' -ServerId $script:server -ServerPrinterIds @('p1') | Should -Be 'this'
    }
    It 'takes over a queue of another server for the same device' {
        $ports = @{ $script:wsdPort = (Wsd @($script:uuid) -description 'IPP Port') }
        $r = M (Q 'IT Printer' $script:wsdPort 'Microsoft IPP Class Driver' 'Managed by Spoolfree [dev1 rev 2 server 0123456789abcdef]') $ports
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be "Spoolfree queue of another server, IPP port device uuid $script:uuid"
        # Pre-0.4.2 comment whose printer id this server does not know.
        (M (Q 'IT Printer' $script:wsdPort 'Microsoft IPP Class Driver' 'Managed by Spoolfree [dev1 rev 2]') $ports).Count | Should -Be 1
        # Same name as the printer: still taken over when another server created it.
        (M (Q 'Finance Laser' $script:wsdPort 'Microsoft IPP Class Driver' 'Managed by Spoolfree [dev1 rev 2 server 0123456789abcdef]') $ports).Count | Should -Be 1
    }
    It 'never takes over queues of this server' {
        $ports = @{ $script:wsdPort = (Wsd @($script:uuid) -description 'IPP Port') }
        (M (Q 'Lost marker' $script:wsdPort 'x' 'Managed by Spoolfree [p2 rev 1 server ae216c2ef5247a37]') $ports).Count | Should -Be 0
        (M (Q 'Old comment' $script:wsdPort 'x' 'Managed by Spoolfree [p2 rev 1]') $ports).Count | Should -Be 0
        (M (Q 'Unknown id, no list' $script:wsdPort 'x' 'Managed by Spoolfree [zz rev 1]') $ports -ids @()).Count | Should -Be 0
        (M (Q 'No server id known' $script:wsdPort 'x' 'Managed by Spoolfree [zz rev 1 server 0123456789abcdef]') $ports -serverId '').Count | Should -Be 0
        # A hand-made queue with the printer's own name is still a conflict, not a takeover.
        (M (Q 'Finance Laser' $script:wsdPort) $ports).Count | Should -Be 0
    }
    It 'still requires the same device for another server''s queue' {
        $ports = @{ 'WSD-x' = (Wsd @('e3248000-80ce-11db-8000-0011223344bb') -description 'IPP Port') }
        (M (Q 'Other device' 'WSD-x' 'x' 'Managed by Spoolfree [dev1 rev 2 server 0123456789abcdef]') $ports).Count | Should -Be 0
    }
    It 'writes and refreshes the comment with this server''s id' {
        $p = [pscustomobject]@{ id = 'p1'; name = 'X'; revision = 4; location = 'A' }
        Get-SpoolfreeComment -Printer $p -ServerId 'AE216C2EF5247A37' | Should -Be 'Managed by Spoolfree [p1 rev 4 server ae216c2ef5247a37]'
        Get-SpoolfreeComment -Printer $p | Should -Be 'Managed by Spoolfree [p1 rev 4]'
        $u = Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Managed by Spoolfree [p1 rev 4]'; Location = 'A' }) -ServerId $script:server
        $u['Comment'] | Should -Be 'Managed by Spoolfree [p1 rev 4 server ae216c2ef5247a37]'
        (Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Managed by Spoolfree [p1 rev 4 server ae216c2ef5247a37]'; Location = 'A' }) -ServerId $script:server).Count | Should -Be 0
        (Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Installed by IT'; Location = 'A' }) -ServerId $script:server).Count | Should -Be 0
    }
    It 'derives the server id from the pinned key like the server (sha256, 16 hex digits)' {
        Get-SpoolfreeServerId ([Convert]::ToBase64String([byte[]](1..32))) | Should -Be 'ae216c2ef5247a37'
        Get-SpoolfreeServerId '' | Should -BeNullOrEmpty
        Get-SpoolfreeServerId 'not base64!' | Should -BeNullOrEmpty
    }
}

Describe 'Blocked queue creation' {
    It 'finds the blocking queue with -AnyMode even when takeover is off' {
        $ports = @{ $script:wsdPort = (Wsd @($script:uuid)) }
        (M (Q 'Brother (Copy 1)' $script:wsdPort) $ports (P 'off')).Count | Should -Be 0
        (M (Q 'Brother (Copy 1)' $script:wsdPort) $ports (P 'off') -AnyMode).Count | Should -Be 1
    }
    It 'explains the failure with the queue and what to do' {
        $b = @([pscustomobject]@{ Queue = 'Brother (Copy 1)'; Reason = "WSD port device uuid $script:uuid"; Kind = 'WSD port' })
        $m = Get-SpoolfreeAddFailureMessage -Name 'Finance Laser' -Action 'Add' -Message 'The specified printer already exists.' -Blocking $b -Mode 'off'
        $m | Should -Match "^Finance Laser: Add blocked by existing WSD queue 'Brother \(Copy 1\)' \(WSD port device uuid .*\): enable legacy takeover"
        $m | Should -Match 'Windows said: The specified printer already exists\.$'
        Get-SpoolfreeAddFailureMessage -Name 'F' -Action 'Add' -Message 'The specified WSD or IPP print device was not found.' -Blocking $b -Mode 'dry-run' | Should -Match 'dry-run; switch it to on'
        Get-SpoolfreeAddFailureMessage -Name 'F' -Action 'Replace' -Message 'already exists' -Blocking ($b + $b) -Mode 'on' | Should -Match "Replace blocked by existing WSD queue 'Brother \(Copy 1\)' \(and 1 more\).*could not remove it"
        $ipp = @([pscustomobject]@{ Queue = 'Q'; Reason = 'r'; Kind = 'IPP port' })
        Get-SpoolfreeAddFailureMessage -Name 'F' -Action 'Add' -Message 'already exists' -Blocking $ipp | Should -Match "existing IPP queue 'Q'"
    }
    It 'keeps the plain error when nothing blocks or the error is something else' {
        $b = @([pscustomobject]@{ Queue = 'Q'; Reason = 'r'; Kind = 'WSD port' })
        Get-SpoolfreeAddFailureMessage -Name 'F' -Action 'Add' -Message 'The printer already exists.' -Blocking @() | Should -Be 'F: Add failed: The printer already exists.'
        Get-SpoolfreeAddFailureMessage -Name 'F' -Action 'Add' -Message 'Access is denied.' -Blocking $b | Should -Be 'F: Add failed: Access is denied.'
    }
}

Describe 'WSD device data' {
    It 'indexes device addresses by the UUIDs of the instance id and container only' {
        $devices = @(
            [pscustomobject]@{ InstanceId = "uuid:$script:uuid"; ContainerId = "{$script:uuid}"; Values = @('http://192.0.2.10:80/WebServices/Device', '{62f9c741-b25a-46ce-b54c-9bccce08b6f2}', 'Brother DCP', '192.0.2.10', 'fe80::1') }
            [pscustomobject]@{ InstanceId = 'E3248000-80CE-11DB-8000-0011223344BB'; ContainerId = ''; Values = @(, @('ipp://192.0.2.15/ipp/print', 'x')) }
            [pscustomobject]@{ InstanceId = 'no-uuid-here'; ContainerId = ''; Values = @('http://192.0.2.99/') }
        )
        $i = ConvertTo-SpoolfreeDeviceIndex -Devices $devices
        @($i[$script:uuid]) | Should -Be @('192.0.2.10', 'fe80::1')
        @($i['e3248000-80ce-11db-8000-0011223344bb']) | Should -Be @('192.0.2.15')
        $i.ContainsKey('62f9c741-b25a-46ce-b54c-9bccce08b6f2') | Should -BeFalse
        $i.Count | Should -Be 2
        (ConvertTo-SpoolfreeDeviceIndex -Devices @()).Count | Should -Be 0
    }
    It 'reads a WSD port''s UUID and addresses' {
        $index = @{ $script:uuid = @('192.0.2.10') }
        $d = Get-SpoolfreeWsdPortData -Values @{ 'Printer UUID' = $script:uuid.ToUpperInvariant(); 'Install Protocol' = '1'; 'IPP PortId' = 'IPP-x' } -DeviceIndex $index
        @($d.Uuids) | Should -Be @($script:uuid)
        @($d.Hosts) | Should -Be @('192.0.2.10')
        $e = Get-SpoolfreeWsdPortData -Values @{ 'Printer UUID' = 'junk'; 'Location' = 'http://printer.example.org/x' } -DeviceIndex $index
        @($e.Uuids).Count | Should -Be 0
        @($e.Hosts) | Should -Be @('printer.example.org')
    }
    It 'normalizes MACs' {
        ConvertTo-SpoolfreeMac '00:11:22:33:44:AA' | Should -Be $script:mac
        ConvertTo-SpoolfreeMac '00-11-22-33-44-aa' | Should -Be $script:mac
        foreach ($bad in '000000000000', 'ffffffffffff', '01005e000001', '0011223344', 'zz11223344aa', '') { ConvertTo-SpoolfreeMac $bad | Should -BeNullOrEmpty -Because $bad }
    }
}
