#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# 0.6.2: never leave a PC without a printer after legacy takeover. "The specified printer already exists" from
# Add-Printer -IppURL while no queue has that name: blocking queue re-scan, stale device association, TCP/IP fallback
# with the replaced queue's driver; literal queue names (no wildcards). Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:Uuid = '564e424b-4e37-4433-3258-0123456789ab'
    $script:Printer = [pscustomobject]@{ id = 'p1'; name = 'Office HP'; revision = 1; ippUrl = 'http://192.0.2.20:631/ipp/print'; host = '192.0.2.20'; deviceUuid = $script:Uuid; location = '' }
    $script:Exists = 'The specified printer already exists.'
}

Describe 'Test-SpoolfreeIppFallbackError -NameFree' {
    It 'allows the fallback for "already exists" only when the name is free' {
        Test-SpoolfreeIppFallbackError $script:Exists | Should -BeFalse
        Test-SpoolfreeIppFallbackError $script:Exists -NameFree | Should -BeTrue
        Test-SpoolfreeIppFallbackError 'device was not found' -NameFree | Should -BeTrue
    }
}

Describe 'Get-SpoolfreeStaleAssociationKeys' {
    It 'returns only the WSD/IPP association entries of exactly this device' {
        $keys = @(
            "DAFWSDProvider#urn:uuid:$($script:Uuid)",
            "DAFIPPProvider#$($script:Uuid)",
            "DAFWSDProvider#urn:uuid:$($script:Uuid)0",
            'DAFWSDProvider#urn:uuid:e3248000-80ce-11db-8000-ffffffffffff',
            "BTHENUM#$($script:Uuid)"
        )
        $r = @(Get-SpoolfreeStaleAssociationKeys -DeviceUuid "urn:uuid:$($script:Uuid.ToUpperInvariant())" -Keys $keys)
        $r.Count | Should -Be 2
        $r | Should -Contain "DAFWSDProvider#urn:uuid:$($script:Uuid)"
        $r | Should -Contain "DAFIPPProvider#$($script:Uuid)"
    }
    It 'returns nothing while a queue still uses the device, or without a uuid' {
        @(Get-SpoolfreeStaleAssociationKeys -DeviceUuid $script:Uuid -Keys @("DAFWSDProvider#urn:uuid:$($script:Uuid)") -InUse $true).Count | Should -Be 0
        @(Get-SpoolfreeStaleAssociationKeys -DeviceUuid '' -Keys @('DAFWSDProvider#urn:uuid:')).Count | Should -Be 0
    }
}

Describe 'Get-SpoolfreeLegacyDriverChoice' {
    It 'picks the model driver of a local queue' {
        $q = @(
            [pscustomobject]@{ Name = 'NPID6858B (HP Color LaserJet MFP M283fdw)'; DriverName = 'Microsoft IPP Class Driver'; Type = 'Local' },
            [pscustomobject]@{ Name = '\\srv\hp'; DriverName = 'HP Universal Printing PCL 6'; Type = 'Connection' },
            [pscustomobject]@{ Name = 'Admin HP'; DriverName = 'HP ColorLaserJet MFP M282-M285 PCL-6 (V4)'; Type = 'Local' }
        )
        Get-SpoolfreeLegacyDriverChoice -Queues $q | Should -Be 'HP ColorLaserJet MFP M282-M285 PCL-6 (V4)'
    }
    It 'returns nothing for class/generic drivers only' {
        Get-SpoolfreeLegacyDriverChoice -Queues @([pscustomobject]@{ Name = 'x'; DriverName = 'Microsoft IPP Class Driver'; Type = 'Local' }) | Should -BeNullOrEmpty
    }
}

Describe 'Get-SpoolfreeQueueByName / Remove-SpoolfreeQueue' {
    BeforeEach {
        $script:queues = [System.Collections.Generic.List[object]]::new()
        $script:queues.Add([pscustomobject]@{ Name = 'HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]' })
        $script:queues.Add([pscustomobject]@{ Name = 'HP Color LaserJet Pro MFP 3303 H' })
        Mock -ModuleName Spoolfree.Agent Get-Printer { $script:queues.ToArray() }
    }
    It 'matches names literally, so [ ] are not wildcards' {
        (Get-SpoolfreeQueueByName -Name 'HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]').Name | Should -Be 'HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]'
        Get-SpoolfreeQueueByName -Name 'HP Color LaserJet Pro MFP 3303 [HP]' | Should -BeNullOrEmpty
    }
    It 'removes exactly that queue and checks it is gone' {
        Mock -ModuleName Spoolfree.Agent -RemoveParameterType InputObject Remove-Printer { $null = $script:queues.Remove($InputObject) }
        Remove-SpoolfreeQueue -Name 'HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]'
        @($script:queues | ForEach-Object Name) | Should -Be @('HP Color LaserJet Pro MFP 3303 H')
    }
    It 'throws when Windows kept the queue (never reports a silent no-op as removed)' {
        Mock -ModuleName Spoolfree.Agent -RemoveParameterType InputObject Remove-Printer { }
        { Remove-SpoolfreeQueue -Name 'HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]' } | Should -Throw '*still there*'
    }
    It 'throws when there is no such queue' {
        Mock -ModuleName Spoolfree.Agent -RemoveParameterType InputObject Remove-Printer { }
        { Remove-SpoolfreeQueue -Name 'nope' } | Should -Throw '*not found*'
        Should -Invoke -ModuleName Spoolfree.Agent Remove-Printer -Times 0 -Exactly
    }
}

Describe 'Install-SpoolfreePrinterResilient: "already exists" after takeover' {
    BeforeEach {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeQueueByName { $null }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleDevice { @() }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleAssociation { @() }
        Mock -ModuleName Spoolfree.Agent Remove-SpoolfreeQueue { }
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { [pscustomobject]@{ Name = $Name } }
    }
    It 'keeps the old behaviour without takeover recovery (dry-run): no fallback' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw $script:Exists }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' } | Should -Throw '*already exists*'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 0 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' }
    }
    It 'never falls back when a queue really has that name' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeQueueByName { [pscustomobject]@{ Name = 'Office HP' } }
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw $script:Exists }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true } | Should -Throw '*already exists*'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 0 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' }
    }
    It '(a) removes a queue that holds the device (e.g. re-created by Windows) and retries -IppURL' {
        $script:calls = 0
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { $script:calls++; if ($script:calls -eq 1) { throw $script:Exists } }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -FindBlocking { 'HP ColorLaserJet MFP M282-M285 (auto)' }
        $r.Method | Should -Be 'IppURL'
        $r.Fallback | Should -BeFalse
        @($r.RemovedQueues) | Should -Be @('HP ColorLaserJet MFP M282-M285 (auto)')
        Should -Invoke -ModuleName Spoolfree.Agent Remove-SpoolfreeQueue -Times 1 -Exactly -ParameterFilter { $Name -eq 'HP ColorLaserJet MFP M282-M285 (auto)' }
        Should -Invoke -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleAssociation -Times 0 -Exactly
    }
    It '(b) clears the stale device association and retries -IppURL when no queue holds the device' {
        $script:calls = 0
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { $script:calls++; if ($script:calls -eq 1) { throw $script:Exists } }
        Mock -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleAssociation { @("removed stale device association DAFWSDProvider#urn:uuid:$($script:Uuid)") }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -FindBlocking { @() }
        $r.Method | Should -Be 'IppURL'
        $r.Fallback | Should -BeFalse
        @($r.Notes) -join ' ' | Should -Match 'stale device association'
        Should -Invoke -ModuleName Spoolfree.Agent Clear-SpoolfreeStaleAssociation -Times 1 -Exactly -ParameterFilter { $DeviceUuid -eq $script:Uuid }
    }
    It '(c) never leaves the PC without the printer: TCP/IP fallback with the replaced queue''s driver' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { if ($Method -eq 'IppURL') { throw $script:Exists } }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -FallbackDriver 'HP ColorLaserJet MFP M282-M285 PCL-6 (V4)'
        $r.Method | Should -Be 'TcpIpPort'
        $r.Fallback | Should -BeTrue
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 1 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' -and $DriverName -eq 'HP ColorLaserJet MFP M282-M285 PCL-6 (V4)' }
        @($r.Notes)[-1] | Should -Match 'driver of the replaced queue'
    }
    It '(c) uses the IPP class driver when the old driver is gone' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { $null }
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { if ($Method -eq 'IppURL') { throw $script:Exists } }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -FallbackDriver 'Removed Driver'
        $r.Method | Should -Be 'TcpIpPort'
        Should -Invoke -ModuleName Spoolfree.Agent Install-SpoolfreePrinter -Times 1 -Exactly -ParameterFilter { $Method -eq 'TcpIpPort' -and -not $DriverName }
    }
    It 'still respects Windows Protected Print Mode' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { throw $script:Exists }
        { Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -ProtectedPrintMode $true } | Should -Throw '*Protected Print Mode*'
    }
    It 'reports a failing re-scan but goes on' {
        Mock -ModuleName Spoolfree.Agent Install-SpoolfreePrinter { if ($Method -eq 'IppURL') { throw $script:Exists } }
        $r = Install-SpoolfreePrinterResilient -Printer $script:Printer -Method 'IppURL' -ServerId 's' -TakeoverRecovery $true -FindBlocking { throw 'inventory broke' }
        $r.Method | Should -Be 'TcpIpPort'
        @($r.Notes) -join ' ' | Should -Match 're-scan for blocking queues failed: inventory broke'
    }
}

Describe 'Get-SpoolfreeTakeoverPrinters' {
    It 'reads the published removed map (JSON object) and this sync''s removals by entry' {
        $json = '{"removedMap":{"procurement-hp-m277dw":"9F Procurement HP","Old (Copy 1)":"Office HP"}}' | ConvertFrom-Json
        $r = Get-SpoolfreeTakeoverPrinters -RemovedMap $json.removedMap -Removed @{ 'legacy x' = 'Lab Printer' }
        @($r.Keys | Sort-Object) | Should -Be @('9f procurement hp', 'lab printer', 'office hp')
        $r.ContainsKey('length') | Should -BeFalse
    }
    It 'handles a missing map' {
        (Get-SpoolfreeTakeoverPrinters -RemovedMap $null -Removed @{}).Count | Should -Be 0
    }
}
