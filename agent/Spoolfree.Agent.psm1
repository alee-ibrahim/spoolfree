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

$script:AgentVersion = '0.4.7'
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
    <# "Managed by Spoolfree [<printer id> rev <n> server <server id>]"; without -ServerId the pre-0.4.2 form. #>
    param([Parameter(Mandatory)]$Printer, [AllowNull()][AllowEmptyString()][string]$ServerId)
    if ($ServerId) { return ('{0} [{1} rev {2} server {3}]' -f $script:CommentPrefix, $Printer.id, $Printer.revision, $ServerId.ToLowerInvariant()) }
    return ('{0} [{1} rev {2}]' -f $script:CommentPrefix, $Printer.id, $Printer.revision)
}

function Get-SpoolfreeQueueUpdate {
    <#
    .SYNOPSIS
        Pure: Set-Printer parameters needed to bring a kept queue in line with the
        manifest. Edits that do not bump the revision (location) would otherwise
        never reach PCs; with -ServerId the comment gets the 0.4.2 form. Returns an empty hashtable when nothing changed or when the
        queue no longer carries the Spoolfree comment (someone else owns it now).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)]$Queue, [AllowNull()][AllowEmptyString()][string]$ServerId)
    $update = @{}
    if (-not ([string]$Queue.Comment).StartsWith($script:CommentPrefix)) { return $update }
    $wantLocation = if ($Printer.location) { [string]$Printer.location } else { '' }
    if ([string]$Queue.Location -cne $wantLocation) { $update['Location'] = $wantLocation }
    # From 0.4.2 the comment names the server, so another server's agent can tell the queue is not its own.
    if ($ServerId) {
        $wantComment = Get-SpoolfreeComment -Printer $Printer -ServerId $ServerId
        if ([string]$Queue.Comment -cne $wantComment) { $update['Comment'] = $wantComment }
    }
    return $update
}

# ---------------------------------------------------------------------------
# Legacy queue takeover (pure). Opt-in per printer through the manifest:
#   printer.legacy = { mode: off | dry-run | on, shares: [share names] }
#   manifest.legacyPrintServers = [print server host names]
# A queue is only ever matched when its device is positively identified as
# the printer's; USB, virtual and unidentifiable queues are never touched.
# ---------------------------------------------------------------------------

$script:VirtualQueuePattern = 'PDF|OneNote|XPS Document Writer|(^|\W)Fax($|\W)|Evernote|Microsoft Print to|Send To '
$script:LocalPortPattern = '^(USB\d+|DOT4_\d+|LPT\d+:?|COM\d+:?|FILE:|nul:|PORTPROMPT:|TS\d+|XPSPort:|SHRFAX:|FOXIT_[^\s]*|Ne\d+:)$'
$script:LocalMonitors = @('Local Monitor', 'Local Port', 'USB Monitor', 'Dynamic Print Monitor', 'Inactive TS Port', 'Microsoft Shared Fax Monitor', 'Appmon')

function Get-SpoolfreeProperty {
    <# StrictMode-safe property read on PSCustomObjects and hashtables; $null when missing. #>
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null } }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Get-SpoolfreeLegacyMode {
    <# 'off' | 'dry-run' | 'on' for a manifest printer (missing or unknown => off). #>
    param($Printer)
    $legacy = Get-SpoolfreeProperty $Printer 'legacy'
    $mode = [string](Get-SpoolfreeProperty $legacy 'mode')
    if ($mode -eq 'on' -or $mode -eq 'dry-run') { return $mode }
    return 'off'
}

function Get-SpoolfreeUrlHost {
    <# Host part of http/https/ipp/ipps URLs, lower-case; $null otherwise. #>
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if (-not $Value) { return $null }
    $m = [regex]::Match($Value.Trim(), '^(?i)(https?|ipps?)://(\[[0-9a-f:.]+\]|[^/:\s\[\]]+)')
    if (-not $m.Success) { return $null }
    return $m.Groups[2].Value.Trim('[', ']').ToLowerInvariant()
}

function Test-SpoolfreeLegacyServer {
    <#
    .SYNOPSIS
        True when $Server (from \\server\share) is one of the legacy print servers. A short name
        and an FQDN are equal when the short name is the FQDN's first label.
    #>
    param([string]$Server, [AllowEmptyCollection()][string[]]$Servers)
    if (-not $Server) { return $false }
    $s = $Server.ToLowerInvariant().TrimEnd('.')
    foreach ($c in @($Servers)) {
        if (-not $c) { continue }
        $c = $c.ToLowerInvariant().Trim().TrimEnd('.')
        if ($c -eq $s) { return $true }
        if ($c -notmatch '\.' -and $s -match '\.' -and $s.Split('.')[0] -eq $c) { return $true }
        if ($s -notmatch '\.' -and $c -match '\.' -and $c.Split('.')[0] -eq $s) { return $true }
    }
    return $false
}

function Test-SpoolfreeVirtualQueue {
    <# True for queues that must never be taken over: virtual printers, USB/parallel/serial/local ports. #>
    param([Parameter(Mandatory)]$Queue, $Port)
    $name = [string](Get-SpoolfreeProperty $Queue 'Name')
    $driver = [string](Get-SpoolfreeProperty $Queue 'DriverName')
    $portName = [string](Get-SpoolfreeProperty $Queue 'PortName')
    if ($name -match $script:VirtualQueuePattern -or $driver -match $script:VirtualQueuePattern) { return $true }
    if ($portName -match $script:LocalPortPattern) { return $true }
    if ($Port) {
        $monitor = [string](Get-SpoolfreeProperty $Port 'Monitor')
        $desc = [string](Get-SpoolfreeProperty $Port 'Description')
        if ($script:LocalMonitors -contains $monitor -or $script:LocalMonitors -contains $desc) { return $true }
    }
    return $false
}

function ConvertTo-SpoolfreeUuid {
    <# Pure: 'urn:uuid:X', '{X}' or a bare UUID -> lower-case bare UUID; $null when it is not one. #>
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if (-not $Value) { return $null }
    $v = $Value.Trim().ToLowerInvariant() -replace '^urn:uuid:', ''
    $v = $v.Trim('{', '}')
    if ($v -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return $null }
    if ($v -eq '00000000-0000-0000-0000-000000000000') { return $null }
    return $v
}

function ConvertTo-SpoolfreeMac {
    <# Pure: a MAC (12 hex digits, optionally separated by : or -) -> 12 lower-case hex digits; $null otherwise. #>
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if (-not $Value) { return $null }
    $v = $Value.Trim().ToLowerInvariant()
    if ($v -notmatch '^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$') { return $null }
    $v = $v -replace '[:-]', ''
    if ($v -eq '000000000000' -or $v -eq 'ffffffffffff') { return $null }
    if ([Convert]::ToInt32($v.Substring(0, 2), 16) -band 1) { return $null }
    return $v
}

function Get-SpoolfreeMacHostMatch {
    <#
    .SYNOPSIS
        Pure: the MAC (12 hex digits) that a printer default host name embeds, when it is one of $Macs; else $null.
    .DESCRIPTION
        Accepted forms, case-insensitive, with an optional ".local" suffix and trailing dot:
        BRN<mac> and BRW<mac> (Brother wired / wireless defaults) and the bare MAC. Anything else (other
        prefixes or suffixes, other domains, partial MACs) does not match.
    #>
    param([AllowNull()][AllowEmptyString()][string]$HostName, [AllowEmptyCollection()][string[]]$Macs = @())
    if (-not $HostName -or @($Macs).Count -eq 0) { return $null }
    $h = $HostName.Trim().ToLowerInvariant().TrimEnd('.')
    if ($h.EndsWith('.local')) { $h = $h.Substring(0, $h.Length - 6) }
    $m = [regex]::Match($h, '^(?:brn|brw)?([0-9a-f]{12})$')
    if (-not $m.Success) { return $null }
    foreach ($mac in @($Macs)) {
        $n = ConvertTo-SpoolfreeMac $mac
        if ($n -and $n -eq $m.Groups[1].Value) { return $n }
    }
    return $null
}

function Get-SpoolfreeServerId {
    <# The pinned public key's id: first 16 hex digits of SHA-256 over the raw key (the server's keyId). #>
    param([AllowNull()][AllowEmptyString()][string]$PublicKey)
    if (-not $PublicKey) { return $null }
    try { $raw = [Convert]::FromBase64String($PublicKey) } catch { return $null }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($raw) } finally { $sha.Dispose() }
    return (([BitConverter]::ToString($hash, 0, 8)) -replace '-', '').ToLowerInvariant()
}

function ConvertFrom-SpoolfreeComment {
    <#
    .SYNOPSIS
        Pure: parses "Managed by Spoolfree [<printer id> rev <n>]" and, from agent 0.4.2, "... rev <n> server <id>]".
        $null when the comment is not a Spoolfree comment.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Comment)
    if (-not $Comment -or -not $Comment.StartsWith($script:CommentPrefix)) { return $null }
    $m = [regex]::Match($Comment, '^Managed by Spoolfree \[(?<id>[^\s\]]+) rev (?<rev>\d+)(?: server (?<server>[0-9a-fA-F]+))?\]')
    if (-not $m.Success) { return [pscustomobject]@{ PrinterId = $null; Revision = $null; ServerId = $null } }
    $server = if ($m.Groups['server'].Success) { $m.Groups['server'].Value.ToLowerInvariant() } else { $null }
    return [pscustomobject]@{ PrinterId = $m.Groups['id'].Value; Revision = [int]$m.Groups['rev'].Value; ServerId = $server }
}

function Get-SpoolfreeQueueOrigin {
    <#
    .SYNOPSIS
        Pure: 'none' (not a Spoolfree queue), 'this' (this server's) or 'other' (another Spoolfree server's).
    .DESCRIPTION
        A comment that names a server id is 'other' when it differs from $ServerId. A comment without one
        (agents before 0.4.2) is 'other' only when the server listed all its printer ids and the comment's id
        is not among them. Anything unclear is 'this', which is never taken over.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$Comment,
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [AllowEmptyCollection()][string[]]$ServerPrinterIds = @()
    )
    $c = ConvertFrom-SpoolfreeComment $Comment
    if ($null -eq $c) { return 'none' }
    if (-not $c.PrinterId -or -not $ServerId) { return 'this' }
    if ($c.ServerId) {
        if ($c.ServerId -eq $ServerId.ToLowerInvariant()) { return 'this' }
        return 'other'
    }
    $ids = @($ServerPrinterIds | Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ($ids.Count -eq 0) { return 'this' }
    if ($ids -contains $c.PrinterId.ToLowerInvariant()) { return 'this' }
    return 'other'
}

function Get-SpoolfreeLegacyMatches {
    <#
    .SYNOPSIS
        Pure: the non-Spoolfree queues (or queues of another Spoolfree server) that point at the same device
        as $Printer.
    .PARAMETER Queues
        Objects with Name, Type (Local/Connection), PortName, DriverName, Comment.
    .PARAMETER Ports
        Hashtable PortName -> object with Monitor, Description, HostAddress, Addresses (resolved IPs / device
        hosts) and Uuids (device UUIDs of WSD/IPP ports).
    .PARAMETER PrinterAddresses
        The printer's host name(s) and resolved IPs, lower-case.
    .PARAMETER ServerId
        This server's id (Get-SpoolfreeServerId of the pinned key). Spoolfree queues of this server are never matched.
    .PARAMETER ServerPrinterIds
        Every printer id on this server (manifest serverPrinterIds).
    .PARAMETER AnyMode
        Match even when the printer's takeover mode is off (to explain a failed queue creation).
    .PARAMETER ConnectionsOnly
        Only consider \\server\share connections (per-user logon task).
    .OUTPUTS
        Objects with Queue, Reason and Kind (use @(...) around the call).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Queues,
        [AllowNull()][hashtable]$Ports = @{},
        [AllowEmptyCollection()][string[]]$PrinterAddresses = @(),
        [AllowEmptyCollection()][string[]]$LegacyServers = @(),
        [AllowEmptyCollection()][string[]]$Installed = @(),
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [AllowEmptyCollection()][string[]]$ServerPrinterIds = @(),
        [switch]$AnyMode,
        [switch]$ConnectionsOnly
    )
    $out = New-Object System.Collections.Generic.List[object]
    if (-not $AnyMode -and (Get-SpoolfreeLegacyMode $Printer) -eq 'off') { return }
    if ($null -eq $Ports) { $Ports = @{} }
    $legacy = Get-SpoolfreeProperty $Printer 'legacy'
    $shares = @{}
    foreach ($s in @(Get-SpoolfreeProperty $legacy 'shares')) { if ($s) { $shares[([string]$s).Trim().ToLowerInvariant()] = $true } }
    $addr = @{}
    foreach ($a in @($PrinterAddresses)) { if ($a) { $addr[$a.ToLowerInvariant()] = $true } }
    $mine = @{}
    foreach ($n in @($Installed)) { if ($n) { $mine[$n.ToLowerInvariant()] = $true } }
    $target = ([string](Get-SpoolfreeProperty $Printer 'name')).ToLowerInvariant()
    $deviceUuid = ConvertTo-SpoolfreeUuid ([string](Get-SpoolfreeProperty $Printer 'deviceUuid'))
    $macs = @(@(Get-SpoolfreeProperty $Printer 'macAddresses') | ForEach-Object { ConvertTo-SpoolfreeMac ([string]$_) } | Where-Object { $_ })

    foreach ($q in @($Queues)) {
        $name = [string](Get-SpoolfreeProperty $q 'Name')
        if (-not $name) { continue }
        $lname = $name.ToLowerInvariant()
        if ($mine.ContainsKey($lname)) { continue }
        $origin = Get-SpoolfreeQueueOrigin -Comment ([string](Get-SpoolfreeProperty $q 'Comment')) -ServerId $ServerId -ServerPrinterIds $ServerPrinterIds
        if ($origin -eq 'this') { continue }
        # A queue with the printer's own name is only taken over when another Spoolfree server created it.
        if ($lname -eq $target -and $origin -ne 'other') { continue }
        $prefix = if ($origin -eq 'other') { 'Spoolfree queue of another server, ' } else { '' }

        $conn = [regex]::Match($name, '^\\\\([^\\]+)\\(.+)$')
        $isConnection = $conn.Success -or ([string](Get-SpoolfreeProperty $q 'Type')) -eq 'Connection'
        if ($isConnection) {
            if (-not $conn.Success) { continue }
            $server = $conn.Groups[1].Value
            $share = $conn.Groups[2].Value
            if ((Test-SpoolfreeLegacyServer -Server $server -Servers $LegacyServers) -and $shares.ContainsKey($share.ToLowerInvariant())) {
                $out.Add([pscustomobject]@{ Queue = $name; Reason = "${prefix}print server connection \\$server\$share"; Kind = 'connection' })
            }
            continue
        }
        if ($ConnectionsOnly) { continue }
        if ($addr.Count -eq 0 -and -not $deviceUuid -and $macs.Count -eq 0) { continue }

        $portName = [string](Get-SpoolfreeProperty $q 'PortName')
        $port = if ($portName -and $Ports.ContainsKey($portName)) { $Ports[$portName] } else { $null }
        if (Test-SpoolfreeVirtualQueue -Queue $q -Port $port) { continue }

        $hostAddress = ([string](Get-SpoolfreeProperty $port 'HostAddress')).Trim().ToLowerInvariant()
        $candidates = New-Object System.Collections.Generic.List[string]
        foreach ($a in @(Get-SpoolfreeProperty $port 'Addresses')) { if ($a) { $candidates.Add(([string]$a).ToLowerInvariant()) } }
        $monitor = [string](Get-SpoolfreeProperty $port 'Monitor')
        $description = [string](Get-SpoolfreeProperty $port 'Description')
        $urlHost = Get-SpoolfreeUrlHost $portName
        if (-not $urlHost) { $urlHost = Get-SpoolfreeUrlHost $hostAddress }

        $kind = $null; $label = $null; $hostName = $null
        if ($portName -match '^WSD-' -or $monitor -eq 'WSD Port' -or $monitor -eq 'WSD Port Monitor') {
            # Identified by the device UUID the port stores, or by the device address found for that UUID.
            $kind = if ($description -eq 'IPP Port') { 'IPP port' } else { 'WSD port' }
            if ($deviceUuid) {
                $portUuids = @(@(Get-SpoolfreeProperty $port 'Uuids') | ForEach-Object { ConvertTo-SpoolfreeUuid ([string]$_) } | Where-Object { $_ })
                if ($portUuids -contains $deviceUuid) {
                    $out.Add([pscustomobject]@{ Queue = $name; Reason = "$prefix$kind device uuid $deviceUuid"; Kind = $kind })
                    continue
                }
                # The port names another device. The address Plug and Play recorded for it can be stale (an IP that
                # DHCP later gave to this printer), so a known, different UUID is never matched by address.
                if ($portUuids.Count) { continue }
            }
        } elseif ($urlHost) {
            $kind = 'IPP port'; $label = $urlHost; $hostName = $urlHost; $candidates.Add($urlHost)
        } elseif ($hostAddress -or $monitor -eq 'Standard TCP/IP Port') {
            $kind = 'TCP/IP port'; $label = $hostAddress; $hostName = $hostAddress
            if ($hostAddress) { $candidates.Add($hostAddress) }
        } else { continue }

        $hit = $null
        foreach ($c in $candidates) { if ($addr.ContainsKey($c)) { $hit = $c; break } }
        if ($hit) {
            if (-not $label) { $label = $hit }
            $out.Add([pscustomobject]@{ Queue = $name; Reason = "$prefix$kind $label"; Kind = $kind })
            continue
        }
        # Default host names that embed the MAC (BRN/BRW + MAC), e.g. when the name is not in DNS.
        $macHit = Get-SpoolfreeMacHostMatch -HostName $hostName -Macs $macs
        if ($macHit) {
            $out.Add([pscustomobject]@{ Queue = $name; Reason = "$prefix$kind $label (host name has the printer's MAC $macHit)"; Kind = $kind })
        }
    }
    # Emitted one by one: wrap calls in @() for an array (empty => @()).
    return $out.ToArray()
}

function Get-SpoolfreeAddFailureMessage {
    <#
    .SYNOPSIS
        Pure: an actionable error for a failed queue creation. Windows allows one WSD/IPP queue per device, so
        "already exists" / "device was not found" usually means another queue holds the device.
    .PARAMETER Blocking
        Matches for the printer from Get-SpoolfreeLegacyMatches -AnyMode (Queue, Reason, Kind).
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Action,
        [AllowEmptyString()][string]$Message,
        [AllowEmptyCollection()][object[]]$Blocking = @(),
        [string]$Mode = 'off'
    )
    $base = "${Name}: $Action failed: $Message"
    if (@($Blocking).Count -eq 0) { return $base }
    $known = $Message -match 'already exists|not found|was not found|cannot find'
    # Add-Printer -IppURL sometimes reports only "An error occurred while performing the specified operation"; a
    # WSD/IPP queue for the same device is then still the likely cause. Other errors (access denied ...) are kept.
    $generic = $Message -match 'error occurred while performing the specified operation'
    $wsd = @(@($Blocking) | Where-Object { @('WSD port', 'IPP port') -contains [string]$_.Kind })
    if (-not $known -and -not ($generic -and $wsd.Count)) { return $base }
    if (-not $known) { $Blocking = $wsd }
    $b = @($Blocking)[0]
    $what = switch ([string]$b.Kind) { 'WSD port' { 'WSD queue' } 'IPP port' { 'IPP queue' } default { 'queue' } }
    $hint = switch ($Mode) {
        'on' { 'legacy takeover is on but could not remove it; check the legacy report and remove it by hand' }
        'dry-run' { 'legacy takeover is in dry-run; switch it to on for this printer' }
        default { 'enable legacy takeover for this printer (dry-run first, then on) or remove that queue' }
    }
    $more = if (@($Blocking).Count -gt 1) { " (and $(@($Blocking).Count - 1) more)" } else { '' }
    $verb = if ($known) { 'blocked' } else { 'failed, probably blocked' }
    return "${Name}: $Action $verb by existing $what '$($b.Queue)'$more ($($b.Reason)): $hint. Windows said: $Message"
}

function ConvertTo-SpoolfreeDeviceIndex {
    <#
    .SYNOPSIS
        Pure: device UUID -> addresses, from PnP device data of WSD/IPP printers (SWD\DAFWSDProvider\..., SWD\IPP\...).
    .PARAMETER Devices
        Objects with InstanceId and Values (strings: LocationInformation, ContainerID, PnP-X properties ...).
    .DESCRIPTION
        A device's UUIDs come only from its instance id and its ContainerID (never from other values such as
        class GUIDs). Its addresses are the hosts of URL values and IP address literals.
    #>
    param([AllowEmptyCollection()][object[]]$Devices = @())
    $index = @{}
    $uuidRe = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    foreach ($d in @($Devices)) {
        if ($null -eq $d) { continue }
        $uuids = New-Object System.Collections.Generic.List[string]
        foreach ($src in @([string](Get-SpoolfreeProperty $d 'InstanceId'), [string](Get-SpoolfreeProperty $d 'ContainerId'))) {
            foreach ($m in [regex]::Matches($src, $uuidRe)) { $u = ConvertTo-SpoolfreeUuid $m.Value; if ($u) { $uuids.Add($u) } }
        }
        if ($uuids.Count -eq 0) { continue }
        $hosts = New-Object System.Collections.Generic.List[string]
        foreach ($v in @(Get-SpoolfreeProperty $d 'Values')) {
            foreach ($s in @($v)) {
                $t = ([string]$s).Trim()
                if (-not $t) { continue }
                $h = Get-SpoolfreeUrlHost $t
                if ($h) { $hosts.Add($h); continue }
                $ip = $null
                if ($t -match '^[0-9a-fA-F:.]+$' -and $t -match '[.:]' -and [Net.IPAddress]::TryParse($t, [ref]$ip)) { $hosts.Add($ip.ToString().ToLowerInvariant()) }
            }
        }
        foreach ($u in ($uuids | Select-Object -Unique)) {
            if (-not $index.ContainsKey($u)) { $index[$u] = @() }
            $index[$u] = @(@($index[$u]) + @($hosts) | Select-Object -Unique)
        }
    }
    return $index
}

function Get-SpoolfreeWsdPortData {
    <#
    .SYNOPSIS
        Pure: UUIDs and addresses of a WSD/IPP port from its registry values ("Printer UUID", URL values) and the
        device index (ConvertTo-SpoolfreeDeviceIndex).
    #>
    param([AllowNull()][hashtable]$Values = @{}, [AllowNull()][hashtable]$DeviceIndex = @{})
    $uuids = New-Object System.Collections.Generic.List[string]
    $hosts = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Values) { $Values = @{} }
    if ($null -eq $DeviceIndex) { $DeviceIndex = @{} }
    foreach ($k in $Values.Keys) {
        $v = [string]$Values[$k]
        if ($k -match 'UUID') { $u = ConvertTo-SpoolfreeUuid $v; if ($u) { $uuids.Add($u) } ; continue }
        $h = Get-SpoolfreeUrlHost $v
        if ($h) { $hosts.Add($h) }
    }
    foreach ($u in $uuids) { if ($DeviceIndex.ContainsKey($u)) { foreach ($h in @($DeviceIndex[$u])) { if ($h) { $hosts.Add([string]$h) } } } }
    return [pscustomobject]@{ Uuids = @($uuids | Select-Object -Unique); Hosts = @($hosts | Select-Object -Unique) }
}

function Merge-SpoolfreeRemovedMap {
    <# Pure: previous removedMap (object/hashtable) + new entries => hashtable, at most $Max entries (newest win). #>
    param($Previous, [hashtable]$New = @{}, [int]$Max = 500)
    $merged = [ordered]@{}
    if ($Previous -is [System.Collections.IDictionary]) {
        foreach ($k in $Previous.Keys) { $merged[[string]$k] = [string]$Previous[$k] }
    } elseif ($null -ne $Previous) {
        foreach ($p in $Previous.PSObject.Properties) { $merged[$p.Name] = [string]$p.Value }
    }
    foreach ($k in $New.Keys) { if ($merged.Contains($k)) { $merged.Remove($k) }; $merged[$k] = [string]$New[$k] }
    while ($merged.Count -gt $Max) { $merged.RemoveAt(0) }
    $h = @{}
    foreach ($k in $merged.Keys) { $h[$k] = $merged[$k] }
    return $h
}

# ---------------------------------------------------------------------------
# Sync interval (manifest syncIntervalMinutes, AGENT_SYNC_INTERVAL_MINUTES on the server)
# ---------------------------------------------------------------------------

function Get-SpoolfreeSyncSchedule {
    <#
    .SYNOPSIS
        Pure: the repeating trigger for an interval: minutes clamped to 5..240 (invalid => $null), and a random
        delay of about 20% of the interval (1..48 minutes) so PCs do not all call the server at once.
    #>
    param($Minutes)
    $m = 0
    if (-not [int]::TryParse([string]$Minutes, [ref]$m)) { return $null }
    if ($m -lt 5) { $m = 5 }
    if ($m -gt 240) { $m = 240 }
    $delay = [int][Math]::Max(1, [Math]::Round($m * 0.2))
    return [pscustomobject]@{ IntervalMinutes = $m; RandomDelayMinutes = $delay }
}

function New-SpoolfreeSyncTriggers {
    <# Startup trigger (2 min delay) + the repeating trigger with random delay. #>
    param([Parameter(Mandatory)][int]$IntervalMinutes)
    $s = Get-SpoolfreeSyncSchedule $IntervalMinutes
    $startup = New-ScheduledTaskTrigger -AtStartup
    $startup.Delay = 'PT2M'
    $repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(5)) `
        -RepetitionInterval (New-TimeSpan -Minutes $s.IntervalMinutes) `
        -RandomDelay (New-TimeSpan -Minutes $s.RandomDelayMinutes)
    return @($startup, $repeat)
}

function Update-SpoolfreeSyncInterval {
    <#
    .SYNOPSIS
        Applies the server's sync interval to the "Spoolfree Sync" task when it differs from the value last
        applied (HKLM:\SOFTWARE\Spoolfree\SyncIntervalMinutes). Keeps the startup trigger. Returns the new
        interval, or $null when nothing changed.
    #>
    param($Minutes)
    $s = Get-SpoolfreeSyncSchedule $Minutes
    if (-not $s) { return $null }
    $current = Get-ItemProperty -Path $script:RegistryRoot -Name SyncIntervalMinutes -ErrorAction SilentlyContinue
    $task = Get-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue
    if ($current -and [int]$current.SyncIntervalMinutes -eq $s.IntervalMinutes -and $task) { return $null }
    if ($task) {
        Set-ScheduledTask -TaskName 'Spoolfree Sync' -TaskPath '\Spoolfree\' -Trigger (New-SpoolfreeSyncTriggers $s.IntervalMinutes) -ErrorAction Stop | Out-Null
    }
    New-ItemProperty -Path $script:RegistryRoot -Name SyncIntervalMinutes -Value $s.IntervalMinutes -PropertyType DWord -Force | Out-Null
    return $s.IntervalMinutes
}

# ---------------------------------------------------------------------------
# Default printer across rename / replace
# ---------------------------------------------------------------------------

function Get-SpoolfreeRecreatedQueues {
    <#
    .SYNOPSIS
        Pure: queues the plan removes and creates again under the same or a new name (Replace, or a rename =
        Remove of a marker whose printer id is now wanted under another name). Returns a hashtable
        oldName -> newName, so a user's default can follow the queue.
    #>
    param([AllowEmptyCollection()][object[]]$Plan = @(), [AllowEmptyCollection()][object[]]$Installed = @())
    $map = @{}
    $wantedById = @{}
    foreach ($s in @($Plan)) {
        if ($s.Printer -and @('Add', 'Replace') -contains $s.Action) { $wantedById[[string]$s.Printer.id] = [string]$s.Name }
    }
    foreach ($s in @($Plan)) {
        if ($s.Action -eq 'Replace') { $map[[string]$s.Name] = [string]$s.Name }
        elseif ($s.Action -eq 'Remove') {
            $marker = @($Installed) | Where-Object { [string]$_.Name -eq [string]$s.Name } | Select-Object -First 1
            if ($marker -and $wantedById.ContainsKey([string]$marker.Id)) { $map[[string]$s.Name] = $wantedById[[string]$marker.Id] }
        }
    }
    return $map
}

function Merge-SpoolfreeRecreatedMap {
    <# Pure: previous recreated map ({old: {to, at}}) + new oldName->newName entries stamped $At; newest $Max kept. #>
    param($Previous, [hashtable]$New = @{}, [datetime]$At = [datetime]::UtcNow, [int]$Max = 200)
    $list = New-Object System.Collections.Generic.List[object]
    if ($null -ne $Previous) {
        $props = if ($Previous -is [System.Collections.IDictionary]) { $Previous.Keys | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $Previous[$_] } } } else { $Previous.PSObject.Properties }
        foreach ($p in $props) { if (-not $New.ContainsKey([string]$p.Name)) { $list.Add([pscustomobject]@{ Old = [string]$p.Name; To = [string](Get-SpoolfreeProperty $p.Value 'to'); At = [string](Get-SpoolfreeProperty $p.Value 'at') }) } }
    }
    $stamp = $At.ToUniversalTime().ToString('o')
    foreach ($k in $New.Keys) { $list.Add([pscustomobject]@{ Old = [string]$k; To = [string]$New[$k]; At = $stamp }) }
    $h = @{}
    foreach ($e in @($list | Sort-Object At | Select-Object -Last $Max)) { $h[$e.Old] = @{ to = $e.To; at = $e.At } }
    return $h
}

function Get-SpoolfreeDefaultRestore {
    <#
    .SYNOPSIS
        Pure decision for the logon task: which queue should become the user's default again after a rename or
        replace removed and re-created their default queue? $null when nothing should change.
    .PARAMETER LastKnownDefault
        The user's default as recorded at their previous logon, with the time it was recorded.
    .PARAMETER Recreated
        The published map {oldName: {to, at}}.
    .PARAMETER Existing
        Queue names that exist now.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$CurrentDefault,
        [AllowNull()][AllowEmptyString()][string]$LastKnownDefault,
        [AllowNull()][AllowEmptyString()][string]$LastKnownAt,
        $Recreated,
        [AllowEmptyCollection()][string[]]$Existing = @()
    )
    if (-not $LastKnownDefault -or $null -eq $Recreated) { return $null }
    $entry = $null
    $props = if ($Recreated -is [System.Collections.IDictionary]) { $Recreated.Keys | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $Recreated[$_] } } } else { $Recreated.PSObject.Properties }
    foreach ($p in $props) { if ([string]$p.Name -ieq $LastKnownDefault) { $entry = $p.Value; break } }
    if (-not $entry) { return $null }
    $to = [string](Get-SpoolfreeProperty $entry 'to')
    $at = [string](Get-SpoolfreeProperty $entry 'at')
    if (-not $to -or -not (@($Existing) | Where-Object { $_ -ieq $to })) { return $null }
    # Only when the queue was re-created after we last saw it as the default: a later own choice wins.
    if ($LastKnownAt -and $at) {
        try {
            $style = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
            $c = [Globalization.CultureInfo]::InvariantCulture
            if ([datetime]::Parse($at, $c, $style) -lt [datetime]::Parse($LastKnownAt, $c, $style)) { return $null }
        } catch { return $null }
    }
    if ($CurrentDefault -and $CurrentDefault -ieq $to) { return $null }
    return $to
}

# ---------------------------------------------------------------------------
# Default duplex (manifest printer.defaultSides, IPP "sides" keywords)
# ---------------------------------------------------------------------------

function ConvertTo-SpoolfreeDuplexingMode {
    <# Pure: IPP sides keyword -> Set-PrintConfiguration -DuplexingMode value; $null for auto/unknown. #>
    param([AllowNull()][AllowEmptyString()][string]$Sides)
    switch ($Sides) {
        'one-sided' { return 'OneSided' }
        'two-sided-long-edge' { return 'TwoSidedLongEdge' }
        'two-sided-short-edge' { return 'TwoSidedShortEdge' }
        default { return $null }
    }
}

function Get-SpoolfreeDesiredSides {
    <# Pure: the manifest printer's defaultSides, 'auto' when missing or unknown. #>
    param($Printer)
    $s = [string](Get-SpoolfreeProperty $Printer 'defaultSides')
    if (ConvertTo-SpoolfreeDuplexingMode $s) { return $s }
    return 'auto'
}

function Test-SpoolfreeDuplexNeeded {
    <#
    .SYNOPSIS
        Pure: should the duplex default be (re)applied? Only when a mode is wanted and either the queue was
        just (re)created or the value recorded in the marker differs. 'auto' never touches the queue.
    #>
    param([string]$Desired, [AllowNull()][AllowEmptyString()][string]$Applied, [bool]$Recreated)
    if (-not (ConvertTo-SpoolfreeDuplexingMode $Desired)) { return $false }
    if ($Recreated) { return $true }
    return ($Applied -ne $Desired)
}

function Set-SpoolfreeQueueDuplex {
    <# Sets the queue's default duplex (printer defaults; users' own saved preferences still win). #>
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Sides)
    $mode = ConvertTo-SpoolfreeDuplexingMode $Sides
    if (-not $mode) { throw "Unknown duplex mode '$Sides'." }
    Set-PrintConfiguration -PrinterName $Name -DuplexingMode $mode -ErrorAction Stop
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
        $sides = if ($p.PSObject.Properties['Sides']) { [string]$p.Sides } else { '' }
        [pscustomobject]@{ Name = $p.Name; Id = $p.Id; Revision = [int]$p.Revision; Url = $p.Url; Method = $p.Method; PortName = $p.PortName; Sides = $sides }
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
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)][string]$Method, [string]$PortName = '', [string]$ServerId = '')
    $key = Get-SpoolfreeMarkerKey -Name $Printer.name
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name Name -Value $Printer.name -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Id -Value $Printer.id -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Revision -Value ([int]$Printer.revision) -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name Url -Value $Printer.ippUrl -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Method -Value $Method -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name PortName -Value $PortName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Server -Value $ServerId -PropertyType String -Force | Out-Null
}

function Set-SpoolfreeMarkerSides {
    <# Records the duplex default last applied to a queue (so it is re-applied only when the manifest changes). #>
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Sides)
    $key = Get-SpoolfreeMarkerKey -Name $Name
    if (Test-Path $key) { New-ItemProperty -Path $key -Name Sides -Value $Sides -PropertyType String -Force | Out-Null }
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
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)][string]$Method, [AllowNull()][AllowEmptyString()][string]$ServerId)
    $comment = Get-SpoolfreeComment -Printer $Printer -ServerId $ServerId
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
            Set-SpoolfreeMarker -Printer $Printer -Method 'IppURL' -PortName ([string]$q.PortName) -ServerId ([string]$ServerId)
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
            Set-SpoolfreeMarker -Printer $Printer -Method 'TcpIpPort' -PortName $port -ServerId ([string]$ServerId)
        }
        default { throw "No supported install method on this PC (method '$Method')." }
    }
}

function Test-SpoolfreeIppFallbackError {
    <#
    .SYNOPSIS
        Pure: should a failed Add-Printer -IppURL fall back to the TCP/IP port method? Yes for every error except
        "already exists" (a queue with that name exists: another method would fail the same way).
    #>
    param([AllowNull()][AllowEmptyString()][string]$Message)
    return -not ([string]$Message -match 'already exists')
}

function Get-SpoolfreeStaleDeviceItems {
    <#
    .SYNOPSIS
        Pure: leftovers of a removed WSD/IPP queue for one device (by IPP printer-uuid) that can keep
        Add-Printer -IppURL from finding the device (seen on Windows 11 22000):
        - WSD-monitor ports whose "Printer UUID" is the device and that no queue uses;
        - PnP nodes that are no longer present and whose instance id names exactly this device
          (SWD\DAFWSDProvider\urn:uuid:<uuid>[/...], SWD\IPP\<uuid>, SWD\ESCL is never touched).
        Anything that is in use or present, or belongs to another uuid, is left alone.
    .PARAMETER WsdPorts
        Objects with Name and PrinterUuid (WSD Port monitor registry).
    .PARAMETER Queues
        Objects with Name and PortName (Get-Printer).
    .PARAMETER PnpDevices
        Objects with InstanceId and Present (bool).
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$DeviceUuid,
        [AllowEmptyCollection()][object[]]$WsdPorts = @(),
        [AllowEmptyCollection()][object[]]$Queues = @(),
        [AllowEmptyCollection()][object[]]$PnpDevices = @()
    )
    $uuid = ConvertTo-SpoolfreeUuid $DeviceUuid
    $result = [pscustomobject]@{ Ports = @(); PnpIds = @() }
    if (-not $uuid) { return $result }
    $used = @{}
    foreach ($q in @($Queues)) { if ($q.PortName) { $used[([string]$q.PortName).ToLowerInvariant()] = $true } }
    $ports = @(@($WsdPorts) | Where-Object {
            $_ -and $_.Name -and (ConvertTo-SpoolfreeUuid ([string]$_.PrinterUuid)) -eq $uuid -and -not $used[([string]$_.Name).ToLowerInvariant()]
        } | ForEach-Object { [string]$_.Name })
    $u = [regex]::Escape($uuid)
    $pattern = "^SWD\\(DAFWSDPROVIDER\\URN:UUID:$u(/|$)|IPP\\$u$)"
    $pnp = @(@($PnpDevices) | Where-Object {
            $_ -and $_.InstanceId -and ([string]$_.InstanceId) -match $pattern -and -not [bool]$_.Present
        } | ForEach-Object { [string]$_.InstanceId })
    $result.Ports = $ports
    $result.PnpIds = $pnp
    return $result
}

function Get-SpoolfreeWsdPortRegistry {
    <# WSD Port monitor ports with their Printer UUID (registry), for Get-SpoolfreeStaleDeviceItems. #>
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\WSD Port\Ports'
    @(Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
            $v = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
            [pscustomobject]@{ Name = $_.PSChildName; PrinterUuid = [string]$v.'Printer UUID' }
        })
}

function Clear-SpoolfreeStaleDevice {
    <#
    .SYNOPSIS
        Removes the unused WSD/IPP ports and non-present PnP nodes of one device (see Get-SpoolfreeStaleDeviceItems).
        Returns a list of what was done (strings). Never throws.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([AllowNull()][AllowEmptyString()][string]$DeviceUuid)
    $done = New-Object System.Collections.Generic.List[string]
    try {
        $pnp = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^SWD\\(DAFWSDPROVIDER|IPP)\\' } | ForEach-Object {
                [pscustomobject]@{ InstanceId = $_.InstanceId; Present = [bool]$_.Present }
            })
        $items = Get-SpoolfreeStaleDeviceItems -DeviceUuid $DeviceUuid -WsdPorts (Get-SpoolfreeWsdPortRegistry) `
            -Queues @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = $_.Name; PortName = $_.PortName } }) -PnpDevices $pnp
        foreach ($port in @($items.Ports)) {
            if (-not $PSCmdlet.ShouldProcess($port, 'Remove unused WSD/IPP port of the device')) { continue }
            try { Remove-PrinterPort -Name $port -ErrorAction Stop; $done.Add("removed unused port $port") }
            catch { $done.Add("could not remove unused port ${port}: $($_.Exception.Message)") }
        }
        foreach ($id in @($items.PnpIds)) {
            if (-not $PSCmdlet.ShouldProcess($id, 'Remove non-present PnP node of the device')) { continue }
            $out = & pnputil.exe /remove-device "$id" 2>&1
            if ($LASTEXITCODE -eq 0) { $done.Add("removed stale device node $id") }
            else { $done.Add("could not remove device node ${id}: $(($out | Out-String).Trim())") }
        }
    } catch {
        $done.Add("stale device check failed: $($_.Exception.Message)")
    }
    return $done.ToArray()
}

function Install-SpoolfreePrinterResilient {
    <#
    .SYNOPSIS
        Install-SpoolfreePrinter with recovery for Add-Printer -IppURL failures (any error but "already exists"):
        1. remove leftovers of the device's removed WSD/IPP queue (unused port, non-present PnP nodes) and retry -IppURL
           once when something was removed;
        2. fall back to a Standard TCP/IP port + Microsoft IPP Class Driver queue (not when Windows Protected Print
           Mode is enforced: that queue type is not allowed then).
        Returns Method (the method that worked), Fallback (bool) and Notes. Throws with every error when all fail.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)][string]$Method,
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [bool]$ProtectedPrintMode = $false
    )
    $notes = New-Object System.Collections.Generic.List[string]
    try {
        Install-SpoolfreePrinter -Printer $Printer -Method $Method -ServerId $ServerId
        return [pscustomobject]@{ Method = $Method; Fallback = $false; Notes = @() }
    } catch {
        $first = $_.Exception.Message
        if ($Method -ne 'IppURL' -or -not (Test-SpoolfreeIppFallbackError $first)) { throw }
    }
    $notes.Add("Add-Printer -IppURL failed: $first")
    $uuid = [string](Get-SpoolfreeProperty $Printer 'deviceUuid')
    if ($uuid) {
        $cleaned = @(Clear-SpoolfreeStaleDevice -DeviceUuid $uuid)
        foreach ($c in $cleaned) { $notes.Add($c) }
        if (@($cleaned | Where-Object { $_ -like 'removed *' }).Count) {
            try {
                Install-SpoolfreePrinter -Printer $Printer -Method 'IppURL' -ServerId $ServerId
                $notes.Add('Add-Printer -IppURL worked after removing the stale device entries')
                return [pscustomobject]@{ Method = 'IppURL'; Fallback = $false; Notes = $notes.ToArray() }
            } catch {
                $notes.Add("Add-Printer -IppURL retry failed: $($_.Exception.Message)")
            }
        }
    }
    if ($ProtectedPrintMode) {
        throw "Add-Printer -IppURL failed ($first) and no fallback is possible: Windows Protected Print Mode is enforced."
    }
    try {
        Install-SpoolfreePrinter -Printer $Printer -Method 'TcpIpPort' -ServerId $ServerId
    } catch {
        throw "Add-Printer -IppURL failed ($first); TCP/IP port fallback failed too: $($_.Exception.Message)"
    }
    $notes.Add('created with a Standard TCP/IP port and the Microsoft IPP Class Driver instead')
    return [pscustomobject]@{ Method = 'TcpIpPort'; Fallback = $true; Notes = $notes.ToArray() }
}

function Get-SpoolfreeOrphanedPrinters {
    <#
    .SYNOPSIS
        Pure: printers this PC should have, does not have, and whose legacy queue(s) takeover removed here: the PC is
        left without that printer. Returns objects with Printer and Queues (the removed legacy queues).
    .PARAMETER RemovedMap
        Removed legacy queue name -> Spoolfree printer name (takeover state, all syncs).
    #>
    param(
        [AllowEmptyCollection()][string[]]$Desired = @(),
        [AllowEmptyCollection()][string[]]$Installed = @(),
        $RemovedMap
    )
    $have = @{}
    foreach ($n in @($Installed)) { if ($n) { $have[$n.ToLowerInvariant()] = $true } }
    $pairs = @()
    if ($RemovedMap -is [System.Collections.IDictionary]) { foreach ($k in $RemovedMap.Keys) { $pairs += , @([string]$k, [string]$RemovedMap[$k]) } }
    elseif ($null -ne $RemovedMap) { foreach ($p in $RemovedMap.PSObject.Properties) { $pairs += , @($p.Name, [string]$p.Value) } }
    $out = @()
    foreach ($d in @($Desired)) {
        if (-not $d -or $have[$d.ToLowerInvariant()]) { continue }
        $queues = @($pairs | Where-Object { $_[1] -and $_[1].ToLowerInvariant() -eq $d.ToLowerInvariant() } | ForEach-Object { $_[0] } | Sort-Object)
        if ($queues.Count) { $out += [pscustomobject]@{ Printer = $d; Queues = $queues } }
    }
    return $out
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
    Initialize-SpoolfreePublicKey
    New-ItemProperty -Path $script:PublicRegistry -Name DefaultPrinter -Value $Name -PropertyType String -Force | Out-Null
}

function Initialize-SpoolfreePublicKey {
    <# HKLM:\SOFTWARE\Spoolfree\Public: written by SYSTEM, readable by Users (logon task). #>
    if (Test-Path $script:PublicRegistry) { return }
    New-Item -Path $script:PublicRegistry -Force | Out-Null
    $acl = Get-Acl -Path $script:PublicRegistry
    $users = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-545'
    $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule($users, 'ReadKey', 'None', 'None', 'Allow')))
    Set-Acl -Path $script:PublicRegistry -AclObject $acl
}

# ---------------------------------------------------------------------------
# Legacy queue takeover (impure side)
# ---------------------------------------------------------------------------

$script:UserTakeoverDir = Join-Path $env:ProgramData 'Spoolfree\UserTakeover'
$script:DnsCache = @{}

function Resolve-SpoolfreeAddress {
    <# Host name or IP -> lower-case IP strings. Tolerates DNS failures and slow servers (3 s). #>
    param([AllowEmptyString()][string]$HostName)
    if (-not $HostName) { return @() }
    $h = $HostName.Trim().Trim('[', ']').ToLowerInvariant()
    $ip = $null
    if ([Net.IPAddress]::TryParse($h, [ref]$ip)) { return @($ip.ToString().ToLowerInvariant()) }
    if ($script:DnsCache.ContainsKey($h)) { return $script:DnsCache[$h] }
    $result = @()
    try {
        $ar = [Net.Dns]::BeginGetHostAddresses($h, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(3000)) {
            $result = @([Net.Dns]::EndGetHostAddresses($ar) | ForEach-Object { $_.ToString().ToLowerInvariant() })
        }
    } catch { $result = @() }
    $script:DnsCache[$h] = $result
    return $result
}

function Get-SpoolfreePrinterAddressSet {
    <# The printer's host (and the host in its IPP URL) plus their resolved IPs, lower-case. #>
    param([Parameter(Mandatory)]$Printer)
    $set = New-Object System.Collections.Generic.List[string]
    foreach ($h in @([string](Get-SpoolfreeProperty $Printer 'host'), (Get-SpoolfreeUrlHost ([string](Get-SpoolfreeProperty $Printer 'ippUrl'))))) {
        if (-not $h) { continue }
        $set.Add($h.ToLowerInvariant())
        foreach ($a in (Resolve-SpoolfreeAddress $h)) { $set.Add($a) }
    }
    return @($set | Select-Object -Unique)
}

function Get-SpoolfreeQueueInventory {
    param([switch]$ConnectionsOnly)
    $list = foreach ($q in @(Get-Printer -ErrorAction SilentlyContinue)) {
        $o = [pscustomobject]@{ Name = [string]$q.Name; Type = [string]$q.Type; PortName = [string]$q.PortName; DriverName = [string]$q.DriverName; Comment = [string]$q.Comment }
        if ($ConnectionsOnly -and $o.Type -ne 'Connection' -and -not $o.Name.StartsWith('\\')) { continue }
        $o
    }
    return @($list)
}

function Get-SpoolfreeDeviceIndex {
    <#
    .SYNOPSIS
        Device UUID -> addresses for WSD and IPP printers known to Plug and Play: the registry
        (HKLM:\SYSTEM\CurrentControlSet\Enum\SWD\DAFWSDProvider\* and ...\SWD\IPP\*: LocationInformation,
        ContainerID) and the devices' PnP-X properties (IP address, device URLs). Best effort; empty on failure.
    #>
    $devices = New-Object System.Collections.Generic.List[object]
    foreach ($root in 'HKLM:\SYSTEM\CurrentControlSet\Enum\SWD\DAFWSDProvider', 'HKLM:\SYSTEM\CurrentControlSet\Enum\SWD\IPP') {
        foreach ($k in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $values = New-Object System.Collections.Generic.List[string]
            $container = ''
            foreach ($n in @($k.GetValueNames())) {
                $v = $k.GetValue($n)
                if ($n -eq 'ContainerID') { $container = [string]$v; continue }
                foreach ($x in @($v)) { if ($x -is [string]) { $values.Add($x) } }
            }
            $devices.Add([pscustomobject]@{ InstanceId = [string]$k.PSChildName; ContainerId = $container; Values = $values.ToArray() })
        }
    }
    if (Get-Command Get-PnpDeviceProperty -ErrorAction SilentlyContinue) {
        try {
            $pnp = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^SWD\\(DAFWSDPROVIDER|IPP)\\' })
            foreach ($d in $pnp) {
                $values = New-Object System.Collections.Generic.List[string]
                $container = ''
                foreach ($prop in @(Get-PnpDeviceProperty -InstanceId $d.InstanceId -ErrorAction SilentlyContinue)) {
                    if ($prop.KeyName -eq 'DEVPKEY_Device_ContainerId') { $container = [string]$prop.Data; continue }
                    foreach ($x in @($prop.Data)) { if ($x -is [string]) { $values.Add($x) } }
                }
                $devices.Add([pscustomobject]@{ InstanceId = [string]$d.InstanceId; ContainerId = $container; Values = $values.ToArray() })
            }
        } catch { Write-Verbose "PnP device properties unavailable: $($_.Exception.Message)" }
    }
    return (ConvertTo-SpoolfreeDeviceIndex -Devices $devices.ToArray())
}

function Get-SpoolfreePortInventory {
    <# Hashtable PortName -> Monitor, Description, HostAddress, Addresses (resolved / device hosts), Uuids. #>
    $ports = @{}
    $deviceIndex = $null
    foreach ($p in @(Get-PrinterPort -ErrorAction SilentlyContinue)) {
        $name = [string]$p.Name
        $hostAddress = ''
        if ($p.PSObject.Properties['PrinterHostAddress'] -and $p.PrinterHostAddress) { $hostAddress = [string]$p.PrinterHostAddress }
        $monitor = if ($p.PSObject.Properties['PortMonitor']) { [string]$p.PortMonitor } else { '' }
        $addresses = @()
        $uuids = @()
        $urlHost = Get-SpoolfreeUrlHost $name
        if ($hostAddress) { $addresses = Resolve-SpoolfreeAddress $hostAddress }
        elseif ($urlHost) { $addresses = Resolve-SpoolfreeAddress $urlHost }
        elseif ($name -match '^WSD-' -or $monitor -like 'WSD Port*') {
            if ($null -eq $deviceIndex) { $deviceIndex = Get-SpoolfreeDeviceIndex }
            $values = @{}
            $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\WSD Port\Ports\$name"
            $props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            if ($props) { foreach ($pp in $props.PSObject.Properties) { if ($pp.Name -notlike 'PS*' -and $pp.Value -is [string]) { $values[$pp.Name] = $pp.Value } } }
            $data = Get-SpoolfreeWsdPortData -Values $values -DeviceIndex $deviceIndex
            $uuids = @($data.Uuids)
            # Device addresses are compared as found (mostly IPs); they are not looked up in DNS.
            $addresses = @($data.Hosts)
        }
        $ports[$name] = [pscustomobject]@{ Monitor = $monitor; Description = [string]$p.Description; HostAddress = $hostAddress; Addresses = @($addresses); Uuids = @($uuids) }
    }
    return $ports
}

function Get-SpoolfreeTakeoverState {
    <# The Takeover JSON published for the logon task, or $null. #>
    $v = Get-ItemProperty -Path $script:PublicRegistry -Name Takeover -ErrorAction SilentlyContinue
    if (-not $v -or -not $v.Takeover) { return $null }
    try { return ($v.Takeover | ConvertFrom-Json) } catch { return $null }
}

function Set-SpoolfreeTakeoverState {
    <# Publishes legacy servers, rules and the merged removed-queue map for the logon task. #>
    param([AllowEmptyCollection()][string[]]$Servers = @(), [AllowEmptyCollection()][object[]]$Rules = @(), [hashtable]$Removed = @{}, [hashtable]$Recreated = @{})
    Initialize-SpoolfreePublicKey
    $prev = Get-SpoolfreeTakeoverState
    $map = Merge-SpoolfreeRemovedMap -Previous (Get-SpoolfreeProperty $prev 'removedMap') -New $Removed
    $recreated = Merge-SpoolfreeRecreatedMap -Previous (Get-SpoolfreeProperty $prev 'recreated') -New $Recreated
    $state = [ordered]@{ servers = @($Servers); rules = @($Rules); removedMap = $map; recreated = $recreated }
    New-ItemProperty -Path $script:PublicRegistry -Name Takeover -Value ($state | ConvertTo-Json -Depth 5 -Compress) -PropertyType String -Force | Out-Null
}

function Initialize-SpoolfreeUserTakeoverDir {
    <#
    Users may create their own result file (the logon task writes <SID>.json) but cannot list,
    read or change other users' files. SYSTEM and Administrators: full control.
    #>
    param([string]$Path = $script:UserTakeoverDir)
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = { param($s) New-Object System.Security.Principal.SecurityIdentifier $s }
    foreach ($s in 'S-1-5-18', 'S-1-5-32-544') {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((& $sid $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    # Authenticated Users: create files in this folder only.
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((& $sid 'S-1-5-11'), 'CreateFiles, ReadAttributes, Synchronize', 'None', 'None', 'Allow')))
    # CREATOR OWNER: full control of the files they created.
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((& $sid 'S-1-3-0'), 'FullControl', 'ObjectInherit', 'InheritOnly', 'Allow')))
    Set-Acl -Path $Path -AclObject $acl
}

function ConvertTo-SpoolfreeLegacyEntry {
    <# Pure: validated report entry (strings capped), or $null. #>
    param($Entry, [Parameter(Mandatory)][string]$Scope)
    $action = [string](Get-SpoolfreeProperty $Entry 'action')
    if (@('removed', 'would-remove', 'failed') -notcontains $action) { return $null }
    $cap = { param($v) $s = [string]$v; if ($s.Length -gt 256) { $s.Substring(0, 256) } else { $s } }
    $o = [ordered]@{
        printer = & $cap (Get-SpoolfreeProperty $Entry 'printer')
        queue   = & $cap (Get-SpoolfreeProperty $Entry 'queue')
        reason  = & $cap (Get-SpoolfreeProperty $Entry 'reason')
        action  = $action
        scope   = & $cap $Scope
    }
    if (-not $o.printer -or -not $o.queue) { return $null }
    $err = Get-SpoolfreeProperty $Entry 'error'
    if ($err) { $o['error'] = & $cap $err }
    return [pscustomobject]$o
}

function Get-SpoolfreeUserTakeoverResults {
    <# Per-user results written by the logon task. The scope comes from the file owner, not its content. #>
    param([string]$Path = $script:UserTakeoverDir, [int]$Max = 200)
    $out = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path $Path)) { return @() }
    foreach ($f in @(Get-ChildItem -Path $Path -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        if ($f.Length -gt 65536) { continue }
        try {
            $owner = (Get-Acl -LiteralPath $f.FullName).Owner
            $data = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
        } catch { continue }
        foreach ($e in @($data)) {
            $entry = ConvertTo-SpoolfreeLegacyEntry -Entry $e -Scope "user:$owner"
            if ($entry) { $out.Add($entry) }
            if ($out.Count -ge $Max) { return $out.ToArray() }
        }
    }
    return $out.ToArray()
}

function Get-SpoolfreeUserDefaultQueue {
    <# The user's current default queue name (HKCU ...\Windows\Device = "Name,winspool,Ne00:"). #>
    $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -Name Device -ErrorAction SilentlyContinue
    if (-not $v -or -not $v.Device) { return $null }
    $parts = ([string]$v.Device).Split(',')
    if ($parts.Count -ge 3) { return ($parts[0..($parts.Count - 3)] -join ',') }
    return $parts[0]
}

# ---------------------------------------------------------------------------
# Self-update (0.4.3+): signed agent bundle from /api/agent/bundle.
# Layout: <InstallDir>\Start-SpoolfreeSync.ps1 (launcher, installer-managed),
#         <InstallDir>\current (running version), \previous (rollback copy), \staging (transient).
# ---------------------------------------------------------------------------

$script:UpdateRegistry = 'HKLM:\SOFTWARE\Spoolfree\Update'
$script:BundleFiles = @('Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1', 'Install-SpoolfreeAgent.ps1')
$script:BundleRequired = @('Spoolfree.Agent.psm1', 'Invoke-SpoolfreeSync.ps1', 'Set-SpoolfreeUserDefault.ps1')
$script:BundleMaxBytes = 4MB
# May write to the install directory: SYSTEM, Administrators, TrustedInstaller, CREATOR OWNER (inherit-only).
$script:InstallWriters = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0')

function Get-SpoolfreeSha256 {
    <# Pure: lower-case hex SHA-256 of bytes. #>
    param([AllowEmptyCollection()][byte[]]$Bytes)
    if ($null -eq $Bytes) { $Bytes = [byte[]]@() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') })) } finally { $sha.Dispose() }
}

function ConvertTo-SpoolfreeVersion {
    <# Pure: 'x.y.z' -> [version]; anything else -> $null. #>
    param($Value)
    $s = [string]$Value
    if ($s -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { return $null }
    return [version]$s
}

function Get-SpoolfreeFileAgentVersion {
    <# The version a Spoolfree.Agent.psm1 declares ($script:AgentVersion = 'x.y.z'), from -Path or -Text; $null if none. #>
    param([string]$Path, [string]$Text)
    if ($Path) {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $Text = [IO.File]::ReadAllText($Path)
    }
    $m = [regex]::Match([string]$Text, '(?m)^\$script:AgentVersion\s*=\s*''(\d+\.\d+\.\d+)''')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Get-SpoolfreeUpdateDecision {
    <#
    .SYNOPSIS
        Pure: whether to install the agent the manifest offers. Action: none | update | skip, with Version and Reason.
        Never a downgrade unless the manifest sets agentAllowDowngrade = true; never a bundle that was rolled back here.
    #>
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$CurrentVersion,
        [string]$BadSha256
    )
    $target = [string](Get-SpoolfreeProperty $Manifest 'agentVersion')
    $bundle = Get-SpoolfreeProperty $Manifest 'agentBundle'
    $out = { param($a, $r) [pscustomobject]@{ Action = $a; Version = $target; Reason = $r } }
    if (-not $target -or $null -eq $bundle) { return (& $out 'none' 'the server offers no agent bundle') }
    $t = ConvertTo-SpoolfreeVersion $target
    if (-not $t) { return (& $out 'skip' "the server offers an invalid agent version '$target'") }
    $sha = ([string](Get-SpoolfreeProperty $bundle 'sha256')).ToLowerInvariant()
    if ($sha -notmatch '^[0-9a-f]{64}$') { return (& $out 'skip' 'the manifest has no valid bundle hash') }
    $c = ConvertTo-SpoolfreeVersion $CurrentVersion
    if ($c -and $t -eq $c) { return (& $out 'none' 'up to date') }
    $allow = Get-SpoolfreeProperty $Manifest 'agentAllowDowngrade'
    if ($c -and $t -lt $c -and -not ($allow -is [bool] -and $allow)) {
        return (& $out 'skip' "downgrade from $CurrentVersion to $target is not allowed")
    }
    if ($BadSha256 -and $sha -eq $BadSha256.ToLowerInvariant()) { return (& $out 'skip' "agent $target was rolled back on this PC") }
    return (& $out 'update' "agent $target is offered (this is $CurrentVersion)")
}

function Test-SpoolfreeAgentBundle {
    <#
    .SYNOPSIS
        Verifies a downloaded agent bundle and returns its files (ordered name -> bytes). Throws unless the SHA-256
        matches the signed manifest, the Ed25519 signature over the exact bytes verifies with the pinned key, and the
        content is a bundle of exactly the offered version with only known file names and matching file hashes.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Sha256,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Signature,
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][string]$Version
    )
    if ($Bytes.Length -eq 0 -or $Bytes.Length -gt $script:BundleMaxBytes) { throw "Agent bundle has a bad size ($($Bytes.Length) bytes)." }
    $hash = Get-SpoolfreeSha256 $Bytes
    if (-not $Sha256 -or $hash -ne $Sha256.ToLowerInvariant()) { throw "Agent bundle hash mismatch (got $hash, the manifest says '$Sha256'). Refusing to install it." }
    if (-not $Signature -or -not (Test-SpoolfreeSignature -PublicKey $PublicKey -Message $Bytes -Signature $Signature)) {
        throw 'Agent bundle signature is invalid. Refusing to install it.'
    }
    try { $b = [Text.Encoding]::UTF8.GetString($Bytes) | ConvertFrom-Json } catch { throw 'Agent bundle is not valid JSON.' }
    if ((Get-SpoolfreeProperty $b 'type') -ne 'spoolfree-agent-bundle' -or (Get-SpoolfreeProperty $b 'format') -ne 1) { throw 'Not a Spoolfree agent bundle.' }
    if ([string](Get-SpoolfreeProperty $b 'version') -ne $Version) { throw "Agent bundle is version '$(Get-SpoolfreeProperty $b 'version')', the manifest offers '$Version'." }
    $files = [ordered]@{}
    foreach ($f in @(Get-SpoolfreeProperty $b 'files')) {
        $name = [string](Get-SpoolfreeProperty $f 'name')
        if ($script:BundleFiles -cnotcontains $name) { throw "Unexpected file '$name' in the agent bundle." }
        if ($files.Contains($name)) { throw "Duplicate file '$name' in the agent bundle." }
        try { $content = [Convert]::FromBase64String([string](Get-SpoolfreeProperty $f 'content')) } catch { throw "Agent bundle file '$name' is not base64." }
        if ((Get-SpoolfreeSha256 $content) -ne ([string](Get-SpoolfreeProperty $f 'sha256')).ToLowerInvariant()) { throw "Agent bundle file '$name' does not match its hash." }
        $files[$name] = $content
    }
    foreach ($r in $script:BundleRequired) { if (-not $files.Contains($r)) { throw "Agent bundle lacks $r." } }
    $declared = Get-SpoolfreeFileAgentVersion -Text ([Text.Encoding]::UTF8.GetString($files['Spoolfree.Agent.psm1']))
    if ($declared -ne $Version) { throw "Agent bundle module declares version '$declared', not '$Version'." }
    return $files
}

function Test-SpoolfreeWriteRules {
    <# Pure: $true when no Allow rule grants write, delete or permission changes to anyone but SYSTEM, Administrators, TrustedInstaller or CREATOR OWNER. #>
    param([AllowEmptyCollection()]$Rules)
    $mask = [int64][Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
    $mask = $mask -bor 0x10000000 -bor 0x40000000   # GENERIC_ALL, GENERIC_WRITE (raw, inherit-only ACEs)
    foreach ($r in @($Rules)) {
        if ($null -eq $r) { continue }
        if ([string]$r.AccessControlType -ne 'Allow') { continue }
        if (([int64]$r.FileSystemRights -band $mask) -eq 0) { continue }
        $sid = try { $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$r.IdentityReference }
        if ($script:InstallWriters -notcontains $sid) { return $false }
    }
    return $true
}

function Test-SpoolfreeInstallAcl {
    <# $true when only SYSTEM/Administrators (and TrustedInstaller) can write to the directory or anything in it. #>
    param([Parameter(Mandatory)][string]$Path)
    $items = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue)
    foreach ($i in $items) {
        $rules = $i.GetAccessControl('Access').GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        if (-not (Test-SpoolfreeWriteRules @($rules))) { return $false }
    }
    return $true
}

function Set-SpoolfreeInstallAcl {
    <# Install directory: SYSTEM and Administrators full control, Users read and execute (the logon task runs as the user); not inherited. #>
    param([Parameter(Mandatory)][string]$Path)
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($e in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $id = New-Object System.Security.Principal.SecurityIdentifier $e[0]
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, $e[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    (Get-Item -LiteralPath $Path -Force).SetAccessControl($acl)
}

function Copy-SpoolfreeDirectoryAcl {
    <# Gives -To the DACL of -From (access rules and protection only; the owner is not touched). #>
    param([Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)
    $sddl = (Get-Item -LiteralPath $From -Force).GetAccessControl('Access').GetSecurityDescriptorSddlForm('Access')
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetSecurityDescriptorSddlForm($sddl, 'Access')
    (Get-Item -LiteralPath $To -Force).SetAccessControl($acl)
}

function Install-SpoolfreeAgentFiles {
    <#
    .SYNOPSIS
        Installs agent files atomically: writes them to <Root>\staging and checks them, then swaps folders
        (current -> previous, the rollback copy; staging -> current). The staged folder gets the DACL of the current
        one (or the default install ACL), and the swap is refused if anyone but SYSTEM/Administrators could write to
        it. If the second rename fails the first is undone. Returns the version that was replaced (or $null).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Files,
        [switch]$SkipAcl
    )
    $current = Join-Path $Root 'current'
    $staging = Join-Path $Root 'staging'
    $previous = Join-Path $Root 'previous'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        if (-not $SkipAcl) {
            if (Test-Path -LiteralPath $current) { Copy-SpoolfreeDirectoryAcl -From $current -To $staging } else { Set-SpoolfreeInstallAcl -Path $staging }
        }
        foreach ($name in @($Files.Keys)) {
            if ($script:BundleFiles -cnotcontains $name) { throw "Unexpected agent file '$name'." }
            $bytes = [byte[]]$Files[$name]
            $dst = Join-Path $staging $name
            [IO.File]::WriteAllBytes($dst, $bytes)
            if ((Get-SpoolfreeSha256 ([IO.File]::ReadAllBytes($dst))) -ne (Get-SpoolfreeSha256 $bytes)) { throw "Staged file '$name' does not match what was written." }
        }
        foreach ($r in $script:BundleRequired) { if (-not (Test-Path -LiteralPath (Join-Path $staging $r))) { throw "Agent files lack $r." } }
        if (-not $SkipAcl -and -not (Test-SpoolfreeInstallAcl -Path $staging)) {
            throw 'The install directory ACL lets accounts other than SYSTEM and Administrators write to it; not installing.'
        }
    } catch {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    $replaced = Get-SpoolfreeFileAgentVersion -Path (Join-Path $current 'Spoolfree.Agent.psm1')
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    $hadCurrent = Test-Path -LiteralPath $current
    if ($hadCurrent) { [IO.Directory]::Move($current, $previous) }
    try {
        [IO.Directory]::Move($staging, $current)
    } catch {
        if ($hadCurrent -and -not (Test-Path -LiteralPath $current)) { [IO.Directory]::Move($previous, $current) }
        throw "Swapping in the new agent failed: $($_.Exception.Message)"
    }
    return $replaced
}

function Get-SpoolfreeUpdateState {
    <# Self-update state (HKLM:\SOFTWARE\Spoolfree\Update), shared with the launcher. #>
    param([string]$Key = $script:UpdateRegistry)
    $s = [ordered]@{ PendingVersion = $null; PendingSha256 = $null; FromVersion = $null; Failures = 0; ConfirmedVersion = $null
        BadSha256 = $null; LastState = $null; LastVersion = $null; LastError = $null; LastAt = $null }
    if (Test-Path $Key) {
        $p = Get-ItemProperty -Path $Key
        foreach ($n in @($s.Keys)) { if ($p.PSObject.Properties[$n]) { $s[$n] = $p.$n } }
    }
    return [pscustomobject]$s
}

function Set-SpoolfreeUpdateState {
    <# Sets values ($null removes one). Integers are stored as DWORD. #>
    param([Parameter(Mandatory)][hashtable]$Values, [string]$Key = $script:UpdateRegistry)
    if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
    foreach ($n in @($Values.Keys)) {
        $v = $Values[$n]
        if ($null -eq $v) { Remove-ItemProperty -Path $Key -Name $n -ErrorAction SilentlyContinue }
        elseif ($v -is [int]) { New-ItemProperty -Path $Key -Name $n -Value $v -PropertyType DWord -Force | Out-Null }
        else { New-ItemProperty -Path $Key -Name $n -Value ([string]$v) -PropertyType String -Force | Out-Null }
    }
}

function Confirm-SpoolfreeAgentRun {
    <# Called by the sync once a manifest verified: tells the launcher that a just-installed version runs. #>
    param([string]$Key = $script:UpdateRegistry, [string]$Version = $script:AgentVersion)
    $s = Get-SpoolfreeUpdateState -Key $Key
    if ($s.PendingVersion -and $s.PendingVersion -eq $Version -and $s.ConfirmedVersion -ne $Version) {
        Set-SpoolfreeUpdateState -Key $Key -Values @{ ConfirmedVersion = $Version }
        return $true
    }
    return $false
}

function Get-SpoolfreeUpdateReport {
    <# The report's "update" field: state current | pending | updated | rolled-back | failed | skipped, target, error, at. #>
    param([string]$Key = $script:UpdateRegistry)
    $s = Get-SpoolfreeUpdateState -Key $Key
    $r = [ordered]@{ state = 'current' }
    if ($s.PendingVersion) { $r.state = 'pending'; $r['target'] = [string]$s.PendingVersion }
    elseif ($s.LastState) { $r.state = [string]$s.LastState; if ($s.LastVersion) { $r['target'] = [string]$s.LastVersion } }
    if ($s.LastError -and @('rolled-back', 'failed', 'skipped') -contains $r.state) {
        $e = [string]$s.LastError
        $r['error'] = $e.Substring(0, [Math]::Min(1000, $e.Length))
    }
    if ($s.LastAt) { $r['at'] = [string]$s.LastAt }
    return $r
}

function Get-SpoolfreeBundleBytes {
    <# Downloads the agent bundle with the machine token. #>
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    try {
        $wc.Headers['Authorization'] = "Bearer $Token"
        $wc.Headers['User-Agent'] = "Spoolfree-Agent/$script:AgentVersion"
        return , $wc.DownloadData($Uri)
    } finally { $wc.Dispose() }
}

function Invoke-SpoolfreeAgentUpdate {
    <#
    .SYNOPSIS
        Installs the agent version a verified manifest offers when it differs from this one: downloads the bundle
        (machine token), verifies it (Test-SpoolfreeAgentBundle), installs it (Install-SpoolfreeAgentFiles) and marks
        it pending; the launcher runs it at the next sync and rolls back if it fails twice. Returns a log line or
        $null when there is nothing to do; throws when the update failed (the state records it for the report).
    #>
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][string]$Root,
        [string]$Key = $script:UpdateRegistry,
        [string]$CurrentVersion = $script:AgentVersion,
        [scriptblock]$Download,
        [switch]$SkipAcl
    )
    $state = Get-SpoolfreeUpdateState -Key $Key
    $d = Get-SpoolfreeUpdateDecision -Manifest $Manifest -CurrentVersion $CurrentVersion -BadSha256 $state.BadSha256
    if ($d.Action -eq 'none') { return $null }
    $now = (Get-Date).ToUniversalTime().ToString('o')
    if ($d.Action -eq 'skip') {
        $keepRollback = $state.LastState -eq 'rolled-back' -and $state.LastVersion -eq $d.Version
        if (-not $keepRollback -and ($state.LastState -ne 'skipped' -or $state.LastError -ne $d.Reason)) {
            Set-SpoolfreeUpdateState -Key $Key -Values @{ LastState = 'skipped'; LastVersion = $d.Version; LastError = $d.Reason; LastAt = $now }
        }
        return "Agent update skipped: $($d.Reason)."
    }
    if ($state.PendingVersion) { return "Agent $($state.PendingVersion) is installed and waiting for its first run." }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'current'))) { return "Agent update skipped: $Root\current not found (re-run Install-SpoolfreeAgent.ps1)." }
    $bundle = Get-SpoolfreeProperty $Manifest 'agentBundle'
    try {
        $uri = "$($BaseUrl.TrimEnd('/'))/api/agent/bundle"
        $bytes = if ($Download) { & $Download $uri $Token } else { Get-SpoolfreeBundleBytes -Uri $uri -Token $Token }
        $files = Test-SpoolfreeAgentBundle -Bytes ([byte[]]$bytes) -Sha256 ([string](Get-SpoolfreeProperty $bundle 'sha256')) `
            -Signature ([string](Get-SpoolfreeProperty $bundle 'signature')) -PublicKey $PublicKey -Version $d.Version
        # Pending before the swap: the launcher forgets it if the swap did not happen (current is not this version).
        Set-SpoolfreeUpdateState -Key $Key -Values @{ PendingVersion = $d.Version; PendingSha256 = (Get-SpoolfreeSha256 ([byte[]]$bytes))
            FromVersion = $CurrentVersion; Failures = 0; ConfirmedVersion = $null; LastAt = $now }
        try {
            Install-SpoolfreeAgentFiles -Root $Root -Files $files -SkipAcl:$SkipAcl | Out-Null
        } catch {
            Set-SpoolfreeUpdateState -Key $Key -Values @{ PendingVersion = $null; PendingSha256 = $null; FromVersion = $null; Failures = $null }
            throw
        }
        return "Agent $($d.Version) installed (was $CurrentVersion); it runs at the next sync."
    } catch {
        $msg = $_.Exception.Message
        Set-SpoolfreeUpdateState -Key $Key -Values @{ LastState = 'failed'; LastVersion = $d.Version; LastError = $msg; LastAt = $now }
        throw "Agent update to $($d.Version) failed: $msg"
    }
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
