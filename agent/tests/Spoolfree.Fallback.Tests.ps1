#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Add-Printer -IppURL recovery (0.4.6): stale device cleanup, TCP/IP fallback, "PC left without printer". Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:Uuid = 'e3248000-80ce-11db-8000-0123456789ab'
    $script:Printer = [pscustomobject]@{ id = 'p1'; name = 'Office Printer'; ippUrl = 'http://192.0.2.13:631/ipp/print'; host = '192.0.2.13'; deviceUuid = $script:Uuid; location = '' }
}

Describe 'Test-SpoolfreeIppFallbackError' {
    It 'falls back on every error except "already exists"' {
        Test-SpoolfreeIppFallbackError 'The specified WSD or IPP print device was not found.  Ensure that the specified URL or UUID is correct' | Should -BeTrue
        Test-SpoolfreeIppFallbackError 'An error occurred while performing the specified operation.' | Should -BeTrue
        Test-SpoolfreeIppFallbackError 'Access was denied' | Should -BeTrue
        Test-SpoolfreeIppFallbackError 'The printer already exists.' | Should -BeFalse
    }
}

Describe 'Get-SpoolfreeStaleDeviceItems' {
    It 'finds the unused WSD/IPP port and non-present PnP nodes of exactly this device' {
        $ports = @(
            [pscustomobject]@{ Name = 'WSD-c52b04fe'; PrinterUuid = $script:Uuid },
            [pscustomobject]@{ Name = 'WSD-inuse'; PrinterUuid = $script:Uuid },
            [pscustomobject]@{ Name = 'WSD-other'; PrinterUuid = 'e3248000-80ce-11db-8000-ffffffffffff' }
        )
        $queues = @([pscustomobject]@{ Name = 'Still here'; PortName = 'WSD-INUSE' })
        $up = $script:Uuid.ToUpperInvariant()
        $pnp = @(
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDPROVIDER\URN:UUID:$up"; Present = $false },
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDPROVIDER\URN:UUID:$up/URI:$up/PRINTERSERVICE"; Present = $false },
            [pscustomobject]@{ InstanceId = "SWD\IPP\$up"; Present = $false },
            [pscustomobject]@{ InstanceId = "SWD\IPP\$up"; Present = $true },
            [pscustomobject]@{ InstanceId = "SWD\ESCL\$up"; Present = $false },
            [pscustomobject]@{ InstanceId = "SWD\DAFWSDPROVIDER\URN:UUID:${up}0"; Present = $false },
            [pscustomobject]@{ InstanceId = 'SWD\DAFWSDPROVIDER\URN:UUID:E3248000-80CE-11DB-8000-FFFFFFFFFFFF'; Present = $false }
        )
        $r = Get-SpoolfreeStaleDeviceItems -DeviceUuid "urn:uuid:$($script:Uuid)" -WsdPorts $ports -Queues $queues -PnpDevices $pnp
        @($r.Ports) | Should -Be @('WSD-c52b04fe')
        @($r.PnpIds).Count | Should -Be 3
        @($r.PnpIds) | Should -Contain "SWD\IPP\$up"
        @($r.PnpIds) | Should -Not -Contain "SWD\ESCL\$up"
    }
    It 'does nothing without a device uuid' {
        $r = Get-SpoolfreeStaleDeviceItems -DeviceUuid '' -WsdPorts @([pscustomobject]@{ Name = 'WSD-x'; PrinterUuid = '' })
        @($r.Ports).Count | Should -Be 0
        @($r.PnpIds).Count | Should -Be 0
    }
}

Describe 'Install-SpoolfreePrinterResilient' {
    It 'returns the primary method when -IppURL works' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's'
        $r.Method | Should -Be 'IppURL'
        $r.Fallback | Should -BeFalse
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 1 -Exactly
    }
    It 'retries -IppURL once after removing stale device entries' {
        $script:calls = 0
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { $script:calls++; if ($script:calls -eq 1) { throw 'The specified WSD or IPP print device was not found.' } }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @('removed unused port WSD-c52b04fe') }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's'
        $r.Method | Should -Be 'IppURL'
        $r.Fallback | Should -BeFalse
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 2 -Exactly -ParameterFilter { $Method -eq 'IppURL' }
    }
    It 'never falls back to the class driver on a RAW port when -IppURL keeps failing: needs a vendor driver (0.7.7)' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { if ($Method -eq 'IppURL') { throw 'The specified WSD or IPP print device was not found.' } }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @() }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' } | Should -Throw '*device was not found*needs a vendor driver*'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 0 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' }
    }
    It 'does not fall back on "already exists"' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw 'The printer already exists.' }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @() }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' } | Should -Throw '*already exists*'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 0 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' }
    }
    It 'never falls back under Windows Protected Print Mode' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw 'device was not found' }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @() }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -ProtectedPrintMode $true } | Should -Throw '*Protected Print Mode*'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 0 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' }
    }
    It 'reports both errors when the fallback fails too' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw "$Method broke" }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @() }
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { [pscustomobject]@{ Name = 'Old Driver' } }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -FallbackDriver 'Old Driver' } | Should -Throw '*IppURL broke*TcpIpPort broke*needs a vendor driver*'
    }
    It 'does not try the fallback for the TCP/IP method itself' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw 'port failed' }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'TcpIpPort' -ServerId 's' } | Should -Throw 'port failed'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 1 -Exactly
    }
}

Describe 'Get-SpoolfreeOrphanedPrinters' {
    It 'flags a wanted printer that is missing after its legacy queue was removed' {
        $map = [pscustomobject]@{ 'Brother (Copy 1)' = 'Office Printer'; 'Old HP' = 'Lab Printer' }
        $o = @(Get-SpoolfreeOrphanedPrinters -Desired @('Office Printer', 'Lab Printer') -Installed @('lab printer') -RemovedMap $map)
        $o.Count | Should -Be 1
        $o[0].Printer | Should -Be 'Office Printer'
        @($o[0].Queues) | Should -Be @('Brother (Copy 1)')
    }
    It 'ignores missing printers that took over nothing, and printers no longer assigned' {
        $map = @{ 'Old queue' = 'Unassigned Printer' }
        @(Get-SpoolfreeOrphanedPrinters -Desired @('New Printer') -Installed @() -RemovedMap $map).Count | Should -Be 0
        @(Get-SpoolfreeOrphanedPrinters -Desired @('New Printer') -Installed @() -RemovedMap $null).Count | Should -Be 0
    }
}
