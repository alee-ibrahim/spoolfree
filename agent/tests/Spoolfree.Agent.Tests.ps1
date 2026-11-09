#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Run: Invoke-Pester -Path agent/tests   (Windows PowerShell 5.1 or PowerShell 7)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:fixture = Get-Content (Join-Path $PSScriptRoot 'fixtures\signed-manifest.json') -Raw | ConvertFrom-Json
    $script:guid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    function HexBytes([string]$hex) {
        if (-not $hex) { return , ([byte[]]@()) }
        return , [byte[]]($hex -split '(..)' -ne '' | ForEach-Object { [Convert]::ToByte($_, 16) })
    }
    function B64([string]$hex) { [Convert]::ToBase64String((HexBytes $hex)) }
}

Describe 'Ed25519 verification' {
    It 'accepts RFC 8032 test vector 1 (empty message)' {
        $pk = B64 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
        $sig = B64 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
        Test-SpoolfreeSignature -PublicKey $pk -Message ([byte[]]@()) -Signature $sig | Should -BeTrue
    }
    It 'accepts RFC 8032 test vector 2 (one byte)' {
        $pk = B64 '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
        $sig = B64 '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
        Test-SpoolfreeSignature -PublicKey $pk -Message ([byte[]]@(0x72)) -Signature $sig | Should -BeTrue
    }
    It 'rejects a modified message' {
        $pk = B64 '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
        $sig = B64 '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
        Test-SpoolfreeSignature -PublicKey $pk -Message ([byte[]]@(0x73)) -Signature $sig | Should -BeFalse
    }
    It 'rejects garbage keys and signatures without throwing' {
        Test-SpoolfreeSignature -PublicKey 'not base64!' -Message ([byte[]]@(1)) -Signature 'AAAA' | Should -BeFalse
        Test-SpoolfreeSignature -PublicKey (B64 ('00' * 32)) -Message ([byte[]]@(1)) -Signature (B64 ('00' * 64)) | Should -BeFalse
    }
    It 'verifies a manifest signed by the Node.js server code' {
        $bytes = [Convert]::FromBase64String($fixture.valid.payload)
        Test-SpoolfreeSignature -PublicKey $fixture.publicKey -Message $bytes -Signature $fixture.valid.signature | Should -BeTrue
    }
}

Describe 'ConvertFrom-SpoolfreeManifest' {
    It 'returns the payload for a valid, unexpired manifest for this computer' {
        $m = ConvertFrom-SpoolfreeManifest -Envelope $fixture.valid -PublicKey $fixture.publicKey -ObjectGuid $guid.ToUpper()
        $m.printers.Count | Should -Be 2
        $m.defaultPrinter | Should -Be 'Staff Copier'
        $m.printers[1].name | Should -Be ("Lab Colour {0} {1}n{2}code" -f [char]0x2013, [char]0xDC, [char]0xEF)
    }
    It 'rejects a manifest for another computer' {
        { ConvertFrom-SpoolfreeManifest -Envelope $fixture.valid -PublicKey $fixture.publicKey -ObjectGuid ([guid]::NewGuid().ToString()) } |
            Should -Throw '*different computer*'
    }
    It 'rejects an expired manifest (replay)' {
        { ConvertFrom-SpoolfreeManifest -Envelope $fixture.expired -PublicKey $fixture.publicKey -ObjectGuid $guid } | Should -Throw '*expired*'
    }
    It 'rejects a tampered payload' {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fixture.valid.payload)).Replace('192.0.2.10', '192.0.2.66')
        $env = [pscustomobject]@{ payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)); signature = $fixture.valid.signature; alg = 'Ed25519' }
        { ConvertFrom-SpoolfreeManifest -Envelope $env -PublicKey $fixture.publicKey -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
    }
    It 'rejects a manifest signed by a different key' {
        $other = B64 '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
        { ConvertFrom-SpoolfreeManifest -Envelope $fixture.valid -PublicKey $other -ObjectGuid $guid } | Should -Throw '*signature is invalid*'
    }
}

Describe 'Get-SpoolfreePlan' {
    BeforeAll {
        function P($name, $rev = 1, $url = "http://192.0.2.1:631/ipp/print") { [pscustomobject]@{ id = $name; name = $name; revision = $rev; ippUrl = $url } }
        function I($name, $rev = 1, $url = "http://192.0.2.1:631/ipp/print") { [pscustomobject]@{ Name = $name; Id = $name; Revision = $rev; Url = $url } }
    }
    It 'adds new printers and keeps unchanged ones' {
        $plan = Get-SpoolfreePlan -Desired @((P 'A'), (P 'B')) -Installed @((I 'A')) -Existing @('A', 'Microsoft Print to PDF')
        ($plan | Where-Object Name -eq 'A').Action | Should -Be 'Keep'
        ($plan | Where-Object Name -eq 'B').Action | Should -Be 'Add'
    }
    It 'replaces a queue when the revision or URL changes (Replace flow)' {
        $plan = Get-SpoolfreePlan -Desired @((P 'A' 2), (P 'B' 1 'http://192.0.2.9:631/ipp/print')) -Installed @((I 'A' 1), (I 'B' 1)) -Existing @('A', 'B')
        @($plan | Where-Object Action -eq 'Replace').Count | Should -Be 2
    }
    It 're-creates a managed queue that a user deleted' {
        $plan = Get-SpoolfreePlan -Desired @((P 'A')) -Installed @((I 'A')) -Existing @()
        $plan[0].Action | Should -Be 'Replace'
    }
    It 'removes only printers it installed' {
        $plan = Get-SpoolfreePlan -Desired @() -Installed @((I 'Old')) -Existing @('Old', 'Someone Elses Printer')
        @($plan).Count | Should -Be 1
        $plan[0].Action | Should -Be 'Remove'
        $plan[0].Name | Should -Be 'Old'
    }
    It 'never takes over an existing queue it did not create' {
        $plan = Get-SpoolfreePlan -Desired @((P 'Finance')) -Installed @() -Existing @('finance')
        $plan[0].Action | Should -Be 'Conflict'
    }
    It 'adds a SetDefault step when the manifest names a default' {
        $plan = Get-SpoolfreePlan -Desired @((P 'A')) -Installed @() -DefaultPrinter 'A'
        $plan[-1].Action | Should -Be 'SetDefault'
    }
    It 'removes the old queue before adding the renamed one (one IPP queue per device)' {
        $plan = Get-SpoolfreePlan -Desired @((P 'Copier 2')) -Installed @((I 'Copier')) -Existing @('Copier')
        @($plan.Action) | Should -Be @('Remove', 'Add')
        $plan[0].Name | Should -Be 'Copier'
        $plan[1].Name | Should -Be 'Copier 2'
    }
}

Describe 'Get-SpoolfreeQueueUpdate' {
    BeforeAll {
        $script:p = [pscustomobject]@{ id = 'x'; name = 'A'; revision = 1; location = 'Block B' }
    }
    It 'updates the location of a kept queue when it changed in the manifest' {
        $u = Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Managed by Spoolfree [x rev 1]'; Location = 'Block A' })
        $u['Location'] | Should -Be 'Block B'
    }
    It 'clears the location when the manifest has none' {
        $none = [pscustomobject]@{ id = 'x'; name = 'A'; revision = 1; location = $null }
        $u = Get-SpoolfreeQueueUpdate -Printer $none -Queue ([pscustomobject]@{ Comment = 'Managed by Spoolfree [x rev 1]'; Location = 'Old' })
        $u['Location'] | Should -Be ''
    }
    It 'returns nothing when the queue already matches' {
        $u = Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Managed by Spoolfree [x rev 1]'; Location = 'Block B' })
        $u.Count | Should -Be 0
    }
    It 'leaves a queue alone once its Spoolfree comment was changed' {
        $u = Get-SpoolfreeQueueUpdate -Printer $p -Queue ([pscustomobject]@{ Comment = 'Installed by hand'; Location = 'Block A' })
        $u.Count | Should -Be 0
    }
}

Describe 'Install method selection' {
    It 'prefers Add-Printer -IppURL whenever available' {
        Get-SpoolfreeInstallMethod -IppUrlSupported $true -ProtectedPrintMode $true | Should -Be 'IppURL'
        Get-SpoolfreeInstallMethod -IppUrlSupported $true -ProtectedPrintMode $false | Should -Be 'IppURL'
    }
    It 'has no driverless method without -IppURL (never the class driver on a RAW port, 0.7.7)' {
        Get-SpoolfreeInstallMethod -IppUrlSupported $false -ProtectedPrintMode $false | Should -Be 'Unsupported'
        Get-SpoolfreeInstallMethod -IppUrlSupported $false -ProtectedPrintMode $true | Should -Be 'Unsupported'
    }
}

Describe 'Install-SpoolfreePrinter (mocked print cmdlets)' {
    BeforeAll {
        $printer = [pscustomobject]@{ id = 'p1'; name = 'Staff Copier'; ippUrl = 'http://192.0.2.10:631/ipp/print'; host = '192.0.2.10'; location = 'Room 1'; revision = 3 }
    }
    It 'creates an IPP queue, renames it to the logical name and tags it' {
        $script:queues = @('Microsoft Print to PDF')
        Mock -ModuleName Spoolfree.Agent Get-Printer {
            param($Name)
            if ($Name) { if ($script:queues -contains $Name) { [pscustomobject]@{ Name = $Name; PortName = 'IPP_1' } } }
            else { $script:queues | ForEach-Object { [pscustomobject]@{ Name = $_; PortName = 'x' } } }
        }
        Mock -ModuleName Spoolfree.Agent Add-Printer { $script:queues += 'Brother MFC (IPP)' }
        Mock -ModuleName Spoolfree.Agent -RemoveParameterType InputObject Rename-Printer { $script:queues = @($script:queues | Where-Object { $_ -ne 'Brother MFC (IPP)' }) + 'Staff Copier' }
        Mock -ModuleName Spoolfree.Agent Set-Printer {}
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeMarker {}

        Install-SpoolfreePrinter -Printer $printer -Method IppURL

        Should -Invoke -ModuleName Spoolfree.Agent Add-Printer -Times 1 -ParameterFilter { $IppURL -eq 'http://192.0.2.10:631/ipp/print' }
        Should -Invoke -ModuleName Spoolfree.Agent Rename-Printer -Times 1 -ParameterFilter { $NewName -eq 'Staff Copier' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-Printer -Times 1 -ParameterFilter { $Comment -like 'Managed by Spoolfree*p1 rev 3*' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarker -Times 1 -ParameterFilter { $Method -eq 'IppURL' }
    }
    It 'uses a Standard TCP/IP port only with a real driver (the replaced queue''s)' {
        Mock -ModuleName Spoolfree.Agent Get-PrinterPort {}
        Mock -ModuleName Spoolfree.Agent Add-PrinterPort {}
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { [pscustomobject]@{ Name = 'Brother HL-2250DN series' } }
        Mock -ModuleName Spoolfree.Agent Add-Printer {}
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeMarker {}

        Install-SpoolfreePrinter -Printer $printer -Method TcpIpPort -DriverName 'Brother HL-2250DN series'

        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterPort -Times 1 -ParameterFilter { $Name -eq 'SPOOLFREE_192.0.2.10' -and $PrinterHostAddress -eq '192.0.2.10' }
        Should -Invoke -ModuleName Spoolfree.Agent Add-Printer -Times 1 -ParameterFilter { $DriverName -eq 'Brother HL-2250DN series' -and $PortName -eq 'SPOOLFREE_192.0.2.10' }
    }
    It 'never puts the IPP Class Driver on a RAW port (it printed raster as text on PCL printers)' {
        Mock -ModuleName Spoolfree.Agent Add-PrinterPort {}
        Mock -ModuleName Spoolfree.Agent Add-Printer {}
        { Install-SpoolfreePrinter -Printer $printer -Method TcpIpPort } | Should -Throw '*never used on a RAW port*'
        { Install-SpoolfreePrinter -Printer $printer -Method TcpIpPort -DriverName 'Microsoft IPP Class Driver' } | Should -Throw '*never used on a RAW port*'
        Should -Invoke -ModuleName Spoolfree.Agent Add-Printer -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterPort -Times 0
    }
    It 'finds the old fallback queues (IPP Class Driver on a TCP/IP port) to re-create' {
        Test-SpoolfreeClassOnRawQueue -Method 'TcpIpPort' -DriverName 'Microsoft IPP Class Driver' | Should -BeTrue
        Test-SpoolfreeClassOnRawQueue -Method 'TcpIpPort' -DriverName 'Brother HL-2250DN series' | Should -BeFalse
        Test-SpoolfreeClassOnRawQueue -Method 'IppURL' -DriverName 'Microsoft IPP Class Driver' | Should -BeFalse
    }
    It 'retries a failed re-creation only after 24 hours' {
        $now = [datetime]'2026-11-09T12:00:00Z'
        Test-SpoolfreeMigrateDue -LastTried '' -Now $now | Should -BeTrue
        Test-SpoolfreeMigrateDue -LastTried '2026-11-09T01:00:00.0000000Z' -Now $now.ToUniversalTime() | Should -BeFalse
        Test-SpoolfreeMigrateDue -LastTried '2026-11-08T11:00:00.0000000Z' -Now $now.ToUniversalTime() | Should -BeTrue
        Test-SpoolfreeMigrateDue -LastTried 'garbage' -Now $now | Should -BeTrue
    }
}

Describe 'Automatic duplex on vendor queues (0.7.7)' {
    BeforeAll {
        $script:Caps = '<psf:PrintCapabilities xmlns:psf="http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework" xmlns:psk="http://schemas.microsoft.com/windows/2003/08/printing/printschemakeywords" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><psf:Feature name="psk:JobDuplexAllDocumentsContiguously"><psf:Property name="psf:SelectionType"><psf:Value xsi:type="xsd:QName">psk:PickOne</psf:Value></psf:Property><psf:Option name="psk:OneSided" constrained="psk:None"/><psf:Option name="psk:TwoSidedLongEdge" constrained="psk:None"><psf:ScoredProperty name="psk:DuplexMode"><psf:Value xsi:type="xsd:string">Automatic</psf:Value></psf:ScoredProperty></psf:Option><psf:Option name="psk:TwoSidedLongEdge" constrained="psk:None"><psf:ScoredProperty name="psk:DuplexMode"><psf:Value xsi:type="xsd:string">Manual</psf:Value></psf:ScoredProperty></psf:Option></psf:Feature></psf:PrintCapabilities>'
        $script:Ticket = '<psf:PrintTicket xmlns:psf="x" xmlns:psk="y"><psf:Feature name="psk:PageMediaSize"><psf:Option name="psk:ISOA4"/></psf:Feature><psf:Feature name="psk:JobDuplexAllDocumentsContiguously"><psf:Option name="psk:OneSided"/></psf:Feature></psf:PrintTicket>'
    }
    It 'selects the automatic two-sided option when the driver also offers manual duplex (Brother HL-5350DN)' {
        $t = Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml $script:Caps -TicketXml $script:Ticket
        $t | Should -Match '<psf:Option name="psk:TwoSidedLongEdge"><psf:ScoredProperty name="psk:DuplexMode"><psf:Value xsi:type="xsd:string">Automatic</psf:Value>'
        $t | Should -Match 'psk:ISOA4'
        $t | Should -Not -Match 'psk:OneSided'
    }
    It 'adds the feature when the ticket has none' {
        $t = Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml $script:Caps -TicketXml '<psf:PrintTicket xmlns:psf="x"></psf:PrintTicket>'
        $t | Should -Match 'JobDuplexAllDocumentsContiguously.*Automatic.*</psf:PrintTicket>$'
    }
    It 'does nothing for drivers without an automatic two-sided option' {
        Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml ($script:Caps -replace 'Automatic', 'Manual') -TicketXml $script:Ticket | Should -BeNullOrEmpty
        Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml '<psf:PrintCapabilities/>' -TicketXml $script:Ticket | Should -BeNullOrEmpty
        Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml '' -TicketXml $script:Ticket | Should -BeNullOrEmpty
    }
    It 'keeps the queue''s default duplex after storing automatic mode' {
        Mock -ModuleName Spoolfree.Agent Add-Type {}
        Mock -ModuleName Spoolfree.Agent New-Object { param($TypeName) if ($TypeName -eq 'System.Printing.LocalPrintServer') { $s = [pscustomobject]@{}; $s | Add-Member ScriptMethod GetPrintQueue { $q = [pscustomobject]@{}; $q | Add-Member ScriptMethod GetPrintCapabilitiesAsXml { New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($script:Caps)) }; $q }; $s | Add-Member ScriptMethod Dispose {}; $s } else { Microsoft.PowerShell.Utility\New-Object @args -TypeName $TypeName } }
        Mock -ModuleName Spoolfree.Agent Get-PrintConfiguration { [pscustomobject]@{ PrintTicketXML = $script:Ticket; DuplexingMode = 'OneSided' } }
        Mock -ModuleName Spoolfree.Agent Set-PrintConfiguration {}
        Enable-SpoolfreeAutoDuplex -Name 'Brother' | Should -Be 'automatic'
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrintConfiguration -Times 1 -Exactly -ParameterFilter { $PrintTicketXml -match 'Automatic' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-PrintConfiguration -Times 1 -Exactly -ParameterFilter { $DuplexingMode -eq 'OneSided' }
    }
    It 'refuses to delete a queue whose comment was changed' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeInstalled { @([pscustomobject]@{ Name = 'Staff Copier'; PortName = 'IPP_1' }) }
        Mock -ModuleName Spoolfree.Agent Get-Printer { [pscustomobject]@{ Name = 'Staff Copier'; Comment = 'Installed by hand' } }
        Mock -ModuleName Spoolfree.Agent -RemoveParameterType InputObject Remove-Printer {}
        { Uninstall-SpoolfreePrinter -Name 'Staff Copier' } | Should -Throw '*leaving it alone*'
        Should -Invoke -ModuleName Spoolfree.Agent Remove-Printer -Times 0
    }
}
