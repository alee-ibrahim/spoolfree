#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0' }
# The report hashtable in Invoke-SpoolfreeSync.ps1, evaluated as written. Windows PowerShell 5.1 throws
# "Argument types do not match" for @($genericList) inside an [ordered]@{} literal that also holds a $(try {} catch {})
# subexpression; 0.4.6 lost every report to that. Run: Invoke-Pester -Path agent/tests

BeforeAll {
    $path = Join-Path $PSScriptRoot '..\Invoke-SpoolfreeSync.ps1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    $assign = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$report'
        }, $true) | Select-Object -First 1
    $script:ReportExpr = $assign.Right.Extent.Text
}

Describe 'Sync report literal' {
    It 'is found in the sync script' {
        $script:ReportExpr | Should -Match 'agentVersion'
    }
    It 'builds with every list populated (no PowerShell 5.1 argument type errors)' {
        function Get-SpoolfreeAgentVersion { '0.0.0' }
        function Get-SpoolfreeUpdateReport { [ordered]@{ state = 'current' } }
        $os = $null
        $manifest = [pscustomobject]@{ serial = 's1'; defaultPrinter = 'A' }
        $applied = @('A')
        $errors = New-Object System.Collections.Generic.List[string]; $errors.Add('e')
        $added = New-Object System.Collections.Generic.List[string]; $added.Add('A')
        $removed = New-Object System.Collections.Generic.List[string]
        $legacy = New-Object System.Collections.Generic.List[object]; $legacy.Add([pscustomobject]@{ printer = 'A'; queue = 'Q' })
        $critical = New-Object System.Collections.Generic.List[string]; $critical.Add('PC left without printer A')
        $fallbacks = New-Object System.Collections.Generic.List[object]; $fallbacks.Add([ordered]@{ printer = 'A'; method = 'TcpIpPort'; reason = 'r' })
        $sides = [ordered]@{ A = 'auto' }
        $method = 'IppURL'
        $started = Get-Date
        $r = Invoke-Expression $script:ReportExpr
        @($r.critical) | Should -Be @('PC left without printer A')
        @($r.fallbacks)[0].method | Should -Be 'TcpIpPort'
        @($r.errors) | Should -Be @('e')
        ($r | ConvertTo-Json -Depth 5) | Should -Match '"critical"'
    }
    It 'builds with every list empty' {
        function Get-SpoolfreeAgentVersion { '0.0.0' }
        function Get-SpoolfreeUpdateReport { throw 'no state' }
        $os = $null
        $manifest = [pscustomobject]@{ serial = 's1'; defaultPrinter = $null }
        $applied = @()
        $errors = New-Object System.Collections.Generic.List[string]
        $added = New-Object System.Collections.Generic.List[string]
        $removed = New-Object System.Collections.Generic.List[string]
        $legacy = New-Object System.Collections.Generic.List[object]
        $critical = New-Object System.Collections.Generic.List[string]
        $fallbacks = New-Object System.Collections.Generic.List[object]
        $sides = [ordered]@{}
        $method = 'IppURL'
        $started = Get-Date
        $r = Invoke-Expression $script:ReportExpr
        $r.update.state | Should -Be 'current'
        @($r.critical).Count | Should -Be 0
    }
}
