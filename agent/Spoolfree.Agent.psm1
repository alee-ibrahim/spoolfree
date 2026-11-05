#Requires -Version 5.1
<#
.SYNOPSIS
    Spoolfree agent library: signature verification, manifest validation,
    reconciliation planning and printer install/remove helpers.

.NOTES
    Windows PowerShell 5.1 compatible. Pure functions (no side effects) are
    covered by Pester tests in agent/tests.
#>

Set-StrictMode -Version 2.0

$script:AgentVersion = '0.1.0'
$script:RegistryRoot = 'HKLM:\SOFTWARE\Spoolfree'
$script:PrinterRegistry = 'HKLM:\SOFTWARE\Spoolfree\Printers'
$script:CommentPrefix = 'Managed by Spoolfree'
$script:IppDriver = 'Microsoft IPP Class Driver'

# ---------------------------------------------------------------------------
# Ed25519 verification (RFC 8032). .NET Framework has no Ed25519, and the
# agent must not depend on extra binaries, so a small verifier is compiled
# in-process. Verification only; no secrets are handled here.
# ---------------------------------------------------------------------------
$script:Ed25519Source = @'
using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Spoolfree
{
    public static class Ed25519
    {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        static readonly BigInteger D = Mod(-121665 * Inv(121666));
        static readonly BigInteger D2 = Mod(2 * D);
        static readonly BigInteger I = BigInteger.ModPow(2, (P - 1) / 4, P);
        static readonly BigInteger[] B = MakeBase();

        static BigInteger Mod(BigInteger a) { BigInteger r = a % P; return r.Sign < 0 ? r + P : r; }
        static BigInteger Inv(BigInteger a) { return BigInteger.ModPow(Mod(a), P - 2, P); }

        static BigInteger[] MakeBase()
        {
            BigInteger y = Mod(4 * Inv(5));
            BigInteger x = RecoverX(y, 0);
            return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
        }

        static BigInteger RecoverX(BigInteger y, int sign)
        {
            if (y >= P) throw new ArgumentException("y out of range");
            BigInteger xx = Mod((y * y - 1) * Inv(D * y * y + 1));
            if (xx.IsZero) { if (sign != 0) throw new ArgumentException("invalid point"); return BigInteger.Zero; }
            BigInteger x = BigInteger.ModPow(xx, (P + 3) / 8, P);
            if (!Mod(x * x - xx).IsZero) x = Mod(x * I);
            if (!Mod(x * x - xx).IsZero) throw new ArgumentException("invalid point");
            if ((int)(x % 2) != sign) x = P - x;
            return x;
        }

        // Extended coordinates (X, Y, Z, T), a = -1 twisted Edwards addition.
        static BigInteger[] Add(BigInteger[] p, BigInteger[] q)
        {
            BigInteger a = Mod((p[1] - p[0]) * (q[1] - q[0]));
            BigInteger b = Mod((p[1] + p[0]) * (q[1] + q[0]));
            BigInteger c = Mod(p[3] * D2 * q[3]);
            BigInteger d = Mod(p[2] * 2 * q[2]);
            BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
            return new BigInteger[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
        }

        static BigInteger[] Mul(BigInteger s, BigInteger[] p)
        {
            BigInteger[] q = new BigInteger[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            while (s > 0)
            {
                if (!s.IsEven) q = Add(q, p);
                p = Add(p, p);
                s >>= 1;
            }
            return q;
        }

        static BigInteger FromLE(byte[] b, int offset, int len)
        {
            byte[] tmp = new byte[len + 1];
            Array.Copy(b, offset, tmp, 0, len);
            return new BigInteger(tmp);
        }

        static BigInteger[] Decode(byte[] b, int offset)
        {
            byte[] copy = new byte[32];
            Array.Copy(b, offset, copy, 0, 32);
            int sign = (copy[31] >> 7) & 1;
            copy[31] &= 0x7f;
            BigInteger y = FromLE(copy, 0, 32);
            BigInteger x = RecoverX(y, sign);
            return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
        }

        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
        {
            if (publicKey == null || publicKey.Length != 32) return false;
            if (signature == null || signature.Length != 64) return false;
            if (message == null) message = new byte[0];
            BigInteger[] a, r;
            try { a = Decode(publicKey, 0); r = Decode(signature, 0); }
            catch (ArgumentException) { return false; }
            BigInteger s = FromLE(signature, 32, 32);
            if (s >= L) return false;

            byte[] h;
            using (SHA512 sha = SHA512.Create())
            {
                byte[] buf = new byte[64 + message.Length];
                Array.Copy(signature, 0, buf, 0, 32);
                Array.Copy(publicKey, 0, buf, 32, 32);
                Array.Copy(message, 0, buf, 64, message.Length);
                h = sha.ComputeHash(buf);
            }
            BigInteger k = FromLE(h, 0, 64) % L;

            BigInteger[] lhs = Mul(s, B);
            BigInteger[] rhs = Add(r, Mul(k, a));
            return Mod(lhs[0] * rhs[2] - rhs[0] * lhs[2]).IsZero
                && Mod(lhs[1] * rhs[2] - rhs[1] * lhs[2]).IsZero;
        }
    }
}
'@

function Initialize-SpoolfreeCrypto {
    if (-not ('Spoolfree.Ed25519' -as [type])) {
        Add-Type -TypeDefinition $script:Ed25519Source -ReferencedAssemblies 'System.Numerics' -Language CSharp
    }
}

function Test-SpoolfreeSignature {
    <# Verifies an Ed25519 signature. All inputs are base64 strings except -Message (bytes). #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Message,
        [Parameter(Mandatory)][string]$Signature
    )
    Initialize-SpoolfreeCrypto
    try {
        $pk = [Convert]::FromBase64String($PublicKey)
        $sig = [Convert]::FromBase64String($Signature)
    } catch {
        return $false
    }
    return [Spoolfree.Ed25519]::Verify($pk, $Message, $sig)
}

function ConvertFrom-SpoolfreeManifest {
    <#
    .SYNOPSIS
        Verifies a signed manifest envelope and returns the payload object.
        Throws if the signature, computer binding, schema or expiry is wrong.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Envelope,
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][string]$ObjectGuid,
        [datetime]$Now = [datetime]::UtcNow
    )
    if (-not $Envelope.payload -or -not $Envelope.signature) { throw 'Manifest envelope is missing payload or signature.' }
    if ($Envelope.alg -and $Envelope.alg -ne 'Ed25519') { throw "Unsupported manifest algorithm '$($Envelope.alg)'." }
    $bytes = [Convert]::FromBase64String([string]$Envelope.payload)
    if (-not (Test-SpoolfreeSignature -PublicKey $PublicKey -Message $bytes -Signature ([string]$Envelope.signature))) {
        throw 'Manifest signature is invalid. Refusing to apply it.'
    }
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    $m = $json | ConvertFrom-Json
    if ($m.schema -ne 1) { throw "Unsupported manifest schema '$($m.schema)'." }
    if (([string]$m.computer.objectGuid).ToLowerInvariant() -ne $ObjectGuid.ToLowerInvariant()) {
        throw 'Manifest was issued for a different computer.'
    }
    $expires = [datetime]::Parse([string]$m.expiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($expires -lt $Now) { throw "Manifest expired at $($m.expiresAt)." }
    return $m
}

function Get-SpoolfreePlan {
    <#
    .SYNOPSIS
        Pure reconciliation: compares desired printers (manifest) with the
        printers this agent installed earlier and returns actions.
    .PARAMETER Installed
        Objects with Name, Id, Revision, Url (from the agent's registry marker).
    .PARAMETER Existing
        Names of all print queues currently on the PC (any origin).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Desired,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Installed,
        [AllowEmptyCollection()][string[]]$Existing = @(),
        [AllowNull()][string]$DefaultPrinter
    )
    $actions = New-Object System.Collections.Generic.List[object]
    $installedByName = @{}
    foreach ($i in $Installed) { $installedByName[([string]$i.Name).ToLowerInvariant()] = $i }
    $existingSet = @{}
    foreach ($e in $Existing) { $existingSet[$e.ToLowerInvariant()] = $true }
    $desiredNames = @{}
    foreach ($d in $Desired) { $desiredNames[([string]$d.name).ToLowerInvariant()] = $true }

    # Removals come first. Windows allows only one IPP queue per device, so when a
    # printer is renamed (Remove old name + Add new name, same device) the Add fails
    # with "The specified printer already exists" unless the old queue is gone.
    foreach ($i in $Installed) {
        if (-not $desiredNames.ContainsKey(([string]$i.Name).ToLowerInvariant())) {
            $actions.Add([pscustomobject]@{ Action = 'Remove'; Name = $i.Name; Printer = $null })
        }
    }

    foreach ($d in $Desired) {
        $key = ([string]$d.name).ToLowerInvariant()
        $mine = $installedByName[$key]
        if ($null -eq $mine) {
            if ($existingSet.ContainsKey($key)) {
                # A queue with this name exists but we did not create it: never touch it.
                $actions.Add([pscustomobject]@{ Action = 'Conflict'; Name = $d.name; Printer = $d })
            } else {
                $actions.Add([pscustomobject]@{ Action = 'Add'; Name = $d.name; Printer = $d })
            }
        } elseif ([int]$mine.Revision -ne [int]$d.revision -or [string]$mine.Url -ne [string]$d.ippUrl -or -not $existingSet.ContainsKey($key)) {
            $actions.Add([pscustomobject]@{ Action = 'Replace'; Name = $d.name; Printer = $d })
        } else {
            $actions.Add([pscustomobject]@{ Action = 'Keep'; Name = $d.name; Printer = $d })
        }
    }
    if ($DefaultPrinter) {
        $actions.Add([pscustomobject]@{ Action = 'SetDefault'; Name = $DefaultPrinter; Printer = $null })
    }
    return , $actions.ToArray()
}

function Get-SpoolfreeComment {
    param([Parameter(Mandatory)]$Printer)
    return ('{0} [{1} rev {2}]' -f $script:CommentPrefix, $Printer.id, $Printer.revision)
}

function Get-SpoolfreeQueueUpdate {
    <#
    .SYNOPSIS
        Pure: Set-Printer parameters needed to bring a kept queue in line with the
        manifest. Edits that do not bump the revision (location) would otherwise
        never reach PCs. Returns an empty hashtable when nothing changed or when the
        queue no longer carries the Spoolfree comment (someone else owns it now).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)]$Queue)
    $update = @{}
    if (-not ([string]$Queue.Comment).StartsWith($script:CommentPrefix)) { return $update }
    $wantLocation = if ($Printer.location) { [string]$Printer.location } else { '' }
    if ([string]$Queue.Location -cne $wantLocation) { $update['Location'] = $wantLocation }
    return $update
}

# ---------------------------------------------------------------------------
# Machine identity and secrets
# ---------------------------------------------------------------------------

function Get-SpoolfreeComputerIdentity {
    <# DN, objectGUID and name of this computer from AD (ADSI, as SYSTEM = the computer account). #>
    $info = New-Object -ComObject 'ADSystemInfo'
    $dn = $info.GetType().InvokeMember('ComputerName', 'GetProperty', $null, $info, $null)
    $entry = [adsi]"LDAP://$dn"
    $guid = (New-Object Guid (, [byte[]]$entry.Properties['objectGUID'][0])).ToString()
    return [pscustomobject]@{
        DistinguishedName = [string]$dn
        ObjectGuid        = $guid.ToLowerInvariant()
        Name              = $env:COMPUTERNAME
    }
}

function Protect-SpoolfreeSecret {
    param([Parameter(Mandatory)][string]$Value)
    Add-Type -AssemblyName System.Security
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Convert]::ToBase64String($enc)
}

function Unprotect-SpoolfreeSecret {
    param([Parameter(Mandatory)][string]$Protected)
    Add-Type -AssemblyName System.Security
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Protected), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Set-SpoolfreeRegistryAcl {
    <# Restrict HKLM:\SOFTWARE\Spoolfree to SYSTEM and Administrators. #>
    param([string]$Path = $script:RegistryRoot)
    $acl = New-Object System.Security.AccessControl.RegistrySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $id = (New-Object System.Security.Principal.SecurityIdentifier $sid)
        $rule = New-Object System.Security.AccessControl.RegistryAccessRule($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -Path $Path -AclObject $acl
}

function Get-SpoolfreeConfig {
    if (-not (Test-Path $script:RegistryRoot)) { return $null }
    $p = Get-ItemProperty -Path $script:RegistryRoot
    return [pscustomobject]@{
        ServerUrl      = $p.ServerUrl
        PublicKey      = $p.PublicKey
        MachineToken   = $(if ($p.PSObject.Properties['MachineToken'] -and $p.MachineToken) { Unprotect-SpoolfreeSecret $p.MachineToken } else { $null })
        ObjectGuid     = $(if ($p.PSObject.Properties['ObjectGuid']) { $p.ObjectGuid } else { $null })
    }
}

# ---------------------------------------------------------------------------
# Printer state tracked by the agent (registry marker per queue it created)
# ---------------------------------------------------------------------------

function Get-SpoolfreeInstalled {
    if (-not (Test-Path $script:PrinterRegistry)) { return @() }
    $list = foreach ($k in Get-ChildItem -Path $script:PrinterRegistry) {
        $p = Get-ItemProperty -Path $k.PSPath
        [pscustomobject]@{ Name = $p.Name; Id = $p.Id; Revision = [int]$p.Revision; Url = $p.Url; Method = $p.Method; PortName = $p.PortName }
    }
    return @($list)
}

function Get-SpoolfreeMarkerKey {
    param([Parameter(Mandatory)][string]$Name)
    # Queue names can contain characters that are awkward as key names; use a stable hash.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Name.ToLowerInvariant()))
    } finally { $sha.Dispose() }
    return Join-Path $script:PrinterRegistry (([BitConverter]::ToString($hash, 0, 8)) -replace '-', '')
}

function Set-SpoolfreeMarker {
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)][string]$Method, [string]$PortName = '')
    $key = Get-SpoolfreeMarkerKey -Name $Printer.name
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name Name -Value $Printer.name -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Id -Value $Printer.id -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Revision -Value ([int]$Printer.revision) -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name Url -Value $Printer.ippUrl -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Method -Value $Method -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name PortName -Value $PortName -PropertyType String -Force | Out-Null
}

function Remove-SpoolfreeMarker {
    param([Parameter(Mandatory)][string]$Name)
    $key = Get-SpoolfreeMarkerKey -Name $Name
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
}

# ---------------------------------------------------------------------------
# Printer install / remove
# ---------------------------------------------------------------------------

function Test-SpoolfreeIppUrlSupported {
    <# Add-Printer -IppURL exists on Windows 11 and recent Windows 10 builds. #>
    $cmd = Get-Command Add-Printer -ErrorAction SilentlyContinue
    return [bool]($cmd -and $cmd.Parameters.ContainsKey('IppURL'))
}

function Test-SpoolfreeProtectedPrintMode {
    <# True when Windows Protected Print Mode is enforced by policy. #>
    $v = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Printers\WPP' -Name EnabledBy -ErrorAction SilentlyContinue
    return [bool]($v -and $v.EnabledBy -ne 0)
}

function Get-SpoolfreeInstallMethod {
    param([bool]$IppUrlSupported, [bool]$ProtectedPrintMode)
    if ($IppUrlSupported) { return 'IppURL' }
    if ($ProtectedPrintMode) { return 'Unsupported' }
    return 'TcpIpPort'
}

function Install-SpoolfreePrinter {
    <#
    .SYNOPSIS
        Creates a machine-wide driverless queue.
        Primary:  Add-Printer -IppURL (IPP class driver chosen by Windows; WPP-compatible).
        Fallback: Standard TCP/IP port + "Microsoft IPP Class Driver" (older Windows 10 only; not WPP-compatible).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)][string]$Method)
    $comment = Get-SpoolfreeComment -Printer $Printer
    $location = if ($Printer.location) { [string]$Printer.location } else { '' }
    switch ($Method) {
        'IppURL' {
            # Windows names IPP queues after the device; create, then rename to the logical name.
            $before = @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
            Add-Printer -IppURL $Printer.ippUrl -Name $Printer.name -ErrorAction Stop
            $q = Get-Printer -Name $Printer.name -ErrorAction SilentlyContinue
            if (-not $q) {
                $new = @(Get-Printer | Where-Object { $before -notcontains $_.Name })
                if ($new.Count -ne 1) { throw "Add-Printer -IppURL did not create a single identifiable queue for $($Printer.name)." }
                Rename-Printer -Name $new[0].Name -NewName $Printer.name -ErrorAction Stop
                $q = Get-Printer -Name $Printer.name -ErrorAction Stop
            }
            Set-Printer -Name $Printer.name -Comment $comment -Location $location -ErrorAction SilentlyContinue
            Set-SpoolfreeMarker -Printer $Printer -Method 'IppURL' -PortName ([string]$q.PortName)
        }
        'TcpIpPort' {
            $port = 'SPOOLFREE_' + ([string]$Printer.host -replace '[^A-Za-z0-9\.\-]', '_')
            if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) {
                Add-PrinterPort -Name $port -PrinterHostAddress $Printer.host -ErrorAction Stop
            }
            if (-not (Get-PrinterDriver -Name $script:IppDriver -ErrorAction SilentlyContinue)) {
                Add-PrinterDriver -Name $script:IppDriver -ErrorAction Stop
            }
            Add-Printer -Name $Printer.name -DriverName $script:IppDriver -PortName $port -Comment $comment -Location $location -ErrorAction Stop
            Set-SpoolfreeMarker -Printer $Printer -Method 'TcpIpPort' -PortName $port
        }
        default { throw "No supported install method on this PC (method '$Method')." }
    }
}

function Uninstall-SpoolfreePrinter {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $marker = Get-SpoolfreeInstalled | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    $q = Get-Printer -Name $Name -ErrorAction SilentlyContinue
    if ($q) {
        # Double-check ownership through the comment before deleting.
        if ($q.Comment -and -not ([string]$q.Comment).StartsWith($script:CommentPrefix)) {
            throw "Queue '$Name' no longer carries the Spoolfree comment; leaving it alone."
        }
        Remove-Printer -Name $Name -ErrorAction Stop
    }
    if ($marker -and $marker.PortName -and ([string]$marker.PortName).StartsWith('SPOOLFREE_')) {
        $inUse = Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.PortName -eq $marker.PortName }
        if (-not $inUse) { Remove-PrinterPort -Name $marker.PortName -ErrorAction SilentlyContinue }
    }
    Remove-SpoolfreeMarker -Name $Name
}

$script:PublicRegistry = 'HKLM:\SOFTWARE\Spoolfree\Public'

function Set-SpoolfreeDefaultPrinter {
    <#
    .SYNOPSIS
        Records the wanted default printer. Windows stores the default per user,
        so the agent (running as SYSTEM) writes it to a key users can read, and the
        "Spoolfree User Default" logon task (Set-SpoolfreeUserDefault.ps1) applies
        it in each session. A user's own later choice is respected until the
        policy default changes.
    #>
    param([AllowEmptyString()][string]$Name)
    if (-not (Test-Path $script:PublicRegistry)) {
        New-Item -Path $script:PublicRegistry -Force | Out-Null
        $acl = Get-Acl -Path $script:PublicRegistry
        $users = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-545'
        $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule($users, 'ReadKey', 'None', 'None', 'Allow')))
        Set-Acl -Path $script:PublicRegistry -AclObject $acl
    }
    New-ItemProperty -Path $script:PublicRegistry -Name DefaultPrinter -Value $Name -PropertyType String -Force | Out-Null
}

function Invoke-SpoolfreeHttp {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [ValidateSet('GET', 'POST')][string]$Method = 'GET',
        [string]$Token,
        $Body
    )
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = "Spoolfree-Agent/$script:AgentVersion" }
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    $params = @{ Uri = $Uri; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 30; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $params['ContentType'] = 'application/json; charset=utf-8'
        $params['Body'] = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 6 -Compress))
    }
    return Invoke-RestMethod @params
}

function Get-SpoolfreeAgentVersion { return $script:AgentVersion }

Export-ModuleMember -Function *-Spoolfree*
