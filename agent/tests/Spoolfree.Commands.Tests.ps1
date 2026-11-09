#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Signed commands (0.8): test prints "from a PC". Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:fx = Get-Content (Join-Path $PSScriptRoot 'fixtures\signed-commands.json') -Raw | ConvertFrom-Json
    $script:guid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    $script:serverId = Get-SpoolfreeServerId $fx.publicKey
    $script:installed = @(
        [pscustomobject]@{ Name = 'Staff Copier'; Id = 'p1'; Revision = 2 },
        [pscustomobject]@{ Name = 'Lab Colour'; Id = 'p2'; Revision = 1 }
    )
    function Queue([string]$name, [string]$comment) {
        [pscustomobject]@{ Name = $name; Comment = $comment; DriverName = 'Microsoft IPP Class Driver'; PortName = 'WSD-1' }
    }
    $script:queues = @(
        (Queue 'Staff Copier' "Managed by Spoolfree [p1 rev 2 server $serverId]"),
        (Queue 'Lab Colour' 'Lab printer (hand-made)')
    )
    function Run-Commands($commands, [hashtable]$extra = @{}) {
        $script:reports = New-Object System.Collections.Generic.List[object]
        $script:printed = New-Object System.Collections.Generic.List[object]
        $params = @{
            Commands   = $commands
            PublicKey  = $fx.publicKey
            ObjectGuid = $guid
            ServerId   = $serverId
            Installed  = $installed
            GetQueues  = { $queues }
            RunKey     = 'TestRegistry:\Commands'
            Report     = { param($id, $body) $script:reports.Add([pscustomobject]@{ id = $id; state = $body.state; jobId = $body.jobId; message = $body.message }) }
            Print      = { param($queue, $doc, $lines) $script:printed.Add([pscustomobject]@{ queue = $queue; doc = $doc; lines = $lines }); @($doc) }
            Wait       = { param($queue, $names, $onSent) & $onSent ([pscustomobject]@{ Id = 12; JobStatus = 'Spooling' }); [pscustomobject]@{ State = 'printed'; JobId = 12; JobStatus = 'Printed'; Message = 'spooler job 12: Printed' } }
        }
        foreach ($k in $extra.Keys) { $params[$k] = $extra[$k] }
        Invoke-SpoolfreeCommands @params
    }
}

Describe 'Command verification' {
    It 'accepts a signed test print for this computer' {
        $c = ConvertFrom-SpoolfreeCommand -Envelope $fx.valid -PublicKey $fx.publicKey -ObjectGuid $guid.ToUpper()
        $c.type | Should -Be 'test-print'
        $c.printer.name | Should -Be 'Staff Copier'
        $c.id | Should -Be '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    }
    It 'refuses an expired command, another computer, another key and unknown types' {
        { ConvertFrom-SpoolfreeCommand -Envelope $fx.expired -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*expired*'
        { ConvertFrom-SpoolfreeCommand -Envelope $fx.otherComputer -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*different computer*'
        { ConvertFrom-SpoolfreeCommand -Envelope $fx.otherKey -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
        { ConvertFrom-SpoolfreeCommand -Envelope $fx.unknownType -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*Unknown command type*'
        { ConvertFrom-SpoolfreeCommand -Envelope ([pscustomobject]@{ payload = ''; signature = '' }) -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*missing payload*'
    }
    It 'refuses a tampered payload' {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fx.valid.payload)).Replace('Staff Copier', 'Other Queue')
        $env = [pscustomobject]@{ payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)); signature = $fx.valid.signature; alg = 'Ed25519' }
        { ConvertFrom-SpoolfreeCommand -Envelope $env -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
    }
    It 'is domain-separated: a manifest is no command and a command is no manifest' {
        { ConvertFrom-SpoolfreeCommand -Envelope $fx.manifest -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
        { ConvertFrom-SpoolfreeManifest -Envelope $fx.valid -PublicKey $fx.publicKey -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
    }
}

Describe 'Single use' {
    It 'runs an id once and prunes old ids' {
        $key = 'TestRegistry:\Single'
        Register-SpoolfreeCommandRun -Id 'AAAAAAAA-0000-4000-8000-000000000001' -Key $key | Should -BeTrue
        Register-SpoolfreeCommandRun -Id 'aaaaaaaa-0000-4000-8000-000000000001' -Key $key | Should -BeFalse
        New-ItemProperty -Path $key -Name 'bbbbbbbb-0000-4000-8000-000000000002' -Value '2020-01-01T00:00:00.0000000Z' -PropertyType String | Out-Null
        Register-SpoolfreeCommandRun -Id 'cccccccc-0000-4000-8000-000000000003' -Key $key | Should -BeTrue
        (Get-ItemProperty -Path $key).PSObject.Properties['bbbbbbbb-0000-4000-8000-000000000002'] | Should -BeNullOrEmpty
        (Get-ItemProperty -Path $key).PSObject.Properties['aaaaaaaa-0000-4000-8000-000000000001'] | Should -Not -BeNullOrEmpty
    }
}

Describe 'Only queues this agent manages' {
    BeforeAll { $script:cmd = ConvertFrom-SpoolfreeCommand -Envelope $fx.valid -PublicKey $fx.publicKey -ObjectGuid $guid }
    It 'resolves the Spoolfree queue for the command printer' {
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed $installed -Queues $queues -ServerId $serverId | Should -Be 'Staff Copier'
    }
    It 'refuses a queue without a marker, with another printer id, another server, or a hand-made comment' {
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed @() -Queues $queues -ServerId $serverId | Should -BeNullOrEmpty
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed $installed -Queues @(Queue 'Staff Copier' "Managed by Spoolfree [p9 rev 2 server $serverId]") -ServerId $serverId | Should -BeNullOrEmpty
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed $installed -Queues @(Queue 'Staff Copier' 'Managed by Spoolfree [p1 rev 2 server 0123456789abcdef]') -ServerId $serverId | Should -BeNullOrEmpty
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed $installed -Queues @(Queue 'Staff Copier' 'Copier in room 1') -ServerId $serverId | Should -BeNullOrEmpty
        Resolve-SpoolfreeCommandQueue -Command $cmd -Installed $installed -Queues @() -ServerId $serverId | Should -BeNullOrEmpty
    }
}

Describe 'Following the spooler job' {
    It 'classifies JobStatus' {
        Get-SpoolfreeJobOutcome 'Printing, Retained' | Should -Be 'pending'
        Get-SpoolfreeJobOutcome 'Printed, Retained' | Should -Be 'printed'
        Get-SpoolfreeJobOutcome 'Error, Printing' | Should -Be 'failed'
        Get-SpoolfreeJobOutcome 'PaperOut' | Should -Be 'failed'
        Get-SpoolfreeJobOutcome '' | Should -Be 'pending'
    }
    It 'reports sent once, then printed when the job leaves the queue' {
        $script:calls = 0
        $script:sent = @()
        $jobs = { param($q) $script:calls++; if ($script:calls -le 2) { @([pscustomobject]@{ Id = 5; DocumentName = 'Spoolfree test page x'; JobStatus = 'Printing' }, [pscustomobject]@{ Id = 4; DocumentName = 'Budget.xlsx'; JobStatus = 'Printing' }) } else { @() } }
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -DocumentNames @('Spoolfree test page x') -GetJobs $jobs -Sleep { } -OnSent { param($j) $script:sent += $j.Id }
        $r.State | Should -Be 'printed'
        $r.JobId | Should -Be 5
        $script:sent | Should -Be @(5)
    }
    It 'fails on a spooler error, and when the job is stuck past the timeout' {
        $err = Wait-SpoolfreePrintJob -Queue 'Q' -DocumentNames @('d') -GetJobs { param($q) @([pscustomobject]@{ Id = 7; DocumentName = 'd'; JobStatus = 'Error, Printing' }) } -Sleep { }
        $err.State | Should -Be 'failed'
        $err.JobStatus | Should -Be 'Error, Printing'
        $stuck = Wait-SpoolfreePrintJob -Queue 'Q' -DocumentNames @('d') -TimeoutSeconds 0 -GetJobs { param($q) @([pscustomobject]@{ Id = 8; DocumentName = 'd'; JobStatus = 'Spooling' }) } -Sleep { }
        $stuck.State | Should -Be 'failed'
        $stuck.Message | Should -BeLike '*still in the queue*'
    }
}

Describe 'Running commands' {
    It 'prints through the managed queue and reports sent then printed, once' {
        (Run-Commands @($fx.valid)) | Should -Be 1
        $printed.Count | Should -Be 1
        $printed[0].queue | Should -Be 'Staff Copier'
        $printed[0].doc | Should -Be 'Spoolfree test page 3f2504e0-4f89-41d3-9a0c-0305e82c3301'
        ($printed[0].lines -join "`n") | Should -BeLike '*Reference:  3f2504e0-4f89-41d3-9a0c-0305e82c3301*'
        @($reports | ForEach-Object { $_.state }) | Should -Be @('sent', 'printed')
        $reports[1].jobId | Should -Be 12
        # Single use: the same command (e.g. again in the next manifest) does not print again.
        (Run-Commands @($fx.valid)) | Should -Be 0
        $printed.Count | Should -Be 0
        $reports.Count | Should -Be 0
    }
    It 'rejects a command for a queue it does not manage, and reports it' {
        Run-Commands @($fx.second) | Out-Null
        $printed.Count | Should -Be 0
        $reports[0].state | Should -Be 'rejected'
        $reports[0].message | Should -BeLike "*'Lab Colour' is not a Spoolfree queue*"
    }
    It 'ignores forged, expired and foreign commands without printing or reporting' {
        Run-Commands @($fx.otherKey, $fx.expired, $fx.otherComputer, $fx.manifest) | Should -Be 0
        $printed.Count | Should -Be 0
        $reports.Count | Should -Be 0
    }
    It 'reports a failed print' {
        Remove-Item 'TestRegistry:\Commands' -Recurse -ErrorAction SilentlyContinue
        Run-Commands @($fx.valid) @{ Print = { param($q, $d, $l) throw 'The printer driver is not available' } } | Out-Null
        $reports[0].state | Should -Be 'failed'
        $reports[0].message | Should -BeLike '*driver is not available*'
    }
}

Describe 'Command poll task' {
    It 'takes 0 (off) or 1..60 minutes from the manifest' {
        Get-SpoolfreeCommandPollMinutes 1 | Should -Be 1
        Get-SpoolfreeCommandPollMinutes 0 | Should -Be 0
        Get-SpoolfreeCommandPollMinutes 500 | Should -Be 60
        Get-SpoolfreeCommandPollMinutes $null | Should -Be 0
        Get-SpoolfreeCommandPollMinutes 'x' | Should -Be 0
    }
}
