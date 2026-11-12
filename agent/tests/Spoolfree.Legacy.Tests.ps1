#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Legacy queue takeover: matching logic (pure). Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    function P([string]$mode = 'on', [string[]]$shares = @('Finance-Laser')) {
        [pscustomobject]@{ id = 'p1'; name = 'Finance Laser'; host = 'prn-fin.example.org'; ippUrl = 'http://prn-fin.example.org:631/ipp/print'; revision = 1
            legacy = [pscustomobject]@{ mode = $mode; shares = $shares }; macAddresses = @('00aa11bb22cc') }
    }
    function Q([string]$name, [string]$port = '', [string]$driver = 'HP Universal Printing PCL 6', [string]$type = 'Local', [string]$comment = '') {
        [pscustomobject]@{ Name = $name; Type = $type; PortName = $port; DriverName = $driver; Comment = $comment }
    }
    function Port([string]$monitor, [string]$hostAddress = '', [string[]]$addresses = @()) {
        [pscustomobject]@{ Monitor = $monitor; Description = ''; HostAddress = $hostAddress; Addresses = $addresses }
    }
    $script:addr = @('prn-fin.example.org', '192.0.2.10')
    $script:servers = @('printsrv01.example.org')
    function M($queues, $ports = @{}, $printer = (P), [string[]]$installed = @(), [string[]]$servers = $script:servers) {
        # Always hand back an array (a single PSCustomObject has no .Count in Windows PowerShell 5.1).
        return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @($queues) -Ports $ports -PrinterAddresses $script:addr -LegacyServers $servers -Installed $installed)
    }
}

Describe 'Get-SpoolfreeLegacyMatches' {
    It 'matches a Standard TCP/IP port by IP' {
        $r = M (Q 'HP Finance' 'IP_192.0.2.10') @{ 'IP_192.0.2.10' = (Port 'Standard TCP/IP Port' '192.0.2.10' @('192.0.2.10')) }
        $r.Count | Should -Be 1
        $r[0].Queue | Should -Be 'HP Finance'
        $r[0].Reason | Should -Be 'TCP/IP port 192.0.2.10'
    }
    It 'matches a TCP/IP port whose host name resolves to the same IP' {
        $r = M (Q 'Old HP' 'oldname') @{ 'oldname' = (Port 'Standard TCP/IP Port' 'hp-fin-old' @('192.0.2.10')) }
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be 'TCP/IP port hp-fin-old'
    }
    It 'matches an IPP/URL port by host' {
        $r = M (Q 'IPP queue' 'http://prn-fin.example.org:631/ipp/print' 'Microsoft IPP Class Driver') @{}
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be 'IPP port prn-fin.example.org'
        (M (Q 'IPP other' 'ipps://192.0.2.99/ipp/print') @{}).Count | Should -Be 0
    }
    It 'matches a WSD port only when its address is known' {
        $q = Q 'WSD printer' 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427'
        # 0.9.3: an address alone needs the device there to report the printer's MAC and model.
        $p = P; $p | Add-Member -NotePropertyName model -NotePropertyValue 'Vendor Laser L2040dn'
        $port = Port 'WSD Port' '' @('192.0.2.10'); $port | Add-Member -NotePropertyName Uuids -NotePropertyValue @('e3248000-80ce-11db-8000-00aa11bb22cc'); $port | Add-Member -NotePropertyName Names -NotePropertyValue @('Vendor Laser L2040 series')
        (M $q @{ 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427' = $port } $p)[0].Reason | Should -Be 'WSD port 192.0.2.10'
        (M $q @{ 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427' = (Port 'WSD Port' '' @('192.0.2.10')) }).Count | Should -Be 0
        (M $q @{ 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427' = (Port 'WSD Port' '' @()) }).Count | Should -Be 0
        (M $q @{}).Count | Should -Be 0
    }
    It 'matches print server connections on a listed server, short name or FQDN' {
        (M (Q '\\printsrv01\Finance-Laser' '' 'x' 'Connection'))[0].Reason | Should -Be 'print server connection \\printsrv01\Finance-Laser'
        (M (Q '\\PRINTSRV01.example.org\finance-laser' '' 'x' 'Connection')).Count | Should -Be 1
        (M (Q '\\printsrv01.example.org\Finance-Laser' '' 'x' 'Connection') -servers @('printsrv01')).Count | Should -Be 1
    }
    It 'ignores connections to unlisted servers or unlisted shares' {
        (M (Q '\\otherserver\Finance-Laser' '' 'x' 'Connection')).Count | Should -Be 0
        (M (Q '\\printsrv01.other.example\Finance-Laser' '' 'x' 'Connection')).Count | Should -Be 0
        (M (Q '\\printsrv01\HR-Laser' '' 'x' 'Connection')).Count | Should -Be 0
        (M (Q '\\printsrv01\Finance-Laser' '' 'x' 'Connection') -servers @()).Count | Should -Be 0
    }
    It 'never touches USB, local-port or virtual queues' {
        $ports = @{
            'USB001'     = (Port 'USB Monitor')
            'PORTPROMPT:' = (Port 'Local Monitor')
            'nul:'       = (Port 'Local Monitor')
            'FILE:'      = (Port 'Local Monitor')
            'TS001'      = (Port 'Dynamic Print Monitor')
            'SHRFAX:'    = (Port 'Microsoft Shared Fax Monitor')
        }
        $queues = @(
            (Q 'USB HP' 'USB001'),
            (Q 'Microsoft Print to PDF' 'PORTPROMPT:' 'Microsoft Print To PDF'),
            (Q 'OneNote (Desktop)' 'nul:' 'Send to Microsoft OneNote 16 Driver'),
            (Q 'Microsoft XPS Document Writer' 'PORTPROMPT:' 'Microsoft XPS Document Writer v4'),
            (Q 'Fax' 'SHRFAX:' 'Microsoft Shared Fax Driver'),
            (Q 'Redirected (RDP)' 'TS001'),
            # Virtual driver on a TCP port that happens to point at the printer's IP: still never touched.
            (Q 'PDF on IP' 'IP_192.0.2.10' 'Some PDF Writer')
        )
        $ports['IP_192.0.2.10'] = (Port 'Standard TCP/IP Port' '192.0.2.10' @('192.0.2.10'))
        (M $queues $ports).Count | Should -Be 0
    }
    It 'never touches Spoolfree queues or the target queue name' {
        $ports = @{ 'IP_192.0.2.10' = (Port 'Standard TCP/IP Port' '192.0.2.10' @('192.0.2.10')) }
        (M (Q 'Mine' 'IP_192.0.2.10' 'x' 'Local' 'Managed by Spoolfree [p1 rev 1]') $ports).Count | Should -Be 0
        (M (Q 'Marker only' 'IP_192.0.2.10') $ports -installed @('marker only')).Count | Should -Be 0
        (M (Q 'Finance Laser' 'IP_192.0.2.10') $ports).Count | Should -Be 0
    }
    It 'ignores other devices and unidentifiable ports' {
        $ports = @{ 'IP_192.0.2.20' = (Port 'Standard TCP/IP Port' '192.0.2.20' @('192.0.2.20')); 'MYSTERY' = (Port 'Some Vendor Monitor') }
        (M @((Q 'Other' 'IP_192.0.2.20'), (Q 'Mystery' 'MYSTERY'), (Q 'No port info' 'UNKNOWN_PORT')) $ports).Count | Should -Be 0
    }
    It 'returns nothing in mode off or without a legacy block' {
        $ports = @{ 'IP_192.0.2.10' = (Port 'Standard TCP/IP Port' '192.0.2.10' @('192.0.2.10')) }
        (M (Q 'HP Finance' 'IP_192.0.2.10') $ports (P 'off')).Count | Should -Be 0
        $plain = [pscustomobject]@{ id = 'p1'; name = 'Finance Laser'; host = '192.0.2.10'; revision = 1 }
        (M (Q 'HP Finance' 'IP_192.0.2.10') $ports $plain).Count | Should -Be 0
        Get-SpoolfreeLegacyMode $plain | Should -Be 'off'
        Get-SpoolfreeLegacyMode (P 'dry-run') | Should -Be 'dry-run'
    }
    It 'considers only connections with -ConnectionsOnly' {
        $ports = @{ 'IP_192.0.2.10' = (Port 'Standard TCP/IP Port' '192.0.2.10' @('192.0.2.10')) }
        $queues = @((Q 'HP Finance' 'IP_192.0.2.10'), (Q '\\printsrv01\Finance-Laser' '' 'x' 'Connection'))
        $r = @(Get-SpoolfreeLegacyMatches -Printer (P) -Queues $queues -Ports $ports -PrinterAddresses $script:addr -LegacyServers $script:servers -ConnectionsOnly)
        $r.Count | Should -Be 1
        $r[0].Queue | Should -Be '\\printsrv01\Finance-Laser'
    }
}

Describe 'Get-SpoolfreeLegacyMatches legacy aliases' {
    BeforeAll {
        function PA([AllowNull()][string[]]$aliases, [string]$mode = 'on') {
            $p = [pscustomobject]@{ id = 'p1'; name = 'Finance Laser'; host = 'prn-fin.example.org'; revision = 1
                legacy = [pscustomobject]@{ mode = $mode; shares = @() } }
            if ($null -ne $aliases) { $p | Add-Member -NotePropertyName legacyAliases -NotePropertyValue $aliases }
            return $p
        }
        function MA($printer, [string]$hostAddress, [string]$portName = 'IP_old', [string[]]$addresses = @()) {
            $ports = @{ $portName = (Port 'Standard TCP/IP Port' $hostAddress) }
            return , @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @((Q 'Old Brother' $portName)) -Ports $ports -PrinterAddresses $addresses)
        }
    }
    It 'matches a TCP/IP port whose host is a legacy alias' {
        $r = MA (PA @('old-prn-office2')) 'OLD-PRN-OFFICE2'
        $r.Count | Should -Be 1
        $r[0].Queue | Should -Be 'Old Brother'
        $r[0].Kind | Should -Be 'TCP/IP port'
        $r[0].Reason | Should -Be 'TCP/IP port host OLD-PRN-OFFICE2 is a legacy alias'
    }
    It 'compares case-insensitively' {
        (MA (PA @('OLD-Prn-Office2')) 'old-prn-office2').Count | Should -Be 1
    }
    It 'ignores .local and a trailing dot on either side' {
        (MA (PA @('old-prn-office2')) 'OLD-PRN-OFFICE2.local').Count | Should -Be 1
        (MA (PA @('old-prn-office2')) 'OLD-PRN-OFFICE2.local.').Count | Should -Be 1
        (MA (PA @('old-prn-office2.local')) 'OLD-PRN-OFFICE2').Count | Should -Be 1
        (MA (PA @('old-prn-office2.')) 'old-prn-office2.LOCAL').Count | Should -Be 1
    }
    It 'matches IPP URL ports by alias too' {
        $r = @(Get-SpoolfreeLegacyMatches -Printer (PA @('old-brother')) -Queues @((Q 'Old IPP' 'http://old-brother.local:631/ipp/print')) -Ports @{})
        $r.Count | Should -Be 1
        $r[0].Reason | Should -Be 'IPP port host old-brother.local is a legacy alias'
    }
    It 'does not match other hosts' {
        (MA (PA @('old-prn-office2')) 'OLD-PRN-OFFICE22').Count | Should -Be 0
        (MA (PA @('old-prn-office2')) 'OLD-PRN-OFFICE2.example.org').Count | Should -Be 0
        (MA (PA @('old-prn-office2')) 'other-host').Count | Should -Be 0
    }
    It 'does nothing when legacyAliases is absent or empty' {
        (MA (PA $null) 'OLD-PRN-OFFICE2').Count | Should -Be 0
        (MA (PA @()) 'OLD-PRN-OFFICE2').Count | Should -Be 0
        @(Get-SpoolfreeLegacyAliases (PA $null)).Count | Should -Be 0
    }
    It 'respects takeover mode and safety rules' {
        (MA (PA @('old-prn-office2') 'off') 'OLD-PRN-OFFICE2').Count | Should -Be 0
        (MA (PA @('old-prn-office2') 'dry-run') 'OLD-PRN-OFFICE2').Count | Should -Be 1
        $ports = @{ 'IP_old' = (Port 'Standard TCP/IP Port' 'OLD-PRN-OFFICE2') }
        $printer = PA @('old-prn-office2')
        # Spoolfree's own queue (comment or marker), a virtual driver and a USB port are never matched.
        @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @((Q 'Mine' 'IP_old' 'x' 'Local' 'Managed by Spoolfree [p1 rev 1]')) -Ports $ports).Count | Should -Be 0
        @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @((Q 'Marked' 'IP_old')) -Ports $ports -Installed @('marked')).Count | Should -Be 0
        @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @((Q 'PDF' 'IP_old' 'Some PDF Writer')) -Ports $ports).Count | Should -Be 0
        @(Get-SpoolfreeLegacyMatches -Printer $printer -Queues @((Q 'USB one' 'USB001')) -Ports @{ 'USB001' = (Port 'USB Monitor' 'OLD-PRN-OFFICE2') }).Count | Should -Be 0
    }
    It 'normalises alias keys' {
        ConvertTo-SpoolfreeAliasKey ' Host.LOCAL. ' | Should -Be 'host'
        ConvertTo-SpoolfreeAliasKey '.local' | Should -BeNullOrEmpty
        ConvertTo-SpoolfreeAliasKey '' | Should -BeNullOrEmpty
    }
}

Describe 'Legacy helpers' {
    It 'parses URL hosts' {
        Get-SpoolfreeUrlHost 'IPPS://[2001:db8::1]:443/ipp/print' | Should -Be '2001:db8::1'
        Get-SpoolfreeUrlHost 'http://Printer.Example.org/x' | Should -Be 'printer.example.org'
        Get-SpoolfreeUrlHost 'IP_192.0.2.1' | Should -BeNullOrEmpty
    }
    It 'merges the removed-queue map, newest entries win' {
        $prev = [pscustomobject]@{ 'Old A' = 'Laser 1'; 'Old B' = 'Laser 2' }
        $m = Merge-SpoolfreeRemovedMap -Previous $prev -New @{ 'Old B' = 'Laser 3'; 'Old C' = 'Laser 4' }
        $m['Old A'] | Should -Be 'Laser 1'
        $m['Old B'] | Should -Be 'Laser 3'
        $m['Old C'] | Should -Be 'Laser 4'
        (Merge-SpoolfreeRemovedMap -Previous $null -New @{ a = 'b'; c = 'd' } -Max 1).Count | Should -Be 1
    }
    It 'validates per-user report entries and takes the scope from the caller' {
        $e = ConvertTo-SpoolfreeLegacyEntry -Entry ([pscustomobject]@{ printer = 'Finance Laser'; queue = '\\printsrv01\Finance-Laser'; reason = 'r'; action = 'removed'; scope = 'machine' }) -Scope 'user:EXAMPLE\alice'
        $e.scope | Should -Be 'user:EXAMPLE\alice'
        ConvertTo-SpoolfreeLegacyEntry -Entry ([pscustomobject]@{ printer = 'x'; queue = 'y'; action = 'deleted-everything' }) -Scope 'user:x' | Should -BeNullOrEmpty
        (ConvertTo-SpoolfreeLegacyEntry -Entry ([pscustomobject]@{ printer = 'x'; queue = ('q' * 400); action = 'failed'; error = 'e' }) -Scope 'user:x').queue.Length | Should -Be 256
    }
}
