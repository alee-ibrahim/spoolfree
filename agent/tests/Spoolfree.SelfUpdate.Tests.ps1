#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Agent self-update: bundle verification, staged install + folder swap, launcher rollback. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:fx = Get-Content (Join-Path $PSScriptRoot 'fixtures\signed-bundle.json') -Raw | ConvertFrom-Json
    $script:launcher = Join-Path $PSScriptRoot '..\Start-SpoolfreeSync.ps1'
    function Bytes($entry) { return , [Convert]::FromBase64String($entry.bytes) }
    function Manifest([string]$Version, [string]$Sha, $Allow) {
        $m = [ordered]@{ agentVersion = $Version; agentBundle = [ordered]@{ sha256 = $Sha; size = 1; signature = 'x' } }
        if ($null -ne $Allow) { $m['agentAllowDowngrade'] = $Allow }
        return [pscustomobject]$m
    }
    function New-TestKey { $k = "HKCU:\Software\SpoolfreeTests\$([guid]::NewGuid())"; New-Item -Path $k -Force | Out-Null; return $k }
    function Write-Agent([string]$Dir, [string]$Version, [string]$SyncBody) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        Set-Content -Path (Join-Path $Dir 'Spoolfree.Agent.psm1') -Value "`$script:AgentVersion = '$Version'" -Encoding ASCII
        Set-Content -Path (Join-Path $Dir 'Invoke-SpoolfreeSync.ps1') -Value $SyncBody -Encoding ASCII
        Set-Content -Path (Join-Path $Dir 'Set-SpoolfreeUserDefault.ps1') -Value '#' -Encoding ASCII
    }
}

AfterAll {
    Remove-Item -Path 'HKCU:\Software\SpoolfreeTests' -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Bundle verification' {
    It 'accepts a bundle signed by the Node.js server code and returns its files' {
        $files = Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.valid) -Sha256 $fx.valid.sha256 -Signature $fx.valid.signature -PublicKey $fx.publicKey -Version '9.9.9'
        @($files.Keys) | Should -Be @('Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1')
        [Text.Encoding]::UTF8.GetString($files['Invoke-SpoolfreeSync.ps1']) | Should -Be "exit 0`n"
    }
    It 'rejects a hash that differs from the manifest' {
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.valid) -Sha256 ('0' * 64) -Signature $fx.valid.signature -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw '*hash mismatch*'
    }
    It 'rejects modified bytes even with their own hash' {
        $b = Bytes $fx.valid
        $b[20] = $b[20] -bxor 1
        { Test-SpoolfreeAgentBundle -Bytes $b -Sha256 (Get-SpoolfreeSha256 $b) -Signature $fx.valid.signature -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw '*signature is invalid*'
    }
    It 'rejects an unsigned bundle and one signed by another key' {
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.valid) -Sha256 $fx.valid.sha256 -Signature '' -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw '*signature is invalid*'
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.otherKey) -Sha256 $fx.otherKey.sha256 -Signature $fx.otherKey.signature -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw '*signature is invalid*'
    }
    It 'rejects a version other than the one offered' {
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.valid) -Sha256 $fx.valid.sha256 -Signature $fx.valid.signature -PublicKey $fx.publicKey -Version '9.9.8' } | Should -Throw '*manifest offers*'
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.wrongModuleVersion) -Sha256 $fx.wrongModuleVersion.sha256 -Signature $fx.wrongModuleVersion.signature -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw '*declares version*'
    }
    It 'rejects file names outside the fixed list, even when signed' {
        { Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.unknownFile) -Sha256 $fx.unknownFile.sha256 -Signature $fx.unknownFile.signature -PublicKey $fx.publicKey -Version '9.9.9' } | Should -Throw "*Unexpected file 'evil.ps1'*"
    }
}

Describe 'Update decision' {
    BeforeAll { $script:sha = 'a' * 64 }
    It 'updates when the offered version differs and is newer' {
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.4' $sha) -CurrentVersion '0.4.3').Action | Should -Be 'update'
    }
    It 'does nothing when up to date or nothing is offered' {
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.3' $sha) -CurrentVersion '0.4.3').Action | Should -Be 'none'
        (Get-SpoolfreeUpdateDecision -Manifest ([pscustomobject]@{ schema = 1 }) -CurrentVersion '0.4.3').Action | Should -Be 'none'
    }
    It 'never downgrades unless the manifest says agentAllowDowngrade = true' {
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.2' $sha) -CurrentVersion '0.4.3').Action | Should -Be 'skip'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.2' $sha 'true') -CurrentVersion '0.4.3').Action | Should -Be 'skip'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.2' $sha 1) -CurrentVersion '0.4.3').Action | Should -Be 'skip'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.2' $sha $true) -CurrentVersion '0.4.3').Action | Should -Be 'update'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.10' $sha) -CurrentVersion '0.4.9').Action | Should -Be 'update'
    }
    It 'skips a bundle that was rolled back here, and invalid offers' {
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.4' $sha) -CurrentVersion '0.4.3' -BadSha256 $sha.ToUpper()).Action | Should -Be 'skip'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.4' ('b' * 64)) -CurrentVersion '0.4.3' -BadSha256 $sha).Action | Should -Be 'update'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4' $sha) -CurrentVersion '0.4.3').Action | Should -Be 'skip'
        (Get-SpoolfreeUpdateDecision -Manifest (Manifest '0.4.4' 'nothex') -CurrentVersion '0.4.3').Action | Should -Be 'skip'
    }
    It 'reads the version a module file declares' {
        Get-SpoolfreeFileAgentVersion -Text "Set-StrictMode`n`$script:AgentVersion = '1.2.3'`n" | Should -Be '1.2.3'
        Get-SpoolfreeFileAgentVersion -Text '# $script:AgentVersion = ''1.2.3''' | Should -BeNullOrEmpty
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') | Should -Be (Get-SpoolfreeAgentVersion)
    }
}

Describe 'Install directory ACL check' {
    BeforeAll {
        function Rule([string]$Sid, [string]$Rights, [string]$Type = 'Allow') {
            New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $Sid), $Rights, $Type)
        }
    }
    It 'allows write only for SYSTEM, Administrators and TrustedInstaller' {
        Test-SpoolfreeWriteRules @((Rule 'S-1-5-18' 'FullControl'), (Rule 'S-1-5-32-544' 'FullControl'), (Rule 'S-1-5-32-545' 'ReadAndExecute')) | Should -BeTrue
        Test-SpoolfreeWriteRules @((Rule 'S-1-5-32-545' 'Modify')) | Should -BeFalse
        Test-SpoolfreeWriteRules @((Rule 'S-1-5-11' 'Write')) | Should -BeFalse
        Test-SpoolfreeWriteRules @((Rule 'S-1-1-0' 'ChangePermissions')) | Should -BeFalse
        Test-SpoolfreeWriteRules @((Rule 'S-1-5-32-545' 'Modify' 'Deny')) | Should -BeTrue
    }
}

Describe 'Staged install and folder swap' {
    BeforeEach {
        $script:root = Join-Path $TestDrive ([guid]::NewGuid())
        New-Item -ItemType Directory -Path $root | Out-Null
        $script:files = Test-SpoolfreeAgentBundle -Bytes (Bytes $fx.valid) -Sha256 $fx.valid.sha256 -Signature $fx.valid.signature -PublicKey $fx.publicKey -Version '9.9.9'
    }
    It 'installs into current\ and keeps the replaced version in previous\' {
        Write-Agent (Join-Path $root 'current') '0.4.3' 'exit 0'
        Install-SpoolfreeAgentFiles -Root $root -Files $files -SkipAcl | Should -Be '0.4.3'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Be '9.9.9'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'previous\Spoolfree.Agent.psm1') | Should -Be '0.4.3'
        Test-Path (Join-Path $root 'staging') | Should -BeFalse
        (Get-SpoolfreeSha256 ([IO.File]::ReadAllBytes((Join-Path $root 'current\Invoke-SpoolfreeSync.ps1')))) | Should -Be (Get-SpoolfreeSha256 $files['Invoke-SpoolfreeSync.ps1'])
    }
    It 'replaces an older previous\ and works without a current\' {
        Install-SpoolfreeAgentFiles -Root $root -Files $files -SkipAcl | Should -BeNullOrEmpty
        Test-Path (Join-Path $root 'previous') | Should -BeFalse
        Write-Agent (Join-Path $root 'previous') '0.0.1' 'exit 0'
        Install-SpoolfreeAgentFiles -Root $root -Files $files -SkipAcl | Should -Be '9.9.9'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'previous\Spoolfree.Agent.psm1') | Should -Be '9.9.9'
    }
    It 'refuses unknown file names and incomplete sets, leaving current\ alone' {
        Write-Agent (Join-Path $root 'current') '0.4.3' 'exit 0'
        $bad = [ordered]@{ 'evil.ps1' = [byte[]]@(1) }
        { Install-SpoolfreeAgentFiles -Root $root -Files $bad -SkipAcl } | Should -Throw "*Unexpected agent file*"
        $partial = [ordered]@{ 'Spoolfree.Agent.psm1' = $files['Spoolfree.Agent.psm1'] }
        { Install-SpoolfreeAgentFiles -Root $root -Files $partial -SkipAcl } | Should -Throw '*lack*'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Be '0.4.3'
        Test-Path (Join-Path $root 'staging') | Should -BeFalse
        Test-Path (Join-Path $root 'previous') | Should -BeFalse
    }
    It 'undoes the first rename when the second one fails' {
        Write-Agent (Join-Path $root 'current') '0.4.3' 'exit 0'
        $global:SpoolfreeTestStaged = Join-Path $root 'staging\Invoke-SpoolfreeSync.ps1'
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeFileAgentVersion {
            # Runs between staging and the swap: lock a staged file so the folder cannot be renamed.
            $global:SpoolfreeTestLock = [IO.File]::Open($global:SpoolfreeTestStaged, 'Open', 'Read', 'None')
            return '0.4.3'
        } -ParameterFilter { $Path -like '*current*' }
        try {
            { Install-SpoolfreeAgentFiles -Root $root -Files $files -SkipAcl } | Should -Throw '*Swapping in the new agent failed*'
        } finally { if ($global:SpoolfreeTestLock) { $global:SpoolfreeTestLock.Dispose(); $global:SpoolfreeTestLock = $null } }
        Get-Content (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Match '0.4.3'
        Test-Path (Join-Path $root 'current\Invoke-SpoolfreeSync.ps1') | Should -BeTrue
    }
}

Describe 'Self-update end to end (module side)' {
    BeforeEach {
        $script:root = Join-Path $TestDrive ([guid]::NewGuid())
        Write-Agent (Join-Path $root 'current') '0.4.3' 'exit 0'
        $script:key = New-TestKey
        $script:offer = [pscustomobject]@{ agentVersion = '9.9.9'; agentBundle = [pscustomobject]@{ sha256 = $fx.valid.sha256; size = 1; signature = $fx.valid.signature } }
        $script:dl = { param($u, $t) return , [Convert]::FromBase64String($fx.valid.bytes) }
    }
    It 'downloads, verifies, swaps and marks the version pending' {
        $msg = Invoke-SpoolfreeAgentUpdate -Manifest $offer -BaseUrl 'https://x' -Token 't' -PublicKey $fx.publicKey -Root $root -Key $key -CurrentVersion '0.4.3' -Download $dl -SkipAcl
        $msg | Should -Match '9.9.9 installed'
        $s = Get-SpoolfreeUpdateState -Key $key
        $s.PendingVersion | Should -Be '9.9.9'
        $s.PendingSha256 | Should -Be $fx.valid.sha256
        $s.FromVersion | Should -Be '0.4.3'
        (Get-SpoolfreeUpdateReport -Key $key).state | Should -Be 'pending'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Be '9.9.9'
        Confirm-SpoolfreeAgentRun -Key $key -Version '9.9.9' | Should -BeTrue
        (Get-SpoolfreeUpdateState -Key $key).ConfirmedVersion | Should -Be '9.9.9'
    }
    It 'records a failure and installs nothing when the signature does not verify' {
        $offer.agentBundle.signature = $fx.otherKey.signature
        { Invoke-SpoolfreeAgentUpdate -Manifest $offer -BaseUrl 'https://x' -Token 't' -PublicKey $fx.publicKey -Root $root -Key $key -CurrentVersion '0.4.3' -Download $dl -SkipAcl } | Should -Throw '*signature is invalid*'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Be '0.4.3'
        $r = Get-SpoolfreeUpdateReport -Key $key
        $r.state | Should -Be 'failed'
        $r.target | Should -Be '9.9.9'
        (Get-SpoolfreeUpdateState -Key $key).PendingVersion | Should -BeNullOrEmpty
    }
    It 'refuses a downgrade and reports it as skipped' {
        Invoke-SpoolfreeAgentUpdate -Manifest $offer -BaseUrl 'https://x' -Token 't' -PublicKey $fx.publicKey -Root $root -Key $key -CurrentVersion '10.0.0' -Download $dl -SkipAcl | Should -Match 'skipped'
        (Get-SpoolfreeUpdateReport -Key $key).state | Should -Be 'skipped'
        Get-SpoolfreeFileAgentVersion -Path (Join-Path $root 'current\Spoolfree.Agent.psm1') | Should -Be '0.4.3'
    }
}

Describe 'Launcher: confirm and roll back' {
    BeforeAll {
        . $launcher
    }
    BeforeEach {
        $script:lr = Join-Path $TestDrive ([guid]::NewGuid())
        $script:key = New-TestKey
        $script:log = Join-Path $lr 'sync.log'
        $script:runs = Join-Path $lr 'runs.txt'
        New-Item -ItemType Directory -Path $lr | Out-Null
        Write-Agent (Join-Path $lr 'previous') '0.4.3' "Add-Content -Path '$runs' -Value old; exit 0"
        Set-LauncherState $key @{ PendingVersion = '9.9.9'; PendingSha256 = ('c' * 64); FromVersion = '0.4.3'; Failures = 0 }
    }
    It 'clears the pending state once the new version confirms' {
        $kp = $key -replace '^HKCU:', 'HKCU:'
        Write-Agent (Join-Path $lr 'current') '9.9.9' "New-ItemProperty -Path '$kp' -Name ConfirmedVersion -Value '9.9.9' -Force | Out-Null; Add-Content -Path '$runs' -Value new; exit 1"
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 1
        $s = Get-LauncherState $key
        $s['PendingVersion'] | Should -BeNullOrEmpty
        $s['LastState'] | Should -Be 'updated'
        $s['LastVersion'] | Should -Be '9.9.9'
        Get-Content $runs | Should -Be @('new')
    }
    It 'does not count "server unreachable" (exit 4) as a failure' {
        Write-Agent (Join-Path $lr 'current') '9.9.9' 'exit 4'
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 4
        [int](Get-LauncherState $key)['Failures'] | Should -Be 0
    }
    It 'rolls back after the second failed run, runs the previous version and marks the bundle bad' {
        Write-Agent (Join-Path $lr 'current') '9.9.9' 'throw "broken"'
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Not -Be 0
        [int](Get-LauncherState $key)['Failures'] | Should -Be 1
        Get-LauncherVersion (Join-Path $lr 'current') | Should -Be '9.9.9'

        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 0
        Get-LauncherVersion (Join-Path $lr 'current') | Should -Be '0.4.3'
        Test-Path (Join-Path $lr 'previous') | Should -BeFalse
        Test-Path (Join-Path $lr 'failed') | Should -BeFalse
        Get-Content $runs | Should -Be @('old')
        $s = Get-LauncherState $key
        $s['PendingVersion'] | Should -BeNullOrEmpty
        $s['LastState'] | Should -Be 'rolled-back'
        $s['LastVersion'] | Should -Be '9.9.9'
        $s['BadSha256'] | Should -Be ('c' * 64)
        Get-Content $log -Raw | Should -Match 'rolled back to 0.4.3'

        # The old version then reports it, and does not install the same bundle again.
        Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
        $r = Get-SpoolfreeUpdateReport -Key $key
        $r.state | Should -Be 'rolled-back'
        $r.error | Should -Match 'failed to run twice'
        $m = [pscustomobject]@{ agentVersion = '9.9.9'; agentBundle = [pscustomobject]@{ sha256 = ('c' * 64) } }
        (Get-SpoolfreeUpdateDecision -Manifest $m -CurrentVersion '0.4.3' -BadSha256 $s['BadSha256']).Action | Should -Be 'skip'
    }
    It 'rolls back before running when two failures are already recorded (e.g. after a timeout)' {
        Write-Agent (Join-Path $lr 'current') '9.9.9' 'exit 7'
        Set-LauncherState $key @{ Failures = 2 }
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 0
        Get-LauncherVersion (Join-Path $lr 'current') | Should -Be '0.4.3'
        (Get-LauncherState $key)['LastState'] | Should -Be 'rolled-back'
    }
    It 'counts a timeout as a failure' {
        Write-Agent (Join-Path $lr 'current') '9.9.9' 'Start-Sleep -Seconds 120'
        Mock Invoke-SpoolfreeChild { return -1 }
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be -1
        [int](Get-LauncherState $key)['Failures'] | Should -Be 1
    }
    It 'repairs an interrupted swap and forgets a pending version that is not installed' {
        # current\ missing: previous\ (0.4.3) becomes current\; the pending 9.9.9 never made it in.
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 0
        Get-LauncherVersion (Join-Path $lr 'current') | Should -Be '0.4.3'
        (Get-LauncherState $key)['PendingVersion'] | Should -BeNullOrEmpty
        (Get-LauncherState $key)['LastState'] | Should -BeNullOrEmpty
        Get-Content $runs | Should -Be @('old')
    }
    It 'runs as a script (powershell -File, no -Root): finds current\ next to itself and returns the sync exit code' {
        # The scheduled task runs it this way; Windows PowerShell 5.1 leaves $PSScriptRoot empty in param defaults.
        Copy-Item $launcher (Join-Path $lr 'Start-SpoolfreeSync.ps1')
        Write-Agent (Join-Path $lr 'current') '0.4.3' "Add-Content -Path '$runs' -Value ran; exit 1"
        Set-LauncherState $key @{ PendingVersion = $null; PendingSha256 = $null; FromVersion = $null; Failures = $null }
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $lr 'Start-SpoolfreeSync.ps1') -StateKey $key -LogPath $log
        $LASTEXITCODE | Should -Be 1
        Get-Content $runs | Should -Be @('ran')
    }
    It 'reports a failed update when there is nothing to roll back to' {
        Remove-Item (Join-Path $lr 'previous') -Recurse -Force
        Write-Agent (Join-Path $lr 'current') '9.9.9' 'exit 9'
        Set-LauncherState $key @{ Failures = 1 }
        Invoke-SpoolfreeLauncher -Root $lr -Key $key -LogFile $log | Should -Be 9
        $s = Get-LauncherState $key
        $s['LastState'] | Should -Be 'failed'
        $s['PendingVersion'] | Should -BeNullOrEmpty
    }
}
