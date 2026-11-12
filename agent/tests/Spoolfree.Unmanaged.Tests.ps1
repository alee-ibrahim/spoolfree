#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# 0.9.0: legacy matching fixes (vendor TCP/IP monitors, EUI-64 MACs, serials, several device UUIDs) and
# "Remove unmanaged printers": classification, keep list and safety rules (pure). Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:ipp = '6a1b2c3d-0000-4000-8000-00000000aa01'
    $script:wsd = '6a1b2c3d-0000-4000-8000-00000000bb02'
    $script:mac = '001122334455'
    $script:ll = 'fe80::211:22ff:fe33:4455'
    function P([string]$mode = 'on', [string[]]$uuids = @($script:ipp), [string[]]$serials = @(), [string[]]$aliases = @()) {
        [pscustomobject]@{ id = 'p1'; name = 'Office Copier'; host = 'copier1.example.org'; ippUrl = 'http://copier1.example.org:631/ipp/print'; revision = 1
            legacy = [pscustomobject]@{ mode = $mode; shares = @('Office-Copier') }
            deviceUuid = $uuids[0]; deviceUuids = $uuids; macAddresses = @($script:mac); serialNumbers = $serials; legacyAliases = $aliases }
    }
    function Q([string]$name, [string]$port = '', [string]$driver = 'Generic Vendor PCL6', [string]$type = 'Local', [string]$comment = '') {
        [pscustomobject]@{ Name = $name; Type = $type; PortName = $port; DriverName = $driver; Comment = $comment }
    }
    function Port([string]$monitor, [string]$hostAddress = '', [string[]]$addresses = @(), [string[]]$uuids = @(), [string]$mac = $null, [string[]]$macs = @(), [string[]]$names = @(), [string]$description = '') {
        [pscustomobject]@{ Monitor = $monitor; Description = $description; HostAddress = $hostAddress; Addresses = $addresses; Uuids = $uuids; Mac = $mac; Macs = $macs; Names = $names }
    }
    $script:addr = @('copier1.example.org', '192.0.2.20')
    function M($queues, $ports = @{}, $printer = (P)) {
        return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @($queues) -Ports $ports -PrinterAddresses $script:addr -LegacyServers @('printsrv01.example.org'))
    }
}

Describe 'ConvertFrom-SpoolfreeEui64' {
    It 'derives the MAC from an EUI-64 link-local address, with zone id, brackets or in a URL' {
        ConvertFrom-SpoolfreeEui64 $script:ll | Should -Be $script:mac
        ConvertFrom-SpoolfreeEui64 "$($script:ll)%12" | Should -Be $script:mac
        ConvertFrom-SpoolfreeEui64 "[$($script:ll)%12]" | Should -Be $script:mac
        ConvertFrom-SpoolfreeEui64 "http://[$($script:ll)%12]:5357/device" | Should -Be $script:mac
        ConvertFrom-SpoolfreeEui64 'FE80::0211:22FF:FE33:4455' | Should -Be $script:mac
    }
    It 'returns null for random interface ids, IPv4 and junk' {
        ConvertFrom-SpoolfreeEui64 'fe80::1c2d:3e4f:5a6b:7c8d' | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreeEui64 '192.0.2.20' | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreeEui64 'printer.example.org' | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreeEui64 '' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertFrom-SpoolfreeMonitorPortValues' {
    It 'reads an HP Standard TCP/IP Port (HPTCPMON) style key' {
        $r = ConvertFrom-SpoolfreeMonitorPortValues -Values @{ IPAddress = ''; HostName = 'OLD-PRN-02'; HWAddress = '00-11-22-33-44-55'; 'Port Number' = '9100' }
        $r.Host | Should -Be 'OLD-PRN-02'
        $r.Mac | Should -Be $script:mac
    }
    It 'prefers the IP address and ignores empty, 0.0.0.0 and invalid MACs' {
        $r = ConvertFrom-SpoolfreeMonitorPortValues -Values @{ IPAddress = '192.0.2.20'; HostName = 'x'; HWAddress = 'junk' }
        $r.Host | Should -Be '192.0.2.20'
        $r.Mac | Should -BeNullOrEmpty
        (ConvertFrom-SpoolfreeMonitorPortValues -Values @{ IPAddress = '0.0.0.0' }).Host | Should -BeNullOrEmpty
        (ConvertFrom-SpoolfreeMonitorPortValues -Values $null).Host | Should -BeNullOrEmpty
    }
}

Describe 'Legacy matching (0.9.0)' {
    It 'matches a vendor TCP/IP monitor port by its registry host' {
        $r = M (Q 'HP Office' 'HP_OLD') @{ 'HP_OLD' = (Port 'HP Standard TCP/IP Port' '192.0.2.20' @('192.0.2.20')) }
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'address'
    }
    It 'matches a vendor TCP/IP monitor port by the MAC it stores' {
        $r = M (Q 'HP Office' 'HP_OLD') @{ 'HP_OLD' = (Port 'HP Standard TCP/IP Port' 'old-name-not-in-dns' @() @() '00:11:22:33:44:55') }
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'mac'
        $r[0].Reason | Should -Match 'port MAC 001122334455'
        (M (Q 'HP Other' 'HP_X') @{ 'HP_X' = (Port 'HP Standard TCP/IP Port' 'other' @() @() '00:11:22:33:44:66') }).Count | Should -Be 0
    }
    It 'matches a WSD port by any of the printer''s device UUIDs' {
        $ports = @{ 'WSD-x' = (Port 'WSD Port' '' @() @($script:wsd)) }
        (M (Q 'Copier WSD' 'WSD-x') $ports).Count | Should -Be 0
        $r = M (Q 'Copier WSD' 'WSD-x') $ports (P 'on' @($script:ipp, $script:wsd))
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'uuid'
        $r[0].Uuid | Should -Be $script:wsd
    }
    It 'matches a WSD device with another UUID by the MAC of its EUI-64 link-local address' {
        $ports = @{ 'WSD-x' = (Port 'WSD Port' '' @($script:ll) @($script:wsd) $null @($script:mac)) }
        $r = M (Q 'Copier WSD' 'WSD-x') $ports
        $r.Count | Should -Be 1
        $r[0].MatchBy | Should -Be 'mac'
        $r[0].Uuid | Should -Be $script:wsd
    }
    It 'matches a WSD device with another UUID by a serial number in its name or the queue name' {
        $byFriendly = @{ 'WSD-x' = (Port 'WSD Port' '' @() @($script:wsd) $null @() @('Generic MFP SN-ABC12345')) }
        (M (Q 'Copier WSD' 'WSD-x') $byFriendly (P 'on' @($script:ipp) @('ABC12345')))[0].MatchBy | Should -Be 'serial'
        $plain = @{ 'WSD-x' = (Port 'WSD Port' '' @() @($script:wsd)) }
        (M (Q 'Generic MFP (ABC12345)' 'WSD-x') $plain (P 'on' @($script:ipp) @('ABC12345')))[0].MatchBy | Should -Be 'serial'
        # Only whole words: a longer serial that contains it does not match.
        (M (Q 'Generic MFP XABC12345' 'WSD-x') $plain (P 'on' @($script:ipp) @('ABC12345'))).Count | Should -Be 0
    }
    It 'never matches a WSD device with another UUID by address alone' {
        $ports = @{ 'WSD-x' = (Port 'WSD Port' '' @('192.0.2.20') @($script:wsd)) }
        (M (Q 'Copier WSD' 'WSD-x') $ports).Count | Should -Be 0
    }
    It 'ignores serial numbers shorter than 5 characters' {
        $plain = @{ 'WSD-x' = (Port 'WSD Port' '' @() @($script:wsd)) }
        (M (Q 'Copier A12' 'WSD-x') $plain (P 'on' @($script:ipp) @('A12'))).Count | Should -Be 0
    }
}

Describe 'ConvertTo-SpoolfreeDeviceInfo / Get-SpoolfreeWsdPortData' {
    It 'collects hosts, EUI-64 MACs and friendly names per device UUID' {
        $devices = @([pscustomobject]@{ InstanceId = "SWD\DAFWSDProvider\urn:uuid:$($script:wsd)"; ContainerId = ''; Values = @("http://[$($script:ll)%7]:5357/$($script:wsd)"); Names = @('Generic MFP SN-ABC12345') })
        $info = ConvertTo-SpoolfreeDeviceInfo -Devices $devices
        $info[$script:wsd].Macs | Should -Be @($script:mac)
        $info[$script:wsd].Names | Should -Be @('Generic MFP SN-ABC12345')
        $info[$script:wsd].Hosts | Should -Contain $script:ll
        $d = Get-SpoolfreeWsdPortData -Values @{ 'Printer UUID' = $script:wsd } -DeviceInfo $info
        $d.Uuids | Should -Be @($script:wsd)
        $d.Macs | Should -Be @($script:mac)
        $d.Names | Should -Be @('Generic MFP SN-ABC12345')
    }
}

Describe 'Get-SpoolfreeUnmanagedQueues' {
    BeforeAll {
        $script:ports = @{
            'IP_192.0.2.20'  = (Port 'Standard TCP/IP Port' '192.0.2.20' @('192.0.2.20'))
            'IP_198.51.100.7' = (Port 'Standard TCP/IP Port' '198.51.100.7' @('198.51.100.7'))
            'IP_EMPTY'       = (Port 'Standard TCP/IP Port' '')
            'WSD-other'      = (Port 'WSD Port' '' @('198.51.100.8') @('6a1b2c3d-0000-4000-8000-00000000cc03'))
            'WSD-gone'       = (Port 'WSD Port' '' @() @('6a1b2c3d-0000-4000-8000-00000000dd04'))
            'USB001'         = (Port 'USB Monitor')
            'PORTPROMPT:'    = (Port 'Local Monitor')
            'nul:'           = (Port 'Local Monitor')
            'TS001'          = (Port 'Dynamic Print Monitor')
            'SF_PORT'        = (Port 'WSD Port' '' @() @($script:ipp) $null @() @() 'IPP Port')
        }
        $queues = @(
            (Q 'Office Copier' 'SF_PORT' 'Microsoft IPP Class Driver' 'Local' 'Managed by Spoolfree [p1 rev 1 server 0123456789abcdef]'),
            (Q 'Old Copier' 'IP_192.0.2.20'),
            (Q 'Other Dept Laser' 'IP_198.51.100.7'),
            (Q 'Other Dept MFP' 'WSD-other'),
            (Q 'Gone Printer' 'WSD-gone'),
            (Q 'Broken TCP' 'IP_EMPTY'),
            (Q 'Missing Port' 'NO_SUCH_PORT'),
            (Q 'Desk USB' 'USB001'),
            (Q 'Microsoft Print to PDF' 'PORTPROMPT:' 'Microsoft Print To PDF'),
            (Q 'OneNote (Desktop)' 'nul:' 'Send to Microsoft OneNote 16 Driver'),
            (Q 'Laser (redirected 2)' 'TS001'),
            (Q '\\printsrv01.example.org\Office-Copier' '' 'x' 'Connection'),
            (Q '\\otherserver\Plotter' '' 'y' 'Connection')
        )
        # Takeover off: the manifest carries no share names for the printer.
        $off = P 'off'
        $off.legacy.shares = @()
        $printers = @([pscustomobject]@{ Printer = $off; Addresses = $script:addr })
        $script:u = @(Get-SpoolfreeUnmanagedQueues -Queues $queues -Ports $script:ports -Printers $printers -LegacyServers @('printsrv01') -Installed @('Office Copier') -ServerId '0123456789abcdef')
        $script:byName = @{}
        foreach ($e in $script:u) { $script:byName[$e['queue']] = $e }
    }
    It 'leaves out Spoolfree queues of this server and Remote Desktop redirected printers' {
        $script:byName.ContainsKey('Office Copier') | Should -BeFalse
        $script:byName.ContainsKey('Laser (redirected 2)') | Should -BeFalse
        $script:u.Count | Should -Be 11
    }
    It 'classifies every queue' {
        $script:byName['Old Copier']['class'] | Should -Be 'legacy-of-managed'
        $script:byName['Old Copier']['matchedPrinter'] | Should -Be 'Office Copier'
        $script:byName['Old Copier']['matchBy'] | Should -Be 'address'
        $script:byName['Other Dept Laser']['class'] | Should -Be 'other-network'
        $script:byName['Other Dept MFP']['class'] | Should -Be 'other-network'
        $script:byName['Other Dept MFP']['wsdUuid'] | Should -Be '6a1b2c3d-0000-4000-8000-00000000cc03'
        $script:byName['Gone Printer']['class'] | Should -Be 'dead'
        $script:byName['Broken TCP']['class'] | Should -Be 'dead'
        $script:byName['Missing Port']['class'] | Should -Be 'dead'
        $script:byName['Desk USB']['class'] | Should -Be 'local-usb'
        $script:byName['Microsoft Print to PDF']['class'] | Should -Be 'virtual'
        $script:byName['OneNote (Desktop)']['class'] | Should -Be 'virtual'
        $script:byName['\\otherserver\Plotter']['class'] | Should -Be 'print-server-connection'
        $script:byName['\\otherserver\Plotter']['host'] | Should -Be 'otherserver'
        $script:byName['\\otherserver\Plotter']['portKind'] | Should -Be 'connection'
    }
    It 'matches print server connections only through the printer''s legacy shares' {
        # Takeover is off for the printer, so the manifest carries no share names: a plain connection.
        $script:byName['\\printsrv01.example.org\Office-Copier']['class'] | Should -Be 'print-server-connection'
        $on = @(Get-SpoolfreeUnmanagedQueues -Queues @((Q '\\printsrv01.example.org\Office-Copier' '' 'x' 'Connection')) -Printers @([pscustomobject]@{ Printer = (P 'on'); Addresses = @() }) -LegacyServers @('printsrv01') -Scope 'user')
        $on[0]['class'] | Should -Be 'legacy-of-managed'
        $on[0]['matchBy'] | Should -Be 'share'
        $on[0]['scope'] | Should -Be 'user'
    }
    It 'serializes a missing MAC as JSON null, not {} (Windows PowerShell 5.1 AutomationNull; the server rejects {})' {
        foreach ($e in $script:u) {
            $json = $e | ConvertTo-Json -Depth 3 -Compress
            $json | Should -Not -Match '":\{\}'
        }
        ($script:byName['Desk USB'] | ConvertTo-Json -Compress) | Should -Match '"mac":null'
    }
    It 'reports a queue of another Spoolfree server' {
        $r = @(Get-SpoolfreeUnmanagedQueues -Queues @((Q 'Far Printer' 'IP_198.51.100.7' 'd' 'Local' 'Managed by Spoolfree [x1 rev 2 server fedcba9876543210]')) -Ports $script:ports -ServerId '0123456789abcdef')
        $r.Count | Should -Be 1
        $r[0]['reason'] | Should -Be 'Spoolfree queue of another server'
    }
}

Describe 'Test-SpoolfreeKeepMatch' {
    It 'matches queue names literally or by * and ? wildcards, case-insensitively' {
        Test-SpoolfreeKeepMatch -Name 'Microsoft Print to PDF' -Driver 'Microsoft Print To PDF' -Keep @('microsoft print to pdf') | Should -Be 'microsoft print to pdf'
        Test-SpoolfreeKeepMatch -Name '\\plotsrv\Plotter A0' -Keep @('\\plotsrv\*') | Should -Be '\\plotsrv\*'
        Test-SpoolfreeKeepMatch -Name 'Label 1' -Keep @('Label ?') | Should -Be 'Label ?'
        Test-SpoolfreeKeepMatch -Name 'Microsoft XPS Document Writer' -Keep @('Microsoft Print to PDF') | Should -BeNullOrEmpty
    }
    It 'matches driver names' {
        Test-SpoolfreeKeepMatch -Name 'Label printer' -Driver 'Generic Label Driver' -Keep @('Generic Label Driver') | Should -Be 'Generic Label Driver'
        Test-SpoolfreeKeepMatch -Name 'x' -Driver 'Generic Label Driver v2' -Keep @('Generic Label*') | Should -Be 'Generic Label*'
    }
    It 'takes [ and ] literally' {
        Test-SpoolfreeKeepMatch -Name 'HP LaserJet [A1B2C3]' -Keep @('HP LaserJet [A1B2C3]') | Should -Be 'HP LaserJet [A1B2C3]'
        Test-SpoolfreeKeepMatch -Name 'HP LaserJet A' -Keep @('HP LaserJet [A]') | Should -BeNullOrEmpty
    }
}

Describe 'Get-SpoolfreeUnmanagedPlan' {
    BeforeAll {
        function E([string]$queue, [string]$class, [string]$driver = 'd') { [ordered]@{ queue = $queue; class = $class; driver = $driver; action = 'report'; reason = $null } }
        function Entries { @((E 'Microsoft Print to PDF' 'virtual' 'Microsoft Print To PDF'), (E 'Microsoft XPS Document Writer' 'virtual'), (E 'Desk USB' 'local-usb'), (E 'Old Copier' 'legacy-of-managed'), (E 'Other Laser' 'other-network')) }
        function Actions($r) { $h = @{}; foreach ($e in $r.Entries) { $h[$e['queue']] = $e['action'] }; return $h }
    }
    It 'only reports when the setting is off' {
        $r = Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'off' -Keep @('Microsoft Print to PDF') -SpoolfreeCount 3
        @($r.Entries | Where-Object { $_['action'] -ne 'report' }).Count | Should -Be 0
        $r.Blocked | Should -BeNullOrEmpty
    }
    It 'removes everything but the keep list and USB/local printers when on' {
        $a = Actions (Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'on' -Keep @('Microsoft Print to PDF') -KeepLocal $true -SpoolfreeCount 1)
        $a['Microsoft Print to PDF'] | Should -Be 'kept'
        $a['Desk USB'] | Should -Be 'kept'
        $a['Microsoft XPS Document Writer'] | Should -Be 'remove'
        $a['Old Copier'] | Should -Be 'remove'
        $a['Other Laser'] | Should -Be 'remove'
    }
    It 'removes USB/local printers too when keep local is off' {
        (Actions (Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'on' -KeepLocal $false -SpoolfreeCount 1))['Desk USB'] | Should -Be 'remove'
    }
    It 'reports would-remove in dry-run' {
        $a = Actions (Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'dry-run' -Keep @('Microsoft Print to PDF') -SpoolfreeCount 1)
        $a['Other Laser'] | Should -Be 'would-remove'
        $a['Microsoft Print to PDF'] | Should -Be 'kept'
    }
    It 'never removes anything on a PC without a Spoolfree queue' {
        $r = Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'on' -Keep @() -KeepLocal $false -SpoolfreeCount 0
        @($r.Entries | Where-Object { $_['action'] -eq 'remove' -or $_['action'] -eq 'would-remove' }).Count | Should -Be 0
        $r.Blocked | Should -Match 'no Spoolfree printer'
        ($r.Entries | Where-Object { $_['queue'] -eq 'Other Laser' })['reason'] | Should -Match 'no Spoolfree printer'
    }
    It 'keep-list reasons name the entry' {
        $r = Get-SpoolfreeUnmanagedPlan -Entries (Entries) -Mode 'on' -Keep @('Microsoft*') -SpoolfreeCount 1
        ($r.Entries | Where-Object { $_['queue'] -eq 'Microsoft XPS Document Writer' })['reason'] | Should -Be 'keep list: Microsoft*'
    }
}

Describe 'Get-SpoolfreeUnmanagedReplacement' {
    It 'prefers the matched printer, then the OU default, then the first Spoolfree queue' {
        Get-SpoolfreeUnmanagedReplacement -Entry @{ matchedPrinter = 'B' } -DefaultPrinter 'A' -Spoolfree @('A', 'B') | Should -Be 'B'
        Get-SpoolfreeUnmanagedReplacement -Entry @{ matchedPrinter = 'Gone' } -DefaultPrinter 'A' -Spoolfree @('A', 'B') | Should -Be 'A'
        Get-SpoolfreeUnmanagedReplacement -Entry @{} -DefaultPrinter 'Missing' -Spoolfree @('C') | Should -Be 'C'
        Get-SpoolfreeUnmanagedReplacement -Entry @{} -DefaultPrinter 'A' -Spoolfree @() | Should -BeNullOrEmpty
    }
}

Describe 'Unmanaged settings and per-user results' {
    It 'reads the manifest block with safe defaults' {
        $d = Get-SpoolfreeUnmanagedSettings ([pscustomobject]@{})
        $d.Mode | Should -Be 'off'
        $d.KeepLocal | Should -BeTrue
        @($d.Keep).Count | Should -Be 0
        $s = Get-SpoolfreeUnmanagedSettings ([pscustomobject]@{ unmanaged = [pscustomobject]@{ mode = 'on'; keep = @('Microsoft Print to PDF', ''); keepLocal = $false } })
        $s.Mode | Should -Be 'on'
        $s.KeepLocal | Should -BeFalse
        $s.Keep | Should -Be @('Microsoft Print to PDF')
        (Get-SpoolfreeUnmanagedSettings ([pscustomobject]@{ unmanaged = [pscustomobject]@{ mode = 'delete-all' } })).Mode | Should -Be 'off'
    }
    It 'validates entries from the logon task and takes the scope from the caller' {
        $e = ConvertTo-SpoolfreeUnmanagedEntry -Entry ([pscustomobject]@{ queue = '\\srv\q'; class = 'print-server-connection'; action = 'removed'; scope = 'machine'; host = 'srv' }) -Scope 'user:EXAMPLE\user1'
        $e['scope'] | Should -Be 'user:EXAMPLE\user1'
        $e['action'] | Should -Be 'removed'
        ConvertTo-SpoolfreeUnmanagedEntry -Entry ([pscustomobject]@{ queue = 'q'; class = 'virtual'; action = 'format-disk' }) -Scope 'user:x' | Should -BeNullOrEmpty
        ConvertTo-SpoolfreeUnmanagedEntry -Entry ([pscustomobject]@{ queue = 'q'; class = 'other'; action = 'kept' }) -Scope 'user:x' | Should -BeNullOrEmpty
        ConvertTo-SpoolfreeUnmanagedEntry -Entry ([pscustomobject]@{ class = 'virtual'; action = 'kept' }) -Scope 'user:x' | Should -BeNullOrEmpty
    }
}
