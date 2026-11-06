#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Print analytics (0.5.0): event parsing, queue mapping, bookmark and batching. Nothing touches the real
# event log, registry or network: every side effect is mocked. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    function EventXml([int64]$recordId = 4242, [string]$doc = 'Quarterly report.docx', [string]$user = 'alice', [string]$client = '\\PC01',
        [string]$queue = 'Finance Laser', [string]$port = '192.0.2.10', [string]$bytes = '123456', [string]$pages = '3',
        [string]$sid = 'S-1-5-21-1111111111-2222222222-3333333333-1104', [string]$time = '2026-11-05T08:12:33.1234567Z', [int]$eventId = 307) {
        return @"
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System>
    <Provider Name="Microsoft-Windows-PrintService" Guid="{747ef6fd-e535-4d16-b510-42c90f6873a1}" />
    <EventID>$eventId</EventID>
    <Version>0</Version>
    <Level>4</Level>
    <Task>26</Task>
    <Opcode>11</Opcode>
    <Keywords>0x4000000000000840</Keywords>
    <TimeCreated SystemTime="$time" />
    <EventRecordID>$recordId</EventRecordID>
    <Correlation />
    <Execution ProcessID="3104" ThreadID="5472" />
    <Channel>Microsoft-Windows-PrintService/Operational</Channel>
    <Computer>PC01.example.org</Computer>
    <Security UserID="$sid" />
  </System>
  <UserData>
    <DocumentPrinted xmlns="http://manifests.microsoft.com/win/2005/08/windows/printing/spooler/core/events">
      <Param1>17</Param1>
      <Param2>$doc</Param2>
      <Param3>$user</Param3>
      <Param4>$client</Param4>
      <Param5>$queue</Param5>
      <Param6>$port</Param6>
      <Param7>$bytes</Param7>
      <Param8>$pages</Param8>
    </DocumentPrinted>
  </UserData>
</Event>
"@
    }
    function Manifest([bool]$enabled = $true, [bool]$docs = $false, [switch]$NoAnalytics) {
        $m = [pscustomobject]@{ schema = 1; printers = @([pscustomobject]@{ id = '11111111-1111-4111-8111-111111111111'; name = 'Finance Laser' }) }
        if (-not $NoAnalytics) { $m | Add-Member -NotePropertyName analytics -NotePropertyValue ([pscustomobject]@{ enabled = $enabled; collectDocumentNames = $docs }) }
        return $m
    }
}

Describe 'ConvertFrom-SpoolfreePrintEvent' {
    It 'parses an event 307' {
        $e = ConvertFrom-SpoolfreePrintEvent -Xml (EventXml) -CollectDocumentNames $true
        $e.RecordId | Should -Be 4242
        $e.RecordId | Should -BeOfType [long]
        $e.Time | Should -Be '2026-11-05T08:12:33.123Z'
        $e.UserSid | Should -Be 'S-1-5-21-1111111111-2222222222-3333333333-1104'
        $e.UserName | Should -Be 'alice'
        $e.ClientComputer | Should -Be 'PC01'
        $e.Printer | Should -Be 'Finance Laser'
        $e.Port | Should -Be '192.0.2.10'
        $e.Bytes | Should -Be 123456
        $e.Pages | Should -Be 3
        $e.Document | Should -Be 'Quarterly report.docx'
    }
    It 'never returns the document name unless asked' {
        (ConvertFrom-SpoolfreePrintEvent -Xml (EventXml)).Document | Should -BeNullOrEmpty
        (ConvertFrom-SpoolfreePrintEvent -Xml (EventXml) -CollectDocumentNames $false).Document | Should -BeNullOrEmpty
    }
    It 'turns a time with an offset into UTC' {
        (ConvertFrom-SpoolfreePrintEvent -Xml (EventXml -time '2026-11-05T13:12:33.5+05:00')).Time | Should -Be '2026-11-05T08:12:33.500Z'
    }
    It 'returns nulls for missing or unparseable values' {
        $e = ConvertFrom-SpoolfreePrintEvent -Xml (EventXml -client '' -bytes 'x' -pages '' -sid '')
        $e.ClientComputer | Should -BeNullOrEmpty
        $e.Bytes | Should -BeNullOrEmpty
        $e.Pages | Should -BeNullOrEmpty
        $e.UserSid | Should -BeNullOrEmpty
    }
    It 'rejects other events and junk' {
        ConvertFrom-SpoolfreePrintEvent -Xml (EventXml -eventId 805) | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreePrintEvent -Xml (EventXml -recordId 0) | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreePrintEvent -Xml '<not xml' | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreePrintEvent -Xml '' | Should -BeNullOrEmpty
    }
}

Describe 'Analytics settings and job records' {
    It 'is off when the manifest has no analytics block' {
        (Get-SpoolfreeAnalyticsSettings (Manifest -NoAnalytics)).Enabled | Should -BeFalse
        (Get-SpoolfreeAnalyticsSettings (Manifest $false $true)).CollectDocumentNames | Should -BeFalse
        $s = Get-SpoolfreeAnalyticsSettings (Manifest $true $true)
        $s.Enabled | Should -BeTrue
        $s.CollectDocumentNames | Should -BeTrue
    }
    It 'uses the translated SID name and falls back to Param3' {
        $e = ConvertFrom-SpoolfreePrintEvent -Xml (EventXml)
        (New-SpoolfreeJobRecord -PrintEvent $e -UserName 'EXAMPLE\alice')['user'] | Should -Be 'EXAMPLE\alice'
        (New-SpoolfreeJobRecord -PrintEvent $e -UserName $null)['user'] | Should -Be 'alice'
    }
    It 'translates SIDs and returns null for unknown or invalid ones' {
        Resolve-SpoolfreeSidName 'S-1-5-18' | Should -Match '\\'
        Resolve-SpoolfreeSidName 'S-1-5-21-1111111111-2222222222-3333333333-987654' | Should -BeNullOrEmpty
        Resolve-SpoolfreeSidName 'not-a-sid' | Should -BeNullOrEmpty
        Resolve-SpoolfreeSidName '' | Should -BeNullOrEmpty
    }
    It 'builds the job body with every contract field' {
        $e = ConvertFrom-SpoolfreePrintEvent -Xml (EventXml)
        $j = New-SpoolfreeJobRecord -PrintEvent $e -Mapping ([pscustomobject]@{ PrinterId = 'abc'; PortHost = '192.0.2.10' }) -UserName 'EXAMPLE\alice'
        @($j.Keys) | Should -Be @('recordId', 'time', 'user', 'userSid', 'clientComputer', 'printer', 'port', 'portHost', 'pages', 'bytes', 'document', 'printerId')
        $json = $j | ConvertTo-Json -Compress
        $json | Should -Match '"document":null'
        $json | Should -Match '"recordId":4242'
        $json | Should -Match '"printerId":"abc"'
    }
}

Describe 'Resolve-SpoolfreePrintQueue' {
    BeforeAll {
        $script:printers = @([pscustomobject]@{ id = 'pid-1'; name = 'Finance Laser' })
        $script:queues = @(
            [pscustomobject]@{ Name = 'Finance Laser'; PortName = 'http://prn-fin.example.org:631/ipp/print'; Comment = 'Managed by Spoolfree [pid-1 rev 2]' },
            [pscustomobject]@{ Name = 'Old Brother'; PortName = 'IP_old'; Comment = '' },
            [pscustomobject]@{ Name = 'Managed elsewhere'; PortName = 'IP_x'; Comment = 'Managed by Spoolfree [pid-9 rev 1 server abcdef0123456789]' },
            [pscustomobject]@{ Name = 'Managed here'; PortName = 'IP_x'; Comment = 'Managed by Spoolfree [pid-3 rev 1 server 0123456789abcdef]' },
            [pscustomobject]@{ Name = 'USB HP'; PortName = 'USB001'; Comment = '' },
            [pscustomobject]@{ Name = 'WSD one'; PortName = 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427'; Comment = '' }
        )
        $script:ports = @{
            'IP_old'  = [pscustomobject]@{ Monitor = 'Standard TCP/IP Port'; Description = ''; HostAddress = 'OLD-PRN-OFFICE2'; Addresses = @(); Uuids = @() }
            'IP_x'    = [pscustomobject]@{ Monitor = 'Standard TCP/IP Port'; Description = ''; HostAddress = '192.0.2.30'; Addresses = @(); Uuids = @() }
            'USB001'  = [pscustomobject]@{ Monitor = 'USB Monitor'; Description = ''; HostAddress = ''; Addresses = @(); Uuids = @() }
            'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427' = [pscustomobject]@{ Monitor = 'WSD Port'; Description = ''; HostAddress = ''; Addresses = @('192.0.2.40'); Uuids = @() }
        }
        function RQ([string]$queue, [string]$port = '', [object[]]$installed = @()) {
            Resolve-SpoolfreePrintQueue -QueueName $queue -PortName $port -Printers $script:printers -Installed $installed -Queues $script:queues -Ports $script:ports -ServerId '0123456789abcdef'
        }
    }
    It 'maps a manifest printer by name, case-insensitively' {
        $r = RQ 'finance laser' 'http://prn-fin.example.org:631/ipp/print'
        $r.PrinterId | Should -Be 'pid-1'
        $r.PortHost | Should -Be 'prn-fin.example.org'
    }
    It 'maps queues this agent created (marker) and queues with this server''s comment' {
        (RQ 'Renamed' '' @([pscustomobject]@{ Name = 'Renamed'; Id = 'pid-2' })).PrinterId | Should -Be 'pid-2'
        (RQ 'Managed here' 'IP_x').PrinterId | Should -Be 'pid-3'
        (RQ 'Managed elsewhere' 'IP_x').PrinterId | Should -BeNullOrEmpty
    }
    It 'gives the port host of unmanaged queues' {
        $r = RQ 'Old Brother' 'IP_old'
        $r.PrinterId | Should -BeNullOrEmpty
        $r.PortHost | Should -Be 'old-prn-office2'
        (RQ 'Old Brother' '').PortHost | Should -Be 'old-prn-office2'
        (RQ 'WSD one' 'WSD-1b4e28ba-2fa1-11d2-883f-0016d3cca427').PortHost | Should -Be '192.0.2.40'
    }
    It 'has no port host for local ports or unknown queues' {
        (RQ 'USB HP' 'USB001').PortHost | Should -BeNullOrEmpty
        $r = RQ 'Unknown' 'SOMEPORT'
        $r.PrinterId | Should -BeNullOrEmpty
        $r.PortHost | Should -BeNullOrEmpty
    }
}

Describe 'Enable-SpoolfreePrintLog' {
    It 'enables the log only when it is disabled' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintLogState { [pscustomobject]@{ Enabled = $true; MaxSizeBytes = 20971520 } }
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreeWevtutil { }
        Enable-SpoolfreePrintLog | Should -BeTrue
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeWevtutil -Times 0 -Exactly
    }
    It 'enables a disabled log and grows a small one' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintLogState { [pscustomobject]@{ Enabled = $false; MaxSizeBytes = 1052672 } }
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreeWevtutil { }
        Enable-SpoolfreePrintLog | Should -BeTrue
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeWevtutil -Times 1 -Exactly -ParameterFilter { $Arguments -contains '/e:true' -and $Arguments -contains 'Microsoft-Windows-PrintService/Operational' }
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeWevtutil -Times 1 -Exactly -ParameterFilter { $Arguments -contains '/ms:20971520' }
    }
}

Describe 'Invoke-SpoolfreeAnalytics' {
    BeforeAll {
        function Events([int]$from, [int]$to, [string]$queue = 'Finance Laser') {
            $script:xmls = @(for ($i = $from; $i -le $to; $i++) { [pscustomobject]@{ Id = [int64]$i; Xml = (EventXml -recordId $i -queue $queue -port 'IP_old') } })
            $script:newest = [int64]$to
        }
        function Run($manifest = (Manifest)) {
            Invoke-SpoolfreeAnalytics -Manifest $manifest -BaseUrl 'https://spoolfree.example.org' -Token 't'
        }
    }
    BeforeEach {
        $script:bookmark = [int64]0
        $script:bookmarkWrites = New-Object System.Collections.Generic.List[long]
        $script:posts = New-Object System.Collections.Generic.List[object]
        $script:xmls = @()
        $script:newest = $null
        $script:failFrom = 0
        $script:status = $null
        Mock -ModuleName Spoolfree.Agent Enable-SpoolfreePrintLog { $true }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeAnalyticsBookmark { $script:bookmark }
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeAnalyticsBookmark { $script:bookmarkWrites.Add($RecordId); $script:bookmark = $RecordId }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintLogNewestRecordId { $script:newest }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintEventXml { @($script:xmls | Where-Object { $_.Id -gt $After } | Select-Object -First $Max | ForEach-Object { $_.Xml }) }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeQueueInventory { @([pscustomobject]@{ Name = 'Old Brother'; PortName = 'IP_old'; Comment = ''; Type = 'Local'; DriverName = 'x' }) }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePortInventory { @{ 'IP_old' = [pscustomobject]@{ Monitor = 'Standard TCP/IP Port'; Description = ''; HostAddress = 'OLD-PRN-OFFICE2'; Addresses = @(); Uuids = @() } } }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeInstalled { @() }
        Mock -ModuleName Spoolfree.Agent Resolve-SpoolfreeSidName { 'EXAMPLE\alice' }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeHttpStatus { $script:status }
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreeHttp {
            if ($script:failFrom -gt 0 -and $script:posts.Count + 1 -ge $script:failFrom) { throw 'server unavailable' }
            $script:posts.Add($Body)
            [pscustomobject]@{ ok = $true; accepted = @($Body.events).Count }
        }
    }

    It 'does nothing when analytics is disabled or absent' {
        Events 1 5
        $r = Run (Manifest $false)
        $r.enabled | Should -BeFalse
        $r.sent | Should -Be 0
        $r.logEnabled | Should -BeNullOrEmpty
        (Run (Manifest -NoAnalytics)).enabled | Should -BeFalse
        Should -Invoke -ModuleName Spoolfree.Agent Enable-SpoolfreePrintLog -Times 0 -Exactly
        Should -Invoke -ModuleName Spoolfree.Agent Get-SpoolfreePrintEventXml -Times 0 -Exactly
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeHttp -Times 0 -Exactly
    }
    It 'sends new events, maps queues and advances the bookmark' {
        Events 1 3
        $script:xmls += [pscustomobject]@{ Id = [int64]4; Xml = (EventXml -recordId 4 -queue 'Old Brother' -port 'IP_old') }
        $script:newest = [int64]4
        $r = Run
        $r.enabled | Should -BeTrue
        $r.logEnabled | Should -BeTrue
        $r.sent | Should -Be 4
        $r.error | Should -BeNullOrEmpty
        $script:posts.Count | Should -Be 1
        $ev = @($script:posts[0].events)
        $ev[0]['printerId'] | Should -Be '11111111-1111-4111-8111-111111111111'
        $ev[0]['user'] | Should -Be 'EXAMPLE\alice'
        $ev[0]['document'] | Should -BeNullOrEmpty
        $ev[3]['printerId'] | Should -BeNullOrEmpty
        $ev[3]['portHost'] | Should -Be 'old-prn-office2'
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeHttp -Times 1 -Exactly -ParameterFilter { $Uri -eq 'https://spoolfree.example.org/api/agent/jobs' -and $Method -eq 'POST' -and $Token -eq 't' }
        $script:bookmark | Should -Be 4
    }
    It 'sends document names only when the manifest allows it' {
        Events 1 1
        Run (Manifest $true $true) | Out-Null
        @($script:posts[0].events)[0]['document'] | Should -Be 'Quarterly report.docx'
    }
    It 'batches 1200 events into 3 posts and moves the bookmark per batch' {
        Events 1 1200
        $r = Run
        $r.sent | Should -Be 1200
        $script:posts.Count | Should -Be 3
        @($script:posts[0].events).Count | Should -Be 500
        @($script:posts[2].events).Count | Should -Be 200
        @($script:bookmarkWrites) | Should -Be @(500, 1000, 1200)
    }
    It 'caps one sync at 2000 events, oldest first' {
        Events 1 2500
        $r = Run
        $r.sent | Should -Be 2000
        $script:bookmark | Should -Be 2000
        Should -Invoke -ModuleName Spoolfree.Agent Get-SpoolfreePrintEventXml -Times 1 -Exactly -ParameterFilter { $After -eq 0 -and $Max -eq 2000 }
    }
    It 'keeps the bookmark at the last accepted batch when a post fails' {
        Events 1 1200
        $script:failFrom = 2
        $r = Run
        $r.sent | Should -Be 500
        $r.error | Should -Match 'server unavailable'
        $script:bookmark | Should -Be 500
        @($script:bookmarkWrites) | Should -Be @(500)
    }
    It 'does not move the bookmark when the first post fails' {
        Events 1 10
        $script:failFrom = 1
        $r = Run
        $r.sent | Should -Be 0
        $r.error | Should -Not -BeNullOrEmpty
        $script:bookmarkWrites.Count | Should -Be 0
    }
    It 'skips quietly when the server does not know /api/agent/jobs (404)' {
        Events 1 10
        $script:failFrom = 1
        $script:status = 404
        $r = Run
        $r.sent | Should -Be 0
        $r.error | Should -BeNullOrEmpty
        $script:bookmarkWrites.Count | Should -Be 0
    }
    It 'continues after the bookmark' {
        Events 1 10
        $script:bookmark = [int64]7
        $r = Run
        $r.sent | Should -Be 3
        @(@($script:posts[0].events) | ForEach-Object { $_['recordId'] }) | Should -Be @(8, 9, 10)
    }
    It 'resets the bookmark when the log was cleared' {
        Events 1 5
        $script:bookmark = [int64]900
        $r = Run
        $r.sent | Should -Be 5
        $script:bookmarkWrites[0] | Should -Be 0
        $script:bookmark | Should -Be 5
    }
    It 'resets the bookmark when the log is empty' {
        $script:bookmark = [int64]900
        $script:newest = $null
        $r = Run
        $r.sent | Should -Be 0
        @($script:bookmarkWrites) | Should -Be @(0)
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeHttp -Times 0 -Exactly
    }
    It 'skips past other events without posting when there is no new event 307' {
        $script:bookmark = [int64]10
        $script:newest = [int64]25
        $r = Run
        $r.sent | Should -Be 0
        $script:bookmark | Should -Be 25
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreeHttp -Times 0 -Exactly
    }
    It 'reports a print log failure without stopping' {
        Mock -ModuleName Spoolfree.Agent Enable-SpoolfreePrintLog { throw 'access denied' }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintLogState { [pscustomobject]@{ Enabled = $false; MaxSizeBytes = 0 } }
        Events 1 2
        $r = Run
        $r.logEnabled | Should -BeFalse
        $r.error | Should -Match 'access denied'
        $r.sent | Should -Be 2
    }
    It 'never throws' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreePrintEventXml { throw 'event log broken' }
        Events 1 2
        { Run } | Should -Not -Throw
        (Run).error | Should -Match 'event log broken'
    }
}
