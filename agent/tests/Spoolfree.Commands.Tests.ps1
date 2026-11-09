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
            LockPath   = (Join-Path $TestDrive 'commands.lock')
            GetJobs    = { param($q) @() }
            EnableEventLog = { }
            Report     = { param($id, $body) $script:reports.Add([pscustomobject]@{ id = $id; state = $body.state; jobId = $body.jobId; message = $body.message }) }
            Print      = { param($queue, $doc, $lines, $timeout) $script:printed.Add([pscustomobject]@{ queue = $queue; doc = $doc; lines = $lines; timeout = $timeout }); [pscustomobject]@{ Route = 'page'; Warning = $null } }
            Wait       = { param($queue, $since, $known, $onSent, $timeout) & $onSent ([pscustomobject]@{ Id = 12; JobStatus = 'Spooling' }); [pscustomobject]@{ State = 'printed'; JobId = 12; JobStatus = 'Printed'; Message = 'spooler job 12: Printed' } }
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

Describe 'Following the test job (0.8.1: PrintService events, never printed unseen)' {
    BeforeAll {
        function Ev([int]$id, $job, [string]$queue, [string]$code) { [pscustomobject]@{ EventId = $id; JobId = $job; Params = @("$job", 'Print Document', 'user', $queue, 'x'); ErrorCode = $code; Time = (Get-Date) } }
        $script:noSleep = { }
    }
    It 'classifies JobStatus' {
        Get-SpoolfreeJobOutcome 'Printing, Retained' | Should -Be 'pending'
        Get-SpoolfreeJobOutcome 'Printed, Retained' | Should -Be 'printed'
        Get-SpoolfreeJobOutcome 'Error, Printing' | Should -Be 'failed'
        Get-SpoolfreeJobOutcome 'PaperOut' | Should -Be 'failed'
        Get-SpoolfreeJobOutcome '' | Should -Be 'pending'
    }
    It 'reports printed only on event 307 for this queue and job, and calls OnSent once' {
        $script:calls = 0
        $script:sent = @()
        $jobs = { param($q) $script:calls++; if ($script:calls -le 2) { @([pscustomobject]@{ Id = 5; JobStatus = 'Printing' }, [pscustomobject]@{ Id = 4; JobStatus = 'Printing' }) } else { @() } }
        $events = { param($since) if ($script:calls -ge 3) { @((Ev 307 99 'Q'), (Ev 307 5 'Other queue'), (Ev 307 5 'Q')) } else { @() } }
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -KnownJobIds @(4) -GetJobs $jobs -GetEvents $events -Sleep $noSleep -OnSent { param($j) $script:sent += $j.Id }
        $r.State | Should -Be 'printed'
        $r.JobId | Should -Be 5
        $r.Message | Should -BeLike '*event 307*'
        $script:sent | Should -Be @(5)
    }
    It 'fails on event 372 with the error code, and removes the job when it is still queued' {
        $script:removed = @()
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -GetJobs { param($q) @([pscustomobject]@{ Id = 3; JobStatus = 'Printing' }) } -GetEvents { param($s) @(Ev 372 3 'Q' '21') } -RemoveJob { param($q, $id) $script:removed += $id } -Sleep $noSleep
        $r.State | Should -Be 'failed'
        $r.JobId | Should -Be 3
        $r.Message | Should -BeLike '*event 372*Win32 error code 21*removed from the queue*'
        $script:removed | Should -Be @(3)
    }
    It 'fails on event 372 even when the spooler deleted the job before it was seen (the Brother PSA case)' {
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -GetJobs { param($q) @() } -GetEvents { param($s) @(Ev 372 7 'Q' '0x15') } -Sleep $noSleep
        $r.State | Should -Be 'failed'
        $r.JobId | Should -Be 7
        $r.Message | Should -BeLike '*0x15*'
    }
    It 'never says printed for a job it never saw: no job and no event gives unknown' {
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -GetJobs { param($q) @() } -GetEvents { param($s) @() } -Sleep $noSleep
        $r.State | Should -Be 'unknown'
        $r.JobId | Should -BeNullOrEmpty
        $r.Message | Should -BeLike '*no job showed up*'
    }
    It 'says unknown when a seen job leaves the queue without an event' {
        $script:n = 0
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -GetJobs { param($q) $script:n++; if ($script:n -eq 1) { @([pscustomobject]@{ Id = 9; JobStatus = 'Spooling' }) } else { @() } } -GetEvents { param($s) @() } -Sleep $noSleep
        $r.State | Should -Be 'unknown'
        $r.JobId | Should -Be 9
    }
    It 'ignores jobs that were in the queue before the test page' {
        $r = Wait-SpoolfreePrintJob -Queue 'Q' -KnownJobIds @(1) -GetJobs { param($q) @([pscustomobject]@{ Id = 1; JobStatus = 'Error' }) } -GetEvents { param($s) @() } -Sleep $noSleep
        $r.State | Should -Be 'unknown'
    }
    It 'fails on a spooler error, and on timeout removes the stuck job (L2)' {
        $script:removed = @()
        $err = Wait-SpoolfreePrintJob -Queue 'Q' -GetJobs { param($q) @([pscustomobject]@{ Id = 7; JobStatus = 'Error, Printing' }) } -GetEvents { param($s) @() } -RemoveJob { param($q, $id) $script:removed += $id } -Sleep $noSleep
        $err.State | Should -Be 'failed'
        $err.JobStatus | Should -Be 'Error, Printing'
        $stuck = Wait-SpoolfreePrintJob -Queue 'Q' -TimeoutSeconds 0 -GetJobs { param($q) @([pscustomobject]@{ Id = 8; JobStatus = 'Spooling' }) } -GetEvents { param($s) @() } -RemoveJob { param($q, $id) $script:removed += $id } -Sleep $noSleep
        $stuck.State | Should -Be 'failed'
        $stuck.Message | Should -BeLike '*still in the queue*the test job was removed from the queue*'
        $script:removed | Should -Be @(7, 8)
    }
    It 'says so when removing the stuck job fails' {
        $stuck = Wait-SpoolfreePrintJob -Queue 'Q' -TimeoutSeconds 0 -GetJobs { param($q) @([pscustomobject]@{ Id = 8; JobStatus = 'Spooling' }) } -GetEvents { param($s) @() } -RemoveJob { param($q, $id) throw 'access denied' } -Sleep $noSleep
        $stuck.Message | Should -BeLike '*removing the test job from the queue failed: access denied*'
    }
}

Describe 'PrintService event parsing' {
    It 'reads event 372 (job, queue, Win32 error code) and 307, and ignores other events' {
        $x372 = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>372</EventID><TimeCreated SystemTime="2026-11-09T05:12:32.1Z"/></System><UserData><DocumentPrintFailed xmlns="http://manifests.microsoft.com/win/2005/08/windows/printing/spooler/core/events"><Param1>3</Param1><Param2>Print Document</Param2><Param3>SYSTEM</Param3><Param4>3F Office Brother HL-L5100DN</Param4><Param5>RAW</Param5><Param6>0</Param6><Param7>0</Param7><Param8>1</Param8><Param9>0</Param9><Param10>PC-LAPTOP-01</Param10><Param11>21</Param11></DocumentPrintFailed></UserData></Event>'
        $e = ConvertFrom-SpoolfreeJobEvent -Xml $x372 -Message ''
        $e.EventId | Should -Be 372
        $e.JobId | Should -Be 3
        $e.Params -contains '3F Office Brother HL-L5100DN' | Should -BeTrue
        $e.ErrorCode | Should -Be '21'
        (ConvertFrom-SpoolfreeJobEvent -Xml $x372 -Message 'Win32 error code returned by the print processor: 0x80004005').ErrorCode | Should -Be '0x80004005'
        $x307 = $x372.Replace('<EventID>372', '<EventID>307')
        (ConvertFrom-SpoolfreeJobEvent -Xml $x307).EventId | Should -Be 307
        ConvertFrom-SpoolfreeJobEvent -Xml $x372.Replace('<EventID>372', '<EventID>310') | Should -BeNullOrEmpty
        ConvertFrom-SpoolfreeJobEvent -Xml 'not xml' | Should -BeNullOrEmpty
    }
}

Describe 'Test page as the logged-on user' {
    BeforeAll {
        $script:fake = @{
            NewWorkDir = { param($p, $u) New-Item -ItemType Directory -Path $p -Force | Out-Null; [IO.File]::WriteAllText((Join-Path $p 'result.json'), '') }
            Sleep      = { }
        }
    }
    It 'refuses with "can''t test: no user session" when nobody is logged on, and prints nothing' {
        $script:registered = 0
        { Send-SpoolfreeTestPageAsUser -Queue 'Q' -DocumentName 'd' -Lines @('a') -GetUser { $null } -RegisterTask { $script:registered++ } -WorkRoot (Join-Path $TestDrive 'w0') } | Should -Throw "can't test: no user session*"
        $script:registered | Should -Be 0
    }
    It 'runs a one-off task as the user with the job in a file, returns its result and cleans up' {
        $root = Join-Path $TestDrive 'w1'
        $script:task = $null; $script:removedTask = $null; $script:jobFile = $null
        $register = {
            param($name, $user, $script, $jobFile)
            $script:task = [pscustomobject]@{ Name = $name; User = $user; Script = $script }
            $script:jobFile = $jobFile
            $job = Get-Content $jobFile -Raw | ConvertFrom-Json
            $job.queue | Should -Be 'Queue "odd" name'
            # What the task does in the user's session.
            Invoke-SpoolfreeTestPageJob -Path $jobFile -Print { param($q, $d, $l) [pscustomobject]@{ Route = 'windows-test-page'; Warning = 'System.Drawing could not print (boom)' } }
        }
        $r = Send-SpoolfreeTestPageAsUser -Queue 'Queue "odd" name' -DocumentName 'd' -Lines @('a', '') -User 'CORP\jdoe' -WorkRoot $root -NewWorkDir $fake.NewWorkDir -RegisterTask $register -RemoveTask { param($n) $script:removedTask = $n } -Sleep $fake.Sleep -SyncScript 'C:\Program Files\Spoolfree\current\Invoke-SpoolfreeSync.ps1'
        $r.User | Should -Be 'CORP\jdoe'
        $r.Route | Should -Be 'windows-test-page'
        $r.Warning | Should -BeLike '*boom*'
        $script:task.User | Should -Be 'CORP\jdoe'
        $script:task.Name | Should -BeLike 'Spoolfree Test Page *'
        $script:removedTask | Should -Be $script:task.Name
        Test-Path (Split-Path $script:jobFile) | Should -BeFalse
    }
    It 'fails (and cleans up) when the task reports an error or does not finish' {
        $root = Join-Path $TestDrive 'w2'
        $script:removedTask = $null
        { Send-SpoolfreeTestPageAsUser -Queue 'Q' -DocumentName 'd' -Lines @('a') -User 'CORP\jdoe' -WorkRoot $root -NewWorkDir $fake.NewWorkDir -Sleep $fake.Sleep `
                -RegisterTask { param($n, $u, $s, $j) Invoke-SpoolfreeTestPageJob -Path $j -Print { throw 'no such printer' } } -RemoveTask { param($n) $script:removedTask = $n } } | Should -Throw '*printing as CORP\jdoe failed: no such printer*'
        $script:removedTask | Should -Not -BeNullOrEmpty
        { Send-SpoolfreeTestPageAsUser -Queue 'Q' -DocumentName 'd' -Lines @('a') -User 'CORP\jdoe' -WorkRoot $root -NewWorkDir $fake.NewWorkDir -Sleep $fake.Sleep -TimeoutSeconds 0 `
                -RegisterTask { } -RemoveTask { } } | Should -Throw '*did not finish*'
        @(Get-ChildItem $root).Count | Should -Be 0
    }
    It 'finds the console user, else the owner of explorer.exe' {
        Get-SpoolfreeInteractiveUser -GetConsoleUser { 'CORP\a' } -GetShellOwners { 'CORP\b' } | Should -Be 'CORP\a'
        Get-SpoolfreeInteractiveUser -GetConsoleUser { '' } -GetShellOwners { @('CORP\b') } | Should -Be 'CORP\b'
        Get-SpoolfreeInteractiveUser -GetConsoleUser { throw 'x' } -GetShellOwners { @() } | Should -BeNullOrEmpty
    }
}

Describe 'printui arguments (L1)' {
    It 'quotes names and refuses double quotes and control characters' {
        ConvertTo-SpoolfreePrintUiArguments -Arguments @('/k', '/q', '/n', 'Staff Copier [1]') | Should -Be 'printui.dll,PrintUIEntry /k /q /n "Staff Copier [1]"'
        { ConvertTo-SpoolfreePrintUiArguments -Arguments @('/n', 'X" /if /b "Y') } | Should -Throw '*double quote*'
        { ConvertTo-SpoolfreePrintUiArguments -Arguments @('/n', "X`nY") } | Should -Throw '*control character*'
        Test-SpoolfreeSafeName 'Lab Colour' | Should -BeTrue
        Test-SpoolfreeSafeName 'a"b' | Should -BeFalse
        Test-SpoolfreeSafeName "a`tb" | Should -BeFalse
    }
    It 'Send-SpoolfreeTestPage never runs printui for a name with a double quote, and keeps the System.Drawing error' {
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreePrintUi { ConvertTo-SpoolfreePrintUiArguments -Arguments $Arguments | Out-Null; 0 }
        $r = Send-SpoolfreeTestPage -Queue 'No such queue 4f1c' -DocumentName 'd' -Lines @('a')
        $r.Route | Should -Be 'windows-test-page'
        $r.Warning | Should -BeLike '*System.Drawing could not print*No such queue 4f1c*'
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreePrintUi -Times 1 -ParameterFilter { ($Arguments -join '|') -eq '/k|/q|/n|No such queue 4f1c' }
        { Send-SpoolfreeTestPage -Queue 'X" /if /b "Y' -DocumentName 'd' -Lines @('a') } | Should -Throw '*double quote*'
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
        Run-Commands @($fx.valid) @{ Print = { param($q, $d, $l, $t) throw 'The printer driver is not available' } } | Out-Null
        $reports[0].state | Should -Be 'failed'
        $reports[0].message | Should -BeLike '*driver is not available*'
    }
}

Describe 'Running commands (0.8.1)' {
    BeforeEach { Remove-Item 'TestRegistry:\Commands' -Recurse -ErrorAction SilentlyContinue }
    It 'reports "can''t test: no user session" as it is, without waiting for a job' {
        $script:waited = 0
        Run-Commands @($fx.valid) @{ Print = { param($q, $d, $l, $t) throw "can't test: no user session on this PC" }; Wait = { $script:waited++ } } | Out-Null
        $reports[0].state | Should -Be 'failed'
        $reports[0].message | Should -BeLike "can't test: no user session*"
        $script:waited | Should -Be 0
    }
    It 'keeps the System.Drawing error in the result when the Windows test page was sent instead' {
        Run-Commands @($fx.valid) @{ Print = { param($q, $d, $l, $t) [pscustomobject]@{ Route = 'windows-test-page'; Warning = 'System.Drawing could not print (Settings to access printer are not valid)' } } } | Out-Null
        $reports[-1].state | Should -Be 'printed'
        $reports[-1].message | Should -BeLike '*System.Drawing could not print (Settings to access printer are not valid)*'
    }
    It 'passes the jobs already in the queue and the start time to the wait' {
        $script:known = $null
        Run-Commands @($fx.valid) @{ GetJobs = { param($q) @([pscustomobject]@{ Id = 41 }, [pscustomobject]@{ Id = 42 }) }; Wait = { param($queue, $since, $known, $onSent, $timeout) $script:known = $known; [pscustomobject]@{ State = 'unknown'; JobId = $null; JobStatus = $null; Message = 'm' } } } | Out-Null
        $script:known | Should -Be @(41, 42)
        $reports[-1].state | Should -Be 'unknown'
    }
    It 'skips the run when another holds the lock (no throw, nothing marked as run) (L4)' {
        $lockPath = Join-Path $TestDrive 'held.lock'
        $held = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $script:logged = @()
            Run-Commands @($fx.valid) @{ LockPath = $lockPath; LockWaitSeconds = 0; Log = { param($m) $script:logged += $m } } | Should -Be 0
            $printed.Count | Should -Be 0
            ($script:logged -join "`n") | Should -BeLike '*another run holds the lock*'
        } finally { $held.Dispose() }
        # Released: the next run prints (the id was not used up).
        Run-Commands @($fx.valid) @{ LockPath = $lockPath } | Should -Be 1
    }
    It 'releases the lock after a run, also after a failure' {
        $lockPath = Join-Path $TestDrive 'release.lock'
        Run-Commands @($fx.valid) @{ LockPath = $lockPath; Print = { param($q, $d, $l, $t) throw 'boom' } } | Out-Null
        $fs = Enter-SpoolfreeCommandLock -Path $lockPath -WaitSeconds 0
        $fs | Should -Not -BeNullOrEmpty
        $fs.Dispose()
    }
    It 'leaves commands for the next run when the time budget is spent (M3)' {
        Run-Commands @($fx.valid) @{ BudgetSeconds = 10 } | Should -Be 0
        $printed.Count | Should -Be 0
        Register-SpoolfreeCommandRun -Id '3f2504e0-4f89-41d3-9a0c-0305e82c3301' -Key 'TestRegistry:\Commands' | Should -BeTrue
    }
    It 'caps the print and wait time inside the budget' {
        $script:waitTimeout = $null
        Run-Commands @($fx.valid) @{ BudgetSeconds = 60; Wait = { param($queue, $since, $known, $onSent, $timeout) $script:waitTimeout = $timeout; [pscustomobject]@{ State = 'unknown'; JobId = $null; JobStatus = $null; Message = 'm' } } } | Out-Null
        $printed[0].timeout | Should -BeLessOrEqual 30
        $script:waitTimeout | Should -BeLessOrEqual 60
    }
}

Describe 'Commands in the hourly sync (M3)' {
    It 'leaves them to the poll task when it exists, else runs them with no lock wait and a 60 s budget' {
        (Get-SpoolfreeSyncCommandPlan -PollMinutes 1 -TaskExists $true -Count 2).Action | Should -Be 'defer'
        $run = Get-SpoolfreeSyncCommandPlan -PollMinutes 1 -TaskExists $false -Count 2
        $run.Action | Should -Be 'run'
        $run.LockWaitSeconds | Should -Be 0
        $run.BudgetSeconds | Should -Be 60
        (Get-SpoolfreeSyncCommandPlan -PollMinutes 0 -TaskExists $true -Count 1).Action | Should -Be 'run'
        (Get-SpoolfreeSyncCommandPlan -PollMinutes 1 -TaskExists $true -Count 0).Action | Should -Be 'none'
    }
}

Describe 'Command poll path (Invoke-SpoolfreeSync.ps1 -CommandsOnly, M2)' {
    BeforeAll {
        $script:sync = Join-Path $PSScriptRoot '..\Invoke-SpoolfreeSync.ps1'
    }
    BeforeEach {
        $script:cfgKey = 'TestRegistry:\Poll' + [guid]::NewGuid().ToString('N')
        New-Item -Path $cfgKey -Force | Out-Null
        New-ItemProperty -Path $cfgKey -Name ServerUrl -Value 'https://spoolfree.example.org/' -PropertyType String | Out-Null
        New-ItemProperty -Path $cfgKey -Name PublicKey -Value $fx.publicKey -PropertyType String | Out-Null
        New-ItemProperty -Path $cfgKey -Name MachineToken -Value (Protect-SpoolfreeSecret 'tok-1') -PropertyType String | Out-Null
        $script:logDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        Mock Get-SpoolfreeComputerIdentity { [pscustomobject]@{ ObjectGuid = 'aaaaaaaa-0000-4000-8000-00000000000a' } }
        Mock Invoke-SpoolfreeCommands { 1 }
        Mock Import-Module { }
    }
    It 'makes one GET, loads nothing, asks AD nothing and logs nothing when nothing is pending' {
        Mock Invoke-RestMethod { [pscustomobject]@{ commands = @() } }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        $LASTEXITCODE | Should -Be 0
        Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter { $Uri -eq 'https://spoolfree.example.org/api/agent/commands' -and $Headers.Authorization -eq 'Bearer tok-1' }
        Should -Invoke Import-Module -Times 0 -Exactly
        Should -Invoke Get-SpoolfreeComputerIdentity -Times 0 -Exactly
        Test-Path (Join-Path $logDir 'commands.log') | Should -BeFalse
    }
    It 'uses the cached objectGUID when commands are pending (no AD lookup)' {
        New-ItemProperty -Path $cfgKey -Name ObjectGuid -Value '0f8fad5b-d9cb-469f-a165-70867728950e' -PropertyType String | Out-Null
        Mock Invoke-RestMethod { [pscustomobject]@{ commands = @($fx.valid) } }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        Should -Invoke Get-SpoolfreeComputerIdentity -Times 0 -Exactly
        Should -Invoke Invoke-SpoolfreeCommands -Times 1 -Exactly -ParameterFilter { $ObjectGuid -eq '0f8fad5b-d9cb-469f-a165-70867728950e' -and $Token -eq 'tok-1' }
        Get-Content (Join-Path $logDir 'commands.log') -Raw | Should -BeLike '*1 pending, 1 run*'
    }
    It 'looks the identity up once and caches it when there is no cache' {
        Mock Invoke-RestMethod { [pscustomobject]@{ commands = @($fx.valid) } }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        Should -Invoke Get-SpoolfreeComputerIdentity -Times 1 -Exactly
        (Get-ItemProperty -Path $cfgKey).ObjectGuid | Should -Be 'aaaaaaaa-0000-4000-8000-00000000000a'
    }
    It 'is quiet off the network: exit 0, one log line an hour, and "works again" once it is back' {
        Mock Invoke-RestMethod { throw [Net.WebException]::new('The remote name could not be resolved') }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        $LASTEXITCODE | Should -Be 0
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        @(Get-Content (Join-Path $logDir 'commands.log')).Count | Should -Be 1
        # An hour later it is logged again.
        New-ItemProperty -Path $cfgKey -Name CommandPollProblem -Value ('{0}|unreachable' -f (Get-Date).ToUniversalTime().AddMinutes(-61).ToString('o')) -PropertyType String -Force | Out-Null
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        @(Get-Content (Join-Path $logDir 'commands.log')).Count | Should -Be 2
        Mock Invoke-RestMethod { [pscustomobject]@{ commands = @() } }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        (Get-Content (Join-Path $logDir 'commands.log'))[-1] | Should -BeLike '*works again*'
        (Get-ItemProperty -Path $cfgKey).PSObject.Properties['CommandPollProblem'] | Should -BeNullOrEmpty
    }
    It 'stays quiet (exit 0) when not enrolled' {
        Remove-ItemProperty -Path $cfgKey -Name MachineToken
        Mock Invoke-RestMethod { throw 'should not be called' }
        & $sync -CommandsOnly -ConfigKey $cfgKey -LogDir $logDir
        $LASTEXITCODE | Should -Be 0
        Should -Invoke Invoke-RestMethod -Times 0 -Exactly
    }
}

Describe 'Identity cache' {
    It 'writes the objectGUID only when it changed' {
        $k = 'TestRegistry:\Id'
        New-Item -Path $k -Force | Out-Null
        Set-SpoolfreeIdentityCache -ObjectGuid 'ABC' -Key $k | Should -BeTrue
        Set-SpoolfreeIdentityCache -ObjectGuid 'abc' -Key $k | Should -BeFalse
        (Get-ItemProperty -Path $k).ObjectGuid | Should -Be 'abc'
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

Describe 'Leftover test page tasks' {
    It 'removes only test page tasks registered more than 15 minutes ago' {
        $now = Get-Date '2026-11-09T10:00:00'
        $tasks = @(
            [pscustomobject]@{ TaskName = 'Spoolfree Test Page old'; Date = '2026-11-09T09:30:00' },
            [pscustomobject]@{ TaskName = 'Spoolfree Test Page running'; Date = '2026-11-09T09:58:00' },
            [pscustomobject]@{ TaskName = 'Spoolfree Commands'; Date = '2026-01-01T00:00:00' }
        )
        $script:gone = @()
        Remove-SpoolfreeTestPageTasks -GetTasks { $tasks } -Unregister { param($n) $script:gone += $n } -Now $now
        $script:gone | Should -Be @('Spoolfree Test Page old')
    }
}
