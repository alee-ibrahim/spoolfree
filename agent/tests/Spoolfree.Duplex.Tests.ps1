#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Default duplex (manifest printer.defaultSides). Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
}

Describe 'Default duplex' {
    It 'maps IPP sides keywords to Set-PrintConfiguration duplexing modes' {
        ConvertTo-SpoolfreeDuplexingMode 'one-sided' | Should -Be 'OneSided'
        ConvertTo-SpoolfreeDuplexingMode 'two-sided-long-edge' | Should -Be 'TwoSidedLongEdge'
        ConvertTo-SpoolfreeDuplexingMode 'two-sided-short-edge' | Should -Be 'TwoSidedShortEdge'
        ConvertTo-SpoolfreeDuplexingMode 'auto' | Should -BeNullOrEmpty
        ConvertTo-SpoolfreeDuplexingMode 'duplex' | Should -BeNullOrEmpty
        ConvertTo-SpoolfreeDuplexingMode '' | Should -BeNullOrEmpty
    }
    It 'reads the desired value from the manifest, auto when missing or unknown (old servers)' {
        Get-SpoolfreeDesiredSides ([pscustomobject]@{ name = 'A'; defaultSides = 'two-sided-long-edge' }) | Should -Be 'two-sided-long-edge'
        Get-SpoolfreeDesiredSides ([pscustomobject]@{ name = 'A' }) | Should -Be 'auto'
        Get-SpoolfreeDesiredSides ([pscustomobject]@{ name = 'A'; defaultSides = 'bogus' }) | Should -Be 'auto'
    }
    It 'applies only when the manifest value changes or the queue was re-created' {
        Test-SpoolfreeDuplexNeeded -Desired 'two-sided-long-edge' -Applied '' -Recreated $false | Should -BeTrue
        Test-SpoolfreeDuplexNeeded -Desired 'two-sided-long-edge' -Applied 'two-sided-long-edge' -Recreated $false | Should -BeFalse
        Test-SpoolfreeDuplexNeeded -Desired 'two-sided-long-edge' -Applied 'two-sided-long-edge' -Recreated $true | Should -BeTrue
        Test-SpoolfreeDuplexNeeded -Desired 'one-sided' -Applied 'two-sided-long-edge' -Recreated $false | Should -BeTrue
        Test-SpoolfreeDuplexNeeded -Desired 'auto' -Applied 'two-sided-long-edge' -Recreated $true | Should -BeFalse
        Test-SpoolfreeDuplexNeeded -Desired 'auto' -Applied '' -Recreated $false | Should -BeFalse
    }
    It 'calls Set-PrintConfiguration with the mapped mode' {
        Mock -ModuleName Spoolfree.Agent Set-PrintConfiguration { }
        Set-SpoolfreeQueueDuplex -Name 'Staff Copier' -Sides 'two-sided-short-edge'
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrintConfiguration -Times 1 -ParameterFilter { $PrinterName -eq 'Staff Copier' -and $DuplexingMode -eq 'TwoSidedShortEdge' }
        { Set-SpoolfreeQueueDuplex -Name 'X' -Sides 'auto' } | Should -Throw
    }
}
