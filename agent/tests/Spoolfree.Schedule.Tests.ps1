#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Sync interval from the server, and the default printer across rename/replace. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    function Step([string]$action, [string]$name, [string]$id) {
        $p = if ($id) { [pscustomobject]@{ id = $id; name = $name } } else { $null }
        [pscustomobject]@{ Action = $action; Name = $name; Printer = $p }
    }
}

Describe 'Sync interval' {
    It 'clamps to 5..240 minutes with about 20% random delay' {
        $s = Get-SpoolfreeSyncSchedule 15
        $s.IntervalMinutes | Should -Be 15
        $s.RandomDelayMinutes | Should -Be 3
        (Get-SpoolfreeSyncSchedule 60).RandomDelayMinutes | Should -Be 12
        (Get-SpoolfreeSyncSchedule 1).IntervalMinutes | Should -Be 5
        (Get-SpoolfreeSyncSchedule 1).RandomDelayMinutes | Should -Be 1
        (Get-SpoolfreeSyncSchedule 1000).IntervalMinutes | Should -Be 240
        (Get-SpoolfreeSyncSchedule 1000).RandomDelayMinutes | Should -Be 48
        Get-SpoolfreeSyncSchedule 'x' | Should -BeNullOrEmpty
        Get-SpoolfreeSyncSchedule $null | Should -BeNullOrEmpty
    }
}

Describe 'Default printer across rename and replace' {
    It 'maps replaced queues to themselves and renamed queues (same printer id) to the new name' {
        $installed = @(
            [pscustomobject]@{ Name = 'Old Name'; Id = 'p1' },
            [pscustomobject]@{ Name = 'Copier'; Id = 'p2' },
            [pscustomobject]@{ Name = 'Gone'; Id = 'p3' }
        )
        $plan = @((Step 'Remove' 'Old Name'), (Step 'Remove' 'Gone'), (Step 'Add' 'New Name' 'p1'), (Step 'Replace' 'Copier' 'p2'), (Step 'Keep' 'Other' 'p4'))
        $map = Get-SpoolfreeRecreatedQueues -Plan $plan -Installed $installed
        $map['Old Name'] | Should -Be 'New Name'
        $map['Copier'] | Should -Be 'Copier'
        $map.ContainsKey('Gone') | Should -BeFalse
        $map.Count | Should -Be 2
    }
    It 'merges the published map with timestamps' {
        $t1 = [datetime]'2026-11-01T10:00:00Z'; $t2 = [datetime]'2026-11-02T10:00:00Z'
        $m1 = Merge-SpoolfreeRecreatedMap -Previous $null -New @{ 'A' = 'A' } -At $t1
        $m2 = Merge-SpoolfreeRecreatedMap -Previous ($m1 | ConvertTo-Json | ConvertFrom-Json) -New @{ 'B' = 'C' } -At $t2
        $m2['A'].to | Should -Be 'A'
        $m2['B'].to | Should -Be 'C'
        $m2['B'].at | Should -Be $t2.ToUniversalTime().ToString('o')
    }
    It 'restores the default when its queue was re-created after the user last had it' {
        $map = @{ 'Copier' = @{ to = 'Copier'; at = '2026-11-02T10:00:00.0000000Z' }; 'Old Name' = @{ to = 'New Name'; at = '2026-11-02T10:00:00.0000000Z' } }
        # replace: same name, Windows moved the default elsewhere
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Microsoft Print to PDF' -LastKnownDefault 'Copier' -LastKnownAt '2026-11-01T08:00:00Z' -Recreated $map -Existing @('Copier', 'Microsoft Print to PDF') | Should -Be 'Copier'
        # rename
        Get-SpoolfreeDefaultRestore -CurrentDefault '' -LastKnownDefault 'old name' -LastKnownAt '2026-11-01T08:00:00Z' -Recreated $map -Existing @('New Name') | Should -Be 'New Name'
        # already the default: nothing to do
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Copier' -LastKnownDefault 'Copier' -LastKnownAt '2026-11-01T08:00:00Z' -Recreated $map -Existing @('Copier') | Should -BeNullOrEmpty
    }
    It 'leaves the default alone when the user chose it after the re-creation, or the new queue is missing' {
        $map = @{ 'Copier' = @{ to = 'Copier'; at = '2026-11-02T10:00:00.0000000Z' } }
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Other' -LastKnownDefault 'Copier' -LastKnownAt '2026-11-03T08:00:00Z' -Recreated $map -Existing @('Copier', 'Other') | Should -BeNullOrEmpty
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Other' -LastKnownDefault 'Copier' -LastKnownAt '2026-11-01T08:00:00Z' -Recreated $map -Existing @('Other') | Should -BeNullOrEmpty
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Other' -LastKnownDefault 'Unrelated' -LastKnownAt '2026-11-01T08:00:00Z' -Recreated $map -Existing @('Copier') | Should -BeNullOrEmpty
        Get-SpoolfreeDefaultRestore -CurrentDefault 'Other' -LastKnownDefault '' -LastKnownAt '' -Recreated $map -Existing @('Copier') | Should -BeNullOrEmpty
    }
}
