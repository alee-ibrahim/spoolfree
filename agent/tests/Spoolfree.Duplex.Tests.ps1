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

Describe 'Installable duplex unit (0.9.5)' {
    BeforeAll {
        $script:NotInstalled = @(
            [pscustomobject]@{ PropertyName = 'Config:Memory'; Value = '512MB' },
            [pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'NotInstalled' }
        )
    }
    It 'names the duplex property only for a two-sided printer whose driver says NotInstalled' {
        Get-SpoolfreeDuplexUnitProperty -Properties $script:NotInstalled -TwoSided $true | Should -Be 'Config:DuplexUnit'
        Get-SpoolfreeDuplexUnitProperty -Properties @([pscustomobject]@{ PropertyName = 'Config:Duplexer'; Value = 'NotInstalled' }) -TwoSided $true | Should -Be 'Config:Duplexer'
    }
    It 'leaves the driver alone when the printer is one-sided or unknown (old servers, no Test)' {
        Get-SpoolfreeDuplexUnitProperty -Properties $script:NotInstalled -TwoSided $false | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties $script:NotInstalled -TwoSided $null | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties $script:NotInstalled -TwoSided 'true' | Should -BeNullOrEmpty
    }
    It 'never changes an Installed value or other properties' {
        Get-SpoolfreeDuplexUnitProperty -Properties @([pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'Installed' }) -TwoSided $true | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties @([pscustomobject]@{ PropertyName = 'Config:Tray3'; Value = 'NotInstalled' }) -TwoSided $true | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties @([pscustomobject]@{ PropertyName = 'DuplexUnit'; Value = 'NotInstalled' }) -TwoSided $true | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties @() -TwoSided $true | Should -BeNullOrEmpty
        Get-SpoolfreeDuplexUnitProperty -Properties $null -TwoSided $true | Should -BeNullOrEmpty
    }
    It 'sets the property to Installed on the queue and reads it back' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { [pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'Installed' } } -ParameterFilter { $PropertyName -eq 'Config:DuplexUnit' }
        Mock -ModuleName Spoolfree.Agent Set-PrinterProperty {}
        $r = Set-SpoolfreeDuplexUnit -Name 'Staff Color' -TwoSided $true
        $r.Property | Should -Be 'Config:DuplexUnit'
        $r.Installed | Should -BeTrue
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrinterProperty -Times 1 -Exactly -ParameterFilter { $PrinterName -eq 'Staff Color' -and $PropertyName -eq 'Config:DuplexUnit' -and $Value -eq 'Installed' }
    }
    It 'reports a driver that keeps NotInstalled after the set as not installed' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        Mock -ModuleName Spoolfree.Agent Set-PrinterProperty {}
        $r = Set-SpoolfreeDuplexUnit -Name 'Staff Color' -TwoSided $true
        $r.Property | Should -Be 'Config:DuplexUnit'
        $r.Installed | Should -BeFalse
    }
    It 'does not read or change the driver for a printer that is not two-sided' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        Mock -ModuleName Spoolfree.Agent Set-PrinterProperty {}
        Set-SpoolfreeDuplexUnit -Name 'Staff Mono' -TwoSided $false | Should -BeNullOrEmpty
        Should -Invoke -ModuleName Spoolfree.Agent Get-PrinterProperty -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrinterProperty -Times 0
    }
}

Describe 'Vendor duplex unit sync step (0.9.5)' {
    BeforeAll {
        $script:Marker = [pscustomobject]@{ Name = 'Staff Color'; Method = 'Vendor'; Sides = 'two-sided-long-edge'; AutoDuplex = 'unsupported'; DuplexUnit = '' }
        $script:NotInstalled = @([pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'NotInstalled' })
    }
    BeforeEach {
        Mock -ModuleName Spoolfree.Agent Set-PrinterProperty {}
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerValue {}
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerSides {}
    }
    It 'clears the AutoDuplex and Sides markers once the unit reads Installed, so the default duplex is re-applied' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { [pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'Installed' } } -ParameterFilter { $PropertyName -eq 'Config:DuplexUnit' }
        Update-SpoolfreeVendorDuplexUnit -Marker $script:Marker -TwoSided $true | Should -Match 'set to Installed'
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerValue -Times 1 -Exactly -ParameterFilter { $Name -eq 'Staff Color' -and $Property -eq 'AutoDuplex' -and $Value -eq '' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerSides -Times 1 -Exactly -ParameterFilter { $Name -eq 'Staff Color' -and $Sides -eq '' }
        # With Sides cleared, the default duplex step sees a value it has not applied yet.
        Test-SpoolfreeDuplexNeeded -Desired 'two-sided-long-edge' -Applied '' -Recreated $false | Should -BeTrue
    }
    It 'keeps the markers and notes the driver once when it keeps NotInstalled' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        Update-SpoolfreeVendorDuplexUnit -Marker $script:Marker -TwoSided $true | Should -Match 'WARNING'
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerSides -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerValue -Times 0 -ParameterFilter { $Property -eq 'AutoDuplex' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerValue -Times 1 -Exactly -ParameterFilter { $Name -eq 'Staff Color' -and $Property -eq 'DuplexUnit' -and $Value -eq 'ignored' }
    }
    It 'does not touch a queue whose driver was already found to ignore the setting' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { $script:NotInstalled }
        $m = [pscustomobject]@{ Name = 'Staff Color'; Method = 'Vendor'; Sides = ''; AutoDuplex = ''; DuplexUnit = 'ignored' }
        Update-SpoolfreeVendorDuplexUnit -Marker $m -TwoSided $true | Should -BeNullOrEmpty
        Should -Invoke -ModuleName Spoolfree.Agent Get-PrinterProperty -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrinterProperty -Times 0
    }
    It 'does nothing when the unit is already Installed or the printer is not two-sided' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterProperty { [pscustomobject]@{ PropertyName = 'Config:DuplexUnit'; Value = 'Installed' } }
        Update-SpoolfreeVendorDuplexUnit -Marker $script:Marker -TwoSided $true | Should -BeNullOrEmpty
        Update-SpoolfreeVendorDuplexUnit -Marker $script:Marker -TwoSided $false | Should -BeNullOrEmpty
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrinterProperty -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerValue -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarkerSides -Times 0
    }
}
