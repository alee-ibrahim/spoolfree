#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# Vendor driver mode (0.7): manifest parsing, queue targets, make-before-break planning, Windows Protected Print Mode,
# package verification (SHA-256, catalog named by the INF, Authenticode) and safe extraction. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\Spoolfree.Agent.psm1') -Force
    $script:Sha = ('ab' * 32)
    function script:VendorPrinter([string]$Protocol = 'raw9100', [string]$Sha = $script:Sha) {
        [pscustomobject]@{
            id = 'p1'; name = 'Bureau'; revision = 1; host = '192.0.2.12'; ippUrl = 'http://192.0.2.12:631/ipp/print'; location = ''
            driverMode = 'vendor'
            driver = [pscustomobject]@{
                mode = 'vendor'; packageId = '11111111-1111-4111-8111-111111111111'; packageName = 'Brother HL-3150CDN'
                sha256 = $Sha; size = 100; url = '/api/agent/drivers/11111111-1111-4111-8111-111111111111'
                driverName = 'Brother HL-3150CDN series'; inf = 'BROCH12A.INF'; catalog = 'BROCH12A.CAT'; protocol = $Protocol; lprQueue = 'BINARY_P1'
            }
        }
    }
    function script:DriverlessPrinter { [pscustomobject]@{ id = 'p1'; name = 'Bureau'; revision = 1; host = '192.0.2.12'; ippUrl = 'http://192.0.2.12:631/ipp/print'; driverMode = 'driverless' } }
    function script:Marker([string]$Url) { [pscustomobject]@{ Name = 'Bureau'; Id = 'p1'; Revision = 1; Url = $Url } }
}

Describe 'Get-SpoolfreeVendorDriver' {
    It 'reads a valid vendor entry' {
        $v = Get-SpoolfreeVendorDriver (VendorPrinter 'lpr')
        $v.DriverName | Should -Be 'Brother HL-3150CDN series'
        $v.Protocol | Should -Be 'lpr'
        $v.LprQueue | Should -Be 'BINARY_P1'
        $v.Size | Should -Be 100
    }
    It 'returns $null for driverless printers, older manifests and invalid entries' {
        Get-SpoolfreeVendorDriver (DriverlessPrinter) | Should -BeNullOrEmpty
        Get-SpoolfreeVendorDriver ([pscustomobject]@{ name = 'Old'; ippUrl = 'http://x' }) | Should -BeNullOrEmpty
        Get-SpoolfreeVendorDriver (VendorPrinter -Sha 'nothex') | Should -BeNullOrEmpty
        Get-SpoolfreeVendorDriver (VendorPrinter 'smb') | Should -BeNullOrEmpty
        $p = VendorPrinter; $p.driver.inf = '..\..\Windows\evil.inf'
        Get-SpoolfreeVendorDriver $p | Should -BeNullOrEmpty
        $p = VendorPrinter; $p.driver.url = 'https://elsewhere.example/x.zip'
        Get-SpoolfreeVendorDriver $p | Should -BeNullOrEmpty
    }
}

Describe 'Test-SpoolfreeZipEntryPath' {
    It 'accepts relative paths and refuses escapes' {
        foreach ($ok in 'a.inf', 'amd64/x.dll', 'dir/') { Test-SpoolfreeZipEntryPath $ok | Should -BeTrue }
        foreach ($bad in '../x', '/x', 'C:/x', 'a\..\b', 'a//b', '') { Test-SpoolfreeZipEntryPath $bad | Should -BeFalse }
    }
}

Describe 'Get-SpoolfreeQueueTarget and ports' {
    It 'is the IPP URL for driverless printers (unchanged from 0.6) and for vendor printers under WPP' {
        Get-SpoolfreeQueueTarget (DriverlessPrinter) | Should -Be 'http://192.0.2.12:631/ipp/print'
        Get-SpoolfreeQueueTarget (VendorPrinter) -VendorAllowed $false | Should -Be 'http://192.0.2.12:631/ipp/print'
    }
    It 'names protocol, address, driver and package for vendor printers' {
        Get-SpoolfreeQueueTarget (VendorPrinter) | Should -Be "vendor:raw9100|192.0.2.12:9100|Brother HL-3150CDN series|$($script:Sha)"
        Get-SpoolfreeQueueTarget (VendorPrinter 'lpr') | Should -Be "vendor:lpr|192.0.2.12/BINARY_P1|Brother HL-3150CDN series|$($script:Sha)"
        Test-SpoolfreeVendorTarget (Get-SpoolfreeQueueTarget (VendorPrinter)) | Should -BeTrue
        Test-SpoolfreeVendorTarget 'http://192.0.2.12:631/ipp/print' | Should -BeFalse
    }
    It 'uses SPOOLFREE_ ports for RAW and LPR and the IPP URL for ipp' {
        $p = VendorPrinter
        Get-SpoolfreeVendorPortName -Printer $p -Vendor (Get-SpoolfreeVendorDriver $p) | Should -Be 'SPOOLFREE_192.0.2.12'
        $p = VendorPrinter 'lpr'
        Get-SpoolfreeVendorPortName -Printer $p -Vendor (Get-SpoolfreeVendorDriver $p) | Should -Be 'SPOOLFREE_LPR_192.0.2.12_BINARY_P1'
        $p = VendorPrinter 'ipp'
        Get-SpoolfreeVendorPortName -Printer $p -Vendor (Get-SpoolfreeVendorDriver $p) | Should -Be 'http://192.0.2.12:631/ipp/print'
    }
}

Describe 'Get-SpoolfreePlan with vendor drivers' {
    It 'switches driverless -> vendor with make-before-break' {
        $plan = Get-SpoolfreePlan -Desired @((VendorPrinter)) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @('Bureau')
        $plan[0].Action | Should -Be 'Replace'
        $plan[0].MakeBeforeBreak | Should -BeTrue
    }
    It 'switches vendor -> driverless with make-before-break' {
        $plan = Get-SpoolfreePlan -Desired @((DriverlessPrinter)) -Installed @((Marker "vendor:raw9100|192.0.2.12:9100|Brother HL-3150CDN series|$($script:Sha)")) -Existing @('Bureau')
        $plan[0].Action | Should -Be 'Replace'
        $plan[0].MakeBeforeBreak | Should -BeTrue
    }
    It 'keeps a vendor queue whose target is unchanged, and re-creates it for a new package' {
        $target = Get-SpoolfreeQueueTarget (VendorPrinter)
        (Get-SpoolfreePlan -Desired @((VendorPrinter)) -Installed @((Marker $target)) -Existing @('Bureau'))[0].Action | Should -Be 'Keep'
        (Get-SpoolfreePlan -Desired @((VendorPrinter -Sha ('cd' * 32))) -Installed @((Marker $target)) -Existing @('Bureau'))[0].Action | Should -Be 'Replace'
    }
    It 'plans vendor printers as driverless under WPP (no churn for an existing driverless queue)' {
        (Get-SpoolfreePlan -Desired @((VendorPrinter)) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @('Bureau') -VendorAllowed $false)[0].Action | Should -Be 'Keep'
    }
    It 'needs no make-before-break for a missing queue or a driverless endpoint change' {
        $p = (Get-SpoolfreePlan -Desired @((VendorPrinter)) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @())[0]
        $p.Action | Should -Be 'Replace'
        $p.MakeBeforeBreak | Should -BeFalse
        $d = DriverlessPrinter; $d.ippUrl = 'http://192.0.2.99:631/ipp/print'
        (Get-SpoolfreePlan -Desired @($d) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @('Bureau'))[0].MakeBeforeBreak | Should -BeFalse
    }
    It 're-creates an old-fallback queue (IPP Class Driver on a RAW port) with make-before-break (0.7.7)' {
        $p = (Get-SpoolfreePlan -Desired @((DriverlessPrinter)) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @('Bureau') -Migrate @('bureau'))[0]
        $p.Action | Should -Be 'Replace'
        $p.MakeBeforeBreak | Should -BeTrue
        (Get-SpoolfreePlan -Desired @((DriverlessPrinter)) -Installed @((Marker 'http://192.0.2.12:631/ipp/print')) -Existing @('Bureau') -Migrate @('Other'))[0].Action | Should -Be 'Keep'
    }
}

Describe 'Get-SpoolfreeInfCatalog' {
    It 'reads CatalogFile from [Version], preferring NTamd64' {
        Get-SpoolfreeInfCatalog "[Version]`r`nClass=Printer`r`nCatalogFile=BROCH12A.CAT ; signed`r`n[Strings]`r`nCatalogFile=nope.cat" | Should -Be 'BROCH12A.CAT'
        Get-SpoolfreeInfCatalog "[Version]`nCatalogFile=x86.cat`nCatalogFile.NTamd64=`"x64.cat`"" | Should -Be 'x64.cat'
        Get-SpoolfreeInfCatalog "[Version]`nClass=Printer" | Should -BeNullOrEmpty
    }
}

Describe 'Expand-SpoolfreeZip' {
    BeforeAll {
        Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
        function script:NewZip([string]$Path, [string[]]$Names) {
            $fs = [IO.File]::Create($Path)
            $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
            foreach ($n in $Names) { $w = New-Object IO.StreamWriter($zip.CreateEntry($n).Open()); $w.Write("x"); $w.Dispose() }
            $zip.Dispose(); $fs.Dispose()
        }
    }
    It 'extracts a normal package' {
        NewZip "$TestDrive\ok.zip" @('BROCH12A.INF', 'amd64/a.dl_')
        Expand-SpoolfreeZip -Path "$TestDrive\ok.zip" -Destination "$TestDrive\ok"
        Test-Path "$TestDrive\ok\amd64\a.dl_" | Should -BeTrue
    }
    It 'refuses entries that leave the destination' {
        NewZip "$TestDrive\evil.zip" @('ok.inf', '../evil.txt')
        { Expand-SpoolfreeZip -Path "$TestDrive\evil.zip" -Destination "$TestDrive\evil" } | Should -Throw '*Unsafe path*'
        Test-Path "$TestDrive\evil.txt" | Should -BeFalse
    }
}

Describe 'Install-SpoolfreeVendorDriver' {
    BeforeAll {
        Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
        $script:Zip = "$TestDrive\pkg.zip"
        $fs = [IO.File]::Create($script:Zip)
        $z = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
        $w = New-Object IO.StreamWriter($z.CreateEntry('BROCH12A.INF').Open()); $w.Write("[Version]`r`nClass=Printer`r`nCatalogFile=BROCH12A.CAT`r`n"); $w.Dispose()
        $w = New-Object IO.StreamWriter($z.CreateEntry('BROCH12A.CAT').Open()); $w.Write('catalog'); $w.Dispose()
        $z.Dispose(); $fs.Dispose()
        $script:ZipSha = (Get-FileHash -Algorithm SHA256 $script:Zip).Hash.ToLowerInvariant()
        $script:ZipLen = (Get-Item $script:Zip).Length
    }
    BeforeEach {
        $script:V = [pscustomobject]@{
            PackageId = '1'; PackageName = 'Brother HL-3150CDN'; Sha256 = $script:ZipSha; Size = $script:ZipLen; Url = '/api/agent/drivers/x'
            DriverName = 'Brother HL-3150CDN series'; Inf = 'BROCH12A.INF'; Catalog = 'BROCH12A.CAT'; Protocol = 'raw9100'; LprQueue = 'lp'
        }
        $n = 0
        Mock -ModuleName Spoolfree.Agent New-SpoolfreeSystemDirectory { New-Item -ItemType Directory -Path "$TestDrive\stage$((Get-Random))" -Force | Select-Object -ExpandProperty FullName }
        Mock -ModuleName Spoolfree.Agent Save-SpoolfreeDownload { Copy-Item $script:Zip $Path }
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeDriverState { $null }
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeDriverState { }
        Mock -ModuleName Spoolfree.Agent Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; StatusMessage = 'ok'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Windows Hardware Compatibility Publisher' } } }
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreePnpUtil { [pscustomobject]@{ Code = 0; Output = 'Driver package added successfully.' } }
        Mock -ModuleName Spoolfree.Agent Add-PrinterDriver { }
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { $null }
    }
    It 'verifies hash and signature, stages with pnputil and adds the driver' {
        Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://spoolfree.example.org/' -Token 't' | Should -Be 'installed'
        Should -Invoke -ModuleName Spoolfree.Agent Save-SpoolfreeDownload -Times 1 -ParameterFilter { $Uri -eq 'https://spoolfree.example.org/api/agent/drivers/x' }
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreePnpUtil -Times 1 -ParameterFilter { $Inf -like '*\BROCH12A.INF' }
        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterDriver -Times 1 -ParameterFilter { $Name -eq 'Brother HL-3150CDN series' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeDriverState -Times 1
    }
    It 'refuses a package whose SHA-256 differs from the signed manifest' {
        $script:V.Sha256 = ('00' * 32)
        { Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://s' -Token 't' } | Should -Throw '*does not match the signed manifest*'
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreePnpUtil -Times 0
    }
    It 'refuses a catalog whose Authenticode signature is not Valid' {
        Mock -ModuleName Spoolfree.Agent Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'NotSigned'; StatusMessage = 'not signed'; SignerCertificate = $null } }
        { Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://s' -Token 't' } | Should -Throw '*signature is NotSigned*'
        Should -Invoke -ModuleName Spoolfree.Agent Invoke-SpoolfreePnpUtil -Times 0
        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterDriver -Times 0
    }
    It 'refuses a catalog the INF does not name' {
        $script:V.Catalog = 'BROCH12A.INF'
        { Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://s' -Token 't' } | Should -Throw '*does not name the catalog*'
    }
    It 'reports pnputil failures' {
        Mock -ModuleName Spoolfree.Agent Invoke-SpoolfreePnpUtil { [pscustomobject]@{ Code = 5; Output = 'Access is denied.' } }
        { Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://s' -Token 't' } | Should -Throw '*pnputil /add-driver failed (exit 5)*'
    }
    It 'skips the download when this package''s driver is already installed' {
        Mock -ModuleName Spoolfree.Agent Get-SpoolfreeDriverState { [pscustomobject]@{ DriverNames = @('Brother HL-3150CDN series') } }
        Mock -ModuleName Spoolfree.Agent Get-PrinterDriver { [pscustomobject]@{ Name = 'Brother HL-3150CDN series' } }
        Install-SpoolfreeVendorDriver -Vendor $script:V -BaseUrl 'https://s' -Token 't' | Should -Be 'present'
        Should -Invoke -ModuleName Spoolfree.Agent Save-SpoolfreeDownload -Times 0
    }
}

Describe 'Install-SpoolfreePrinter -Method Vendor' {
    BeforeEach {
        Mock -ModuleName Spoolfree.Agent Get-PrinterPort { $null }
        Mock -ModuleName Spoolfree.Agent Add-PrinterPort { }
        Mock -ModuleName Spoolfree.Agent Add-Printer { }
        Mock -ModuleName Spoolfree.Agent Set-SpoolfreeMarker { }
    }
    It 'creates a RAW 9100 port and the queue with the vendor driver, and records the vendor target' {
        Install-SpoolfreePrinter -Printer (VendorPrinter) -Method 'Vendor' -ServerId 'abcd'
        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterPort -Times 1 -ParameterFilter { $Name -eq 'SPOOLFREE_192.0.2.12' -and $PrinterHostAddress -eq '192.0.2.12' -and $PortNumber -eq 9100 }
        Should -Invoke -ModuleName Spoolfree.Agent Add-Printer -Times 1 -ParameterFilter { $Name -eq 'Bureau' -and $DriverName -eq 'Brother HL-3150CDN series' -and $PortName -eq 'SPOOLFREE_192.0.2.12' -and $Comment -like 'Managed by Spoolfree `[p1 rev 1 server abcd`]' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarker -Times 1 -ParameterFilter { $Method -eq 'Vendor' -and $Target -like 'vendor:raw9100|*' }
    }
    It 'creates an LPR port' {
        Install-SpoolfreePrinter -Printer (VendorPrinter 'lpr') -Method 'Vendor' -ServerId 'abcd'
        Should -Invoke -ModuleName Spoolfree.Agent Add-PrinterPort -Times 1 -ParameterFilter { $LprHostAddress -eq '192.0.2.12' -and $LprQueueName -eq 'BINARY_P1' }
    }
    It 'leaves the marker to the caller under a temporary name (make-before-break)' {
        Install-SpoolfreePrinter -Printer (VendorPrinter) -Method 'Vendor' -ServerId 'abcd' -QueueName 'Bureau (Spoolfree)'
        Should -Invoke -ModuleName Spoolfree.Agent Add-Printer -Times 1 -ParameterFilter { $Name -eq 'Bureau (Spoolfree)' }
        Should -Invoke -ModuleName Spoolfree.Agent Set-SpoolfreeMarker -Times 0
    }
}

Describe 'Get-SpoolfreeDriverState / Set-SpoolfreeDriverState' {
    BeforeAll {
        # A registry stand-in under TestDrive (the real key is HKLM:\SOFTWARE\Spoolfree\Drivers).
        $script:Reg = "TestDrive:\drivers"
        New-Item -ItemType Directory -Path $script:Reg -Force | Out-Null
    }
    It 'reads a key without values (interrupted install) as no driver names, under StrictMode' {
        InModuleScope Spoolfree.Agent -Parameters @{ Reg = $script:Reg } {
            param($Reg)
            Mock Test-Path { $true } -ParameterFilter { $Path -like '*Drivers*' }
            Mock Get-ItemProperty { [pscustomobject]@{ PSPath = 'x'; PSChildName = 'ab' } }
            $s = Get-SpoolfreeDriverState -Sha256 ('ab' * 32)
            @($s.DriverNames).Count | Should -Be 0
            $s.Signer | Should -Be ''
        }
    }
    It 'records the driver name when the key is new or empty' {
        InModuleScope Spoolfree.Agent {
            $script:written = @{}
            Mock Get-SpoolfreeDriverState { [pscustomobject]@{ DriverNames = @(); InstalledAt = ''; Signer = '' } }
            Mock Test-Path { $true }
            Mock New-Item { }
            Mock New-ItemProperty { $script:written[$Name] = $Value }
            Set-SpoolfreeDriverState -Sha256 ('ab' * 32) -DriverName 'Brother HL-3150CDN series' -Signer 'CN=x' -Package 'p'
            @($script:written['DriverNames']) | Should -Be @('Brother HL-3150CDN series')
            Mock Get-SpoolfreeDriverState { $null }
            Set-SpoolfreeDriverState -Sha256 ('ab' * 32) -DriverName 'B' -Signer 'CN=x' -Package 'p'
            @($script:written['DriverNames']) | Should -Be @('B')
            Mock Get-SpoolfreeDriverState { [pscustomobject]@{ DriverNames = @('A'); InstalledAt = ''; Signer = '' } }
            Set-SpoolfreeDriverState -Sha256 ('ab' * 32) -DriverName 'B' -Signer 'CN=x' -Package 'p'
            @($script:written['DriverNames']) | Should -Be @('A', 'B')
        }
    }
}
