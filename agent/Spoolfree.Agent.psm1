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

$script:AgentVersion = '0.8.1'
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
        [AllowNull()][string]$DefaultPrinter,
        # $false under Windows Protected Print Mode: vendor-driver printers are planned as driverless.
        [bool]$VendorAllowed = $true,
        # 0.7.7: names of this agent's queues made by the old fallback (IPP Class Driver on a RAW port): re-created.
        [AllowEmptyCollection()][string[]]$Migrate = @()
    )
    $actions = New-Object System.Collections.Generic.List[object]
    $migrateSet = @{}
    foreach ($m in $Migrate) { if ($m) { $migrateSet[$m.ToLowerInvariant()] = $true } }
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
        $target = Get-SpoolfreeQueueTarget $d -VendorAllowed $VendorAllowed
        if ($null -eq $mine) {
            if ($existingSet.ContainsKey($key)) {
                # A queue with this name exists but we did not create it: never touch it.
                $actions.Add([pscustomobject]@{ Action = 'Conflict'; Name = $d.name; Printer = $d })
            } else {
                $actions.Add([pscustomobject]@{ Action = 'Add'; Name = $d.name; Printer = $d })
            }
        } elseif ([int]$mine.Revision -ne [int]$d.revision -or [string]$mine.Url -ne $target -or -not $existingSet.ContainsKey($key) -or $migrateSet.ContainsKey($key)) {
            # 0.7: a switch to or from a vendor-driver queue creates the new queue first (a TCP/IP queue can exist next
            # to the IPP queue of the same device), so the PC is never without the printer meanwhile. 0.7.7: so does
            # replacing an old-fallback queue (IPP Class Driver on a RAW port).
            $mbb = $existingSet.ContainsKey($key) -and ((Test-SpoolfreeVendorTarget ([string]$mine.Url)) -or (Test-SpoolfreeVendorTarget $target) -or $migrateSet.ContainsKey($key))
            $actions.Add([pscustomobject]@{ Action = 'Replace'; Name = $d.name; Printer = $d; MakeBeforeBreak = $mbb })
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

function ConvertTo-SpoolfreeAliasKey {
    <# Pure: a host name for legacy-alias comparison: trimmed, lower-case, without a trailing dot or ".local". #>
    param([AllowNull()][AllowEmptyString()][string]$HostName)
    if (-not $HostName) { return $null }
    $h = $HostName.Trim().ToLowerInvariant().TrimEnd('.')
    if ($h.EndsWith('.local')) { $h = $h.Substring(0, $h.Length - 6).TrimEnd('.') }
    if (-not $h) { return $null }
    return $h
}

function Get-SpoolfreeLegacyAliases {
    <# Pure: the printer's legacyAliases (manifest 0.5.0+) as alias keys; empty when absent. #>
    param($Printer)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($a in @(Get-SpoolfreeProperty $Printer 'legacyAliases')) {
        $k = ConvertTo-SpoolfreeAliasKey ([string]$a)
        if ($k -and -not $out.Contains($k)) { $out.Add($k) }
    }
    return $out.ToArray()
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
    $aliases = @(Get-SpoolfreeLegacyAliases $Printer)

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
        if ($addr.Count -eq 0 -and -not $deviceUuid -and $macs.Count -eq 0 -and $aliases.Count -eq 0) { continue }

        $portName = [string](Get-SpoolfreeProperty $q 'PortName')
        $port = if ($portName -and $Ports.ContainsKey($portName)) { $Ports[$portName] } else { $null }
        if (Test-SpoolfreeVirtualQueue -Queue $q -Port $port) { continue }

        $rawHostAddress = ([string](Get-SpoolfreeProperty $port 'HostAddress')).Trim()
        $hostAddress = $rawHostAddress.ToLowerInvariant()
        $candidates = New-Object System.Collections.Generic.List[string]
        foreach ($a in @(Get-SpoolfreeProperty $port 'Addresses')) { if ($a) { $candidates.Add(([string]$a).ToLowerInvariant()) } }
        $monitor = [string](Get-SpoolfreeProperty $port 'Monitor')
        $description = [string](Get-SpoolfreeProperty $port 'Description')
        $urlHost = Get-SpoolfreeUrlHost $portName
        if (-not $urlHost) { $urlHost = Get-SpoolfreeUrlHost $hostAddress }

        $kind = $null; $label = $null; $hostName = $null; $displayHost = $null
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
            $kind = 'IPP port'; $label = $urlHost; $hostName = $urlHost; $displayHost = $urlHost; $candidates.Add($urlHost)
        } elseif ($hostAddress -or $monitor -eq 'Standard TCP/IP Port') {
            $kind = 'TCP/IP port'; $label = $hostAddress; $hostName = $hostAddress; $displayHost = $rawHostAddress
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
            continue
        }
        # Old host names the server lists for this printer (manifest legacyAliases), e.g. a NetBIOS-style name
        # that is not in DNS. Compared case-insensitively, ignoring ".local" and a trailing dot on both sides.
        $aliasKey = ConvertTo-SpoolfreeAliasKey $hostName
        if ($aliasKey -and $aliases -contains $aliasKey) {
            $out.Add([pscustomobject]@{ Queue = $name; Reason = "$prefix$kind host $displayHost is a legacy alias"; Kind = $kind })
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

function Get-SpoolfreeTakeoverPrinters {
    <#
    .SYNOPSIS
        Pure: lower-case names of the printers takeover removed a legacy queue for on this PC (published removed map
        of earlier syncs and this sync's removals), as a hashtable name -> $true. The removed map comes back from JSON
        as a PSCustomObject, or as a hashtable; both are read by entry (0.6.3: 0.6.2 read the properties of the
        wrapping array instead, so dry-run PCs never got the recovery).
    #>
    param($RemovedMap, $Removed)
    $out = @{}
    foreach ($m in @($RemovedMap, $Removed)) {
        if ($null -eq $m) { continue }
        $values = if ($m -is [System.Collections.IDictionary]) { @($m.Values) } else { @($m.PSObject.Properties | ForEach-Object { $_.Value }) }
        foreach ($v in $values) { if ($v) { $out[([string]$v).ToLowerInvariant()] = $true } }
    }
    return $out
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
        $auto = if ($p.PSObject.Properties['AutoDuplex']) { [string]$p.AutoDuplex } else { '' }
        $tried = if ($p.PSObject.Properties['MigrateTried']) { [string]$p.MigrateTried } else { '' }
        $vf = if ($p.PSObject.Properties['VendorFallback']) { [string]$p.VendorFallback } else { '' }
        [pscustomobject]@{ Name = $p.Name; Id = $p.Id; Revision = [int]$p.Revision; Url = $p.Url; Method = $p.Method; PortName = $p.PortName; Sides = $sides; AutoDuplex = $auto; MigrateTried = $tried; VendorFallback = $vf }
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
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)][string]$Method, [string]$PortName = '', [string]$ServerId = '', [string]$Target = '')
    if (-not $Target) { $Target = [string]$Printer.ippUrl }
    $key = Get-SpoolfreeMarkerKey -Name $Printer.name
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name Name -Value $Printer.name -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Id -Value $Printer.id -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Revision -Value ([int]$Printer.revision) -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name Url -Value $Target -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Method -Value $Method -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name PortName -Value $PortName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Server -Value $ServerId -PropertyType String -Force | Out-Null
    # 0.7.7: a (re)created queue starts without these (0.8.1: and without VendorFallback; the caller sets it).
    Remove-ItemProperty -Path $key -Name AutoDuplex, MigrateTried, VendorFallback -ErrorAction SilentlyContinue
}

function Set-SpoolfreeMarkerValue {
    <# 0.7.7: one string value on an existing marker (AutoDuplex, MigrateTried, VendorFallback). #>
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Property, [AllowEmptyString()][string]$Value)
    $key = Get-SpoolfreeMarkerKey -Name $Name
    if (Test-Path $key) { New-ItemProperty -Path $key -Name $Property -Value $Value -PropertyType String -Force | Out-Null }
}

function Set-SpoolfreeMarkerSides {
    <# Records the duplex default last applied to a queue (so it is re-applied only when the manifest changes). #>
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Sides)
    $key = Get-SpoolfreeMarkerKey -Name $Name
    if (Test-Path $key) { New-ItemProperty -Path $key -Name Sides -Value $Sides -PropertyType String -Force | Out-Null }
}

$script:LegacyDriverRegistry = 'HKLM:\SOFTWARE\Spoolfree\LegacyDrivers'

function Get-SpoolfreeLegacyDriverChoice {
    <#
    .SYNOPSIS
        Pure: the driver worth remembering from the legacy queues takeover removes for one printer (for the TCP/IP
        fallback, 0.6.2): the first real model driver; never the IPP class driver, Microsoft's generic drivers or
        a driver of a print-server connection (those are not installed locally).
    .PARAMETER Queues
        Objects with Name, DriverName and Type.
    #>
    param([AllowEmptyCollection()][object[]]$Queues = @())
    foreach ($q in @($Queues)) {
        $d = [string](Get-SpoolfreeProperty $q 'DriverName')
        if (-not $d) { continue }
        if ([string](Get-SpoolfreeProperty $q 'Type') -eq 'Connection' -or ([string](Get-SpoolfreeProperty $q 'Name')).StartsWith('\\')) { continue }
        if ($d -eq $script:IppDriver -or $d -match '^Microsoft |Generic|Mopria') { continue }
        return $d
    }
    return $null
}

function Get-SpoolfreeLegacyDriver {
    <# The remembered driver of a printer's removed legacy queue (Set-SpoolfreeLegacyDriver), or $null. #>
    param([Parameter(Mandatory)][string]$Printer)
    $v = Get-ItemProperty -Path $script:LegacyDriverRegistry -Name $Printer -ErrorAction SilentlyContinue
    if ($v) { return [string]$v.$Printer }
    return $null
}

function Set-SpoolfreeLegacyDriver {
    param([Parameter(Mandatory)][string]$Printer, [Parameter(Mandatory)][string]$Driver)
    if (-not (Test-Path $script:LegacyDriverRegistry)) { New-Item -Path $script:LegacyDriverRegistry -Force | Out-Null }
    New-ItemProperty -Path $script:LegacyDriverRegistry -Name $Printer -Value $Driver -PropertyType String -Force | Out-Null
}

function Remove-SpoolfreeMarker {
    param([Parameter(Mandatory)][string]$Name)
    $key = Get-SpoolfreeMarkerKey -Name $Name
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
}

# ---------------------------------------------------------------------------
# Vendor drivers (agents 0.7+). A manifest printer with driverMode "vendor" carries
#   driver = { packageId, packageName, sha256, size, url, driverName, inf, catalog, protocol, lprQueue }
# The agent downloads the package with its machine token, checks SHA-256 and size against the signed manifest,
# extracts it to a SYSTEM-only directory, requires a Valid Authenticode signature on the INF's catalog, stages the
# driver with pnputil, adds it with Add-PrinterDriver and creates the queue on a Standard TCP/IP (RAW 9100 / LPR)
# or IPP port. Under Windows Protected Print Mode vendor drivers are not allowed: the printer stays driverless.
# ---------------------------------------------------------------------------

$script:DriverRegistry = 'HKLM:\SOFTWARE\Spoolfree\Drivers'
$script:VendorProtocols = @('raw9100', 'lpr', 'ipp')
$script:DriverPackageMaxBytes = 1GB

function Test-SpoolfreeZipEntryPath {
    <# Pure: $true when a zip entry path stays inside the extraction directory (no absolute path, drive, ".."). #>
    param([AllowNull()][AllowEmptyString()][string]$Path)
    if (-not $Path) { return $false }
    $p = $Path -replace '\\', '/'
    if ($p.StartsWith('/') -or $p -match '^[A-Za-z]:' -or $p.Contains([string][char]0)) { return $false }
    $segs = $p.Split('/')
    for ($i = 0; $i -lt $segs.Count; $i++) {
        if ($segs[$i] -eq '..') { return $false }
        if ($segs[$i] -eq '' -and $i -ne $segs.Count - 1) { return $false }
    }
    return $true
}

function ConvertTo-SpoolfreeVendorDriver {
    <#
    .SYNOPSIS
        Pure: a manifest driver entry ({ packageId, packageName, sha256, size, url, driverName, inf, catalog, protocol,
        lprQueue }) as an object (PackageId, PackageName, Sha256, Size, Url, DriverName, Inf, Catalog, Protocol,
        LprQueue), or $null when the entry is missing or not valid.
    #>
    param($Driver)
    $d = $Driver
    if ($null -eq $d) { return $null }
    $sha = ([string](Get-SpoolfreeProperty $d 'sha256')).ToLowerInvariant()
    $name = [string](Get-SpoolfreeProperty $d 'driverName')
    $inf = [string](Get-SpoolfreeProperty $d 'inf')
    $cat = [string](Get-SpoolfreeProperty $d 'catalog')
    $url = [string](Get-SpoolfreeProperty $d 'url')
    $proto = [string](Get-SpoolfreeProperty $d 'protocol')
    if (-not $proto) { $proto = 'raw9100' }
    if ($sha -notmatch '^[0-9a-f]{64}$' -or -not $name -or $script:VendorProtocols -notcontains $proto) { return $null }
    if (-not (Test-SpoolfreeZipEntryPath $inf) -or -not (Test-SpoolfreeZipEntryPath $cat) -or $inf -notmatch '\.inf$' -or $cat -notmatch '\.cat$') { return $null }
    if ($url -notmatch '^/api/agent/drivers/[0-9a-fA-F-]{36}$') { return $null }
    $lpr = [string](Get-SpoolfreeProperty $d 'lprQueue')
    if (-not $lpr) { $lpr = 'lp' }
    $size = 0L
    [void][long]::TryParse([string](Get-SpoolfreeProperty $d 'size'), [ref]$size)
    return [pscustomobject]@{
        PackageId   = [string](Get-SpoolfreeProperty $d 'packageId')
        PackageName = [string](Get-SpoolfreeProperty $d 'packageName')
        Sha256      = $sha
        Size        = $size
        Url         = $url
        DriverName  = $name
        Inf         = $inf
        Catalog     = $cat
        Protocol    = $proto
        LprQueue    = $lpr
    }
}

function Get-SpoolfreeVendorDriver {
    <#
    .SYNOPSIS
        Pure: the manifest printer's vendor driver as an object (see ConvertTo-SpoolfreeVendorDriver), or $null when
        the printer is driverless or the entry is not valid.
    #>
    param($Printer)
    if ([string](Get-SpoolfreeProperty $Printer 'driverMode') -ne 'vendor') { return $null }
    return (ConvertTo-SpoolfreeVendorDriver (Get-SpoolfreeProperty $Printer 'driver'))
}

# ---------------------------------------------------------------------------
# Per-PC vendor fallback (0.8.1). A driverless printer may carry fallbackDriver (same shape as driver): the package the
# server matched to the printer's model (exact, or a universal package whose INF lists it). A PC where Add-Printer
# -IppURL fails for the printer creates a queue with that vendor driver instead, on that PC only; its marker records
# VendorFallback (the package name), so later syncs keep that queue. PCs where driverless works stay driverless.
# ---------------------------------------------------------------------------

function Get-SpoolfreeFallbackDriver {
    <# Pure: the vendor fallback driver of a driverless manifest printer (fallbackDriver), or $null. #>
    param($Printer)
    if ([string](Get-SpoolfreeProperty $Printer 'driverMode') -eq 'vendor') { return $null }
    return (ConvertTo-SpoolfreeVendorDriver (Get-SpoolfreeProperty $Printer 'fallbackDriver'))
}

function ConvertTo-SpoolfreeFallbackPrinter {
    <#
    .SYNOPSIS
        Pure: a copy of a driverless manifest printer that uses its fallbackDriver as the vendor driver (driverMode
        "vendor", driver = fallbackDriver, vendorFallback = $true), so the vendor code paths (target, queue, port)
        apply on this PC. $null when the printer has no valid fallbackDriver.
    #>
    param($Printer)
    if (-not (Get-SpoolfreeFallbackDriver $Printer)) { return $null }
    $c = [pscustomobject]@{}
    foreach ($p in $Printer.PSObject.Properties) { $c | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force }
    $c | Add-Member -NotePropertyName driverMode -NotePropertyValue 'vendor' -Force
    $c | Add-Member -NotePropertyName driver -NotePropertyValue (Get-SpoolfreeProperty $Printer 'fallbackDriver') -Force
    $c | Add-Member -NotePropertyName vendorFallback -NotePropertyValue $true -Force
    return $c
}

function Get-SpoolfreeEffectivePrinter {
    <#
    .SYNOPSIS
        Pure: the printer as this PC should have it. A driverless printer whose queue here is a vendor fallback (marker
        VendorFallback) keeps the vendor driver while the manifest still offers a fallbackDriver and vendor drivers are
        allowed (a new package re-creates the queue, make-before-break). Everything else is the manifest printer.
    #>
    param($Printer, $Marker, [bool]$VendorAllowed = $true)
    if (-not $VendorAllowed -or $null -eq $Marker -or -not [string](Get-SpoolfreeProperty $Marker 'VendorFallback')) { return $Printer }
    $fp = ConvertTo-SpoolfreeFallbackPrinter $Printer
    if ($fp) { return $fp }
    return $Printer
}

function Test-SpoolfreeVendorFallbackPrinter {
    <# Pure: is this (effective) printer a vendor fallback copy? #>
    param($Printer)
    return [bool](Get-SpoolfreeProperty $Printer 'vendorFallback')
}

function Get-SpoolfreeQueueTarget {
    <#
    .SYNOPSIS
        Pure: what the queue for a printer must be, recorded in the agent's marker (Url). Driverless: the IPP URL (as
        before 0.7, so existing queues are kept). Vendor: "vendor:<protocol>|<address>|<driver name>|<package sha256>",
        so a new package, driver or port re-creates the queue. -VendorAllowed $false (Windows Protected Print Mode)
        gives the driverless target.
    #>
    param($Printer, [bool]$VendorAllowed = $true)
    $ipp = [string](Get-SpoolfreeProperty $Printer 'ippUrl')
    $v = Get-SpoolfreeVendorDriver $Printer
    if (-not $v -or -not $VendorAllowed) { return $ipp }
    $h = [string](Get-SpoolfreeProperty $Printer 'host')
    $addr = switch ($v.Protocol) { 'raw9100' { "${h}:9100" } 'lpr' { "$h/$($v.LprQueue)" } default { $ipp } }
    return ('vendor:{0}|{1}|{2}|{3}' -f $v.Protocol, $addr, $v.DriverName, $v.Sha256)
}

function Test-SpoolfreeVendorTarget {
    <# Pure: is a marker target a vendor-driver queue? #>
    param([AllowNull()][AllowEmptyString()][string]$Target)
    return ([string]$Target).StartsWith('vendor:')
}

function Get-SpoolfreeVendorPortName {
    <# Pure: the port a vendor queue uses: SPOOLFREE_<host> (RAW 9100), SPOOLFREE_LPR_<host>_<queue>, or the IPP URL. #>
    param([Parameter(Mandatory)]$Printer, [Parameter(Mandatory)]$Vendor)
    $h = ([string](Get-SpoolfreeProperty $Printer 'host')) -replace '[^A-Za-z0-9\.\-]', '_'
    switch ($Vendor.Protocol) {
        'raw9100' { return "SPOOLFREE_$h" }
        'lpr' { return ('SPOOLFREE_LPR_{0}_{1}' -f $h, ($Vendor.LprQueue -replace '[^A-Za-z0-9\.\-]', '_')) }
        default { return [string](Get-SpoolfreeProperty $Printer 'ippUrl') }
    }
}

function Get-SpoolfreeInfCatalog {
    <# Pure: the CatalogFile an INF's [Version] names (CatalogFile.NTamd64 first), or $null. #>
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if (-not $Text) { return $null }
    $inVersion = $false
    $plain = $null; $amd64 = $null
    foreach ($raw in ($Text -split "`r?`n")) {
        $line = ($raw -replace ';.*$', '').Trim()
        if (-not $line) { continue }
        if ($line -match '^\[(.+)\]$') { $inVersion = ($Matches[1].Trim() -ieq 'Version'); continue }
        if (-not $inVersion) { continue }
        if ($line -match '^(?i)CatalogFile\.NTamd64\s*=\s*"?([^"]+?)"?$') { $amd64 = $Matches[1].Trim() }
        elseif ($line -match '^(?i)CatalogFile\s*=\s*"?([^"]+?)"?$') { $plain = $Matches[1].Trim() }
    }
    if ($amd64) { return $amd64 }
    return $plain
}

function Get-SpoolfreeDriverState {
    <# The driver package this agent installed with that SHA-256 (registry), or $null. #>
    param([Parameter(Mandatory)][string]$Sha256)
    $key = Join-Path $script:DriverRegistry $Sha256.ToLowerInvariant()
    if (-not (Test-Path $key)) { return $null }
    # StrictMode-safe: a key without values (an interrupted earlier install) reads as "no driver names".
    $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        DriverNames = @(Get-SpoolfreeProperty $p 'DriverNames' | Where-Object { $_ } | ForEach-Object { [string]$_ })
        InstalledAt = [string](Get-SpoolfreeProperty $p 'InstalledAt')
        Signer      = [string](Get-SpoolfreeProperty $p 'Signer')
    }
}

function Set-SpoolfreeDriverState {
    param([Parameter(Mandatory)][string]$Sha256, [Parameter(Mandatory)][string]$DriverName, [string]$Signer = '', [string]$Package = '')
    $key = Join-Path $script:DriverRegistry $Sha256.ToLowerInvariant()
    $before = Get-SpoolfreeDriverState -Sha256 $Sha256
    $names = @(@(if ($before) { $before.DriverNames }) + @($DriverName) | Where-Object { $_ } | Select-Object -Unique)
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name DriverNames -Value ([string[]]$names) -PropertyType MultiString -Force | Out-Null
    New-ItemProperty -Path $key -Name InstalledAt -Value ([datetime]::UtcNow.ToString('o')) -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Signer -Value $Signer -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name Package -Value $Package -PropertyType String -Force | Out-Null
}

function New-SpoolfreeSystemDirectory {
    <# Creates a directory only SYSTEM can access (protected ACL, inherited by everything below it). #>
    param([Parameter(Mandatory)][string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $system = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
    $acl.SetOwner($system)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
    return $Path
}

function Save-SpoolfreeDownload {
    <# Downloads a URL with the machine token to a file. #>
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$Path)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    try {
        $wc.Headers['Authorization'] = "Bearer $Token"
        $wc.Headers['User-Agent'] = "Spoolfree-Agent/$script:AgentVersion"
        $wc.DownloadFile($Uri, $Path)
    } finally { $wc.Dispose() }
}

function Expand-SpoolfreeZip {
    <# Extracts a zip, refusing entries that would leave the destination or a total size above the limit. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $total = 0L
        foreach ($e in $zip.Entries) { $total += $e.Length }
        if ($total -gt $script:DriverPackageMaxBytes) { throw "The driver package expands to more than $($script:DriverPackageMaxBytes / 1GB) GB." }
        foreach ($e in $zip.Entries) {
            if (-not (Test-SpoolfreeZipEntryPath $e.FullName)) { throw "Unsafe path in the driver package: $($e.FullName)" }
            $target = [IO.Path]::GetFullPath((Join-Path $root ($e.FullName -replace '/', '\')))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path in the driver package: $($e.FullName)" }
            if ($e.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
            $dir = Split-Path $target -Parent
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
        }
    } finally { $zip.Dispose() }
}

function Invoke-SpoolfreePnpUtil {
    <# pnputil /add-driver <inf> /install: stages the driver package in the driver store. Returns Code and Output. #>
    param([Parameter(Mandatory)][string]$Inf)
    $out = & pnputil.exe /add-driver "$Inf" /install 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ((($out | Out-String).Trim()) -replace '\s+', ' ') }
}

function Install-SpoolfreeVendorDriver {
    <#
    .SYNOPSIS
        Makes the vendor driver available: 'present' when this package's driver is already installed by this agent,
        else downloads, verifies (SHA-256 + size from the signed manifest, catalog named by the INF, Authenticode
        status Valid), stages with pnputil /add-driver /install and runs Add-PrinterDriver. Returns 'installed'.
        Throws on any failure; the staging directory is always removed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Vendor, [Parameter(Mandatory)][string]$BaseUrl, [Parameter(Mandatory)][string]$Token)
    $state = Get-SpoolfreeDriverState -Sha256 $Vendor.Sha256
    if ($state -and (@($state.DriverNames) -contains $Vendor.DriverName) -and (Get-PrinterDriver -Name $Vendor.DriverName -ErrorAction SilentlyContinue)) { return 'present' }
    $staging = Join-Path $env:ProgramData 'Spoolfree\DriverStaging'
    if (-not (Test-Path $staging)) { New-SpoolfreeSystemDirectory -Path $staging | Out-Null }
    $work = New-SpoolfreeSystemDirectory -Path (Join-Path $staging ([guid]::NewGuid().ToString('N')))
    try {
        $zip = Join-Path $work 'package.zip'
        Save-SpoolfreeDownload -Uri ($BaseUrl.TrimEnd('/') + $Vendor.Url) -Token $Token -Path $zip
        $len = (Get-Item -LiteralPath $zip).Length
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
        if ($hash -ne $Vendor.Sha256 -or ($Vendor.Size -gt 0 -and $len -ne $Vendor.Size)) {
            throw "Driver package '$($Vendor.PackageName)' does not match the signed manifest (SHA-256 $hash, $len bytes); refusing it."
        }
        $dir = Join-Path $work 'x'
        Expand-SpoolfreeZip -Path $zip -Destination $dir
        $inf = Join-Path $dir ($Vendor.Inf -replace '/', '\')
        $cat = Join-Path $dir ($Vendor.Catalog -replace '/', '\')
        if (-not (Test-Path -LiteralPath $inf -PathType Leaf)) { throw "The driver package has no $($Vendor.Inf)." }
        if (-not (Test-Path -LiteralPath $cat -PathType Leaf)) { throw "The driver package has no $($Vendor.Catalog)." }
        $named = Get-SpoolfreeInfCatalog -Text (Get-Content -LiteralPath $inf -Raw)
        if (-not $named -or (Split-Path $named -Leaf) -ne (Split-Path $cat -Leaf)) { throw "$($Vendor.Inf) does not name the catalog $($Vendor.Catalog) (CatalogFile: '$named')." }
        $sig = Get-AuthenticodeSignature -LiteralPath $cat
        if ([string]$sig.Status -ne 'Valid') { throw "Catalog $($Vendor.Catalog) signature is $($sig.Status) ($($sig.StatusMessage)); refusing the driver." }
        $signer = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }
        $pnp = Invoke-SpoolfreePnpUtil -Inf $inf
        # 259: staged, no device to install it on (printers have none); 3010: reboot required (not needed for printing).
        if (@(0, 259, 3010) -notcontains $pnp.Code) { throw "pnputil /add-driver failed (exit $($pnp.Code)): $($pnp.Output)" }
        Add-PrinterDriver -Name $Vendor.DriverName -ErrorAction Stop
        Set-SpoolfreeDriverState -Sha256 $Vendor.Sha256 -DriverName $Vendor.DriverName -Signer $signer -Package $Vendor.PackageName
        return 'installed'
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function New-SpoolfreeVendorQueue {
    <# Creates a queue with the (installed) vendor driver on its port. Returns the port name. #>
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)]$Vendor,
        [Parameter(Mandatory)][string]$QueueName,
        [Parameter(Mandatory)][string]$Comment,
        [AllowEmptyString()][string]$Location = ''
    )
    $port = Get-SpoolfreeVendorPortName -Printer $Printer -Vendor $Vendor
    $h = [string](Get-SpoolfreeProperty $Printer 'host')
    switch ($Vendor.Protocol) {
        'raw9100' {
            if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port -PrinterHostAddress $h -PortNumber 9100 -ErrorAction Stop }
            Add-Printer -Name $QueueName -DriverName $Vendor.DriverName -PortName $port -Comment $Comment -Location $Location -ErrorAction Stop
        }
        'lpr' {
            if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port -LprHostAddress $h -LprQueueName $Vendor.LprQueue -LprByteCounting -ErrorAction Stop }
            Add-Printer -Name $QueueName -DriverName $Vendor.DriverName -PortName $port -Comment $Comment -Location $Location -ErrorAction Stop
        }
        'ipp' {
            # Internet Port (IPP over HTTP) with the vendor driver: printui creates the port for an http(s) URL.
            # 0.8.1: the names go through Invoke-SpoolfreePrintUi, which refuses quotes and control characters.
            Invoke-SpoolfreePrintUi -Arguments @('/if', '/b', $QueueName, '/r', $port, '/m', $Vendor.DriverName, '/u', '/Z', '/q') | Out-Null
            for ($i = 0; $i -lt 20 -and -not (Get-SpoolfreeQueueByName -Name $QueueName); $i++) { Start-Sleep -Milliseconds 500 }
            if (-not (Get-SpoolfreeQueueByName -Name $QueueName)) { throw "Could not create the IPP (Internet Port) queue $QueueName for $port." }
            Set-Printer -Name $QueueName -Comment $Comment -Location $Location -ErrorAction Stop
        }
    }
    return $port
}

function Test-SpoolfreeSafeName {
    <# Pure: $true when a queue, port or driver name has no double quote and no control character (0.8.1). #>
    param([AllowNull()][AllowEmptyString()][string]$Name)
    if (-not $Name) { return $false }
    return -not ($Name -match '["\x00-\x1f\x7f]')
}

function ConvertTo-SpoolfreePrintUiArguments {
    <#
    .SYNOPSIS
        Pure: the rundll32 command line for printui.dll,PrintUIEntry with these arguments. Switches (/x) go as they
        are; every other argument is quoted. rundll32 splits the command line itself, so an argument with a double
        quote or a control character could add switches (L1, 0.8.1): such a name is refused (throws), never escaped.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments)
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add('printui.dll,PrintUIEntry')
    foreach ($a in $Arguments) {
        if ($a -match '^/[A-Za-z0-9@]{1,3}$') { $parts.Add($a); continue }
        if (-not (Test-SpoolfreeSafeName $a)) { throw "Refusing to pass '$($a -replace '[\x00-\x1f\x7f]', '?')' to printui: names with a double quote or a control character are not allowed." }
        $parts.Add('"' + $a + '"')
    }
    return ($parts -join ' ')
}

function Invoke-SpoolfreePrintUi {
    <# Runs rundll32 printui.dll,PrintUIEntry with checked, quoted arguments (no shell); returns the exit code. #>
    param([Parameter(Mandatory)][string[]]$Arguments, [int]$TimeoutSeconds = 120)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\rundll32.exe'
    $psi.Arguments = ConvertTo-SpoolfreePrintUiArguments -Arguments $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    try {
        if (-not $p.WaitForExit($TimeoutSeconds * 1000)) { try { $p.Kill() } catch { }; throw "printui did not finish within $TimeoutSeconds s." }
        return $p.ExitCode
    } finally { $p.Dispose() }
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
    # 0.7.7: no TCP/IP + IPP Class Driver queue any more (its raster on a RAW 9100 port prints as pages of text on
    # printers without PWG raster). Without -IppURL a printer needs a vendor driver.
    return 'Unsupported'
}

function Test-SpoolfreeClassOnRawQueue {
    <# Pure: is this an agent queue made by the pre-0.7.7 fallback, the IPP Class Driver on a Standard TCP/IP port? #>
    param([AllowNull()][AllowEmptyString()][string]$Method, [AllowNull()][AllowEmptyString()][string]$DriverName)
    return ($Method -eq 'TcpIpPort' -and $DriverName -eq $script:IppDriver)
}

function Test-SpoolfreeMigrateDue {
    <# Pure: retry re-creating an old-fallback queue? Not within $Hours of the last failed try (-IppURL can take 90 s). #>
    param([AllowNull()][AllowEmptyString()][string]$LastTried, [datetime]$Now = (Get-Date).ToUniversalTime(), [int]$Hours = 24)
    if (-not $LastTried) { return $true }
    $t = [datetime]::MinValue
    if (-not [datetime]::TryParse($LastTried, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]'AdjustToUniversal,AssumeUniversal', [ref]$t)) { return $true }
    return (($Now - $t).TotalHours -ge $Hours)
}

function Get-SpoolfreeAutoDuplexTicket {
    <#
    .SYNOPSIS
        Pure (0.7.7): a print ticket that selects the driver's automatic two-sided printing, or $null when the driver
        has no automatic two-sided option. Some vendor drivers (Brother v3, e.g. HL-5350DN) offer two-sided printing
        both with the duplex unit ("Automatic") and by hand ("Manual") and start in manual mode: users are then asked
        to turn the pages over. Selecting the automatic option once stores it in the driver's settings; the caller
        then sets the wanted default (one- or two-sided) again.
    #>
    param([AllowNull()][AllowEmptyString()][string]$CapabilitiesXml, [AllowNull()][AllowEmptyString()][string]$TicketXml)
    if (-not $CapabilitiesXml -or -not $TicketXml) { return $null }
    $feature = [regex]::Match($CapabilitiesXml, '<psf:Feature name="psk:JobDuplexAllDocumentsContiguously">.*?</psf:Feature>', 'Singleline').Value
    if (-not $feature) { return $null }
    $opt = [regex]::Match($feature, '<psf:Option name="psk:TwoSidedLongEdge"[^>]*>(?:(?!</psf:Option>).)*?<psf:ScoredProperty name="psk:DuplexMode">\s*<psf:Value xsi:type="xsd:string">Automatic</psf:Value>', 'Singleline,IgnoreCase')
    if (-not $opt.Success) { return $null }
    $new = '<psf:Feature name="psk:JobDuplexAllDocumentsContiguously"><psf:Option name="psk:TwoSidedLongEdge"><psf:ScoredProperty name="psk:DuplexMode"><psf:Value xsi:type="xsd:string">Automatic</psf:Value></psf:ScoredProperty></psf:Option></psf:Feature>'
    $rx = '<psf:Feature name="psk:JobDuplexAllDocumentsContiguously">.*?</psf:Feature>'
    if ([regex]::IsMatch($TicketXml, $rx, 'Singleline')) { return [regex]::Replace($TicketXml, $rx, $new, 'Singleline') }
    if ($TicketXml -match '</psf:PrintTicket>') { return $TicketXml -replace '</psf:PrintTicket>', ($new + '</psf:PrintTicket>') }
    return $null
}

function Enable-SpoolfreeAutoDuplex {
    <#
    .SYNOPSIS
        0.7.7: stores the driver's automatic two-sided mode on a vendor queue, keeping its current default duplex.
        Returns 'automatic' or 'none' (the driver has no such option). Throws on failure.
    #>
    param([Parameter(Mandatory)][string]$Name)
    Add-Type -AssemblyName ReachFramework, System.Printing
    $server = New-Object System.Printing.LocalPrintServer
    try {
        $q = $server.GetPrintQueue($Name)
        $reader = New-Object IO.StreamReader($q.GetPrintCapabilitiesAsXml())
        try { $caps = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $server.Dispose() }
    $config = Get-PrintConfiguration -PrinterName $Name -ErrorAction Stop
    $ticket = Get-SpoolfreeAutoDuplexTicket -CapabilitiesXml $caps -TicketXml ([string]$config.PrintTicketXML)
    if (-not $ticket) { return 'none' }
    $mode = [string]$config.DuplexingMode
    Set-PrintConfiguration -PrinterName $Name -PrintTicketXml $ticket -ErrorAction Stop
    if ($mode) { Set-PrintConfiguration -PrinterName $Name -DuplexingMode $mode -ErrorAction Stop }
    return 'automatic'
}

function Install-SpoolfreePrinter {
    <#
    .SYNOPSIS
        Creates a machine-wide driverless queue.
        Primary:  Add-Printer -IppURL (IPP class driver chosen by Windows; WPP-compatible).
        TcpIpPort: Standard TCP/IP port with -DriverName, a real driver (the replaced legacy queue's). Never with the
                  IPP Class Driver (0.7.7): its raster on a RAW port prints as text on printers without PWG raster.
                  (An IPP Internet Port with the IPP Class Driver was tried for 0.7.7 and dropped: the class driver
                  cannot read the device's capabilities there, and Set-Printer / Set-PrintConfiguration hang or fail.)
        Vendor:   the manifest's vendor driver (already installed: Install-SpoolfreeVendorDriver) on a RAW 9100, LPR or
                  IPP port (0.7).
        -QueueName creates the queue under another name (make-before-break); the marker is then left to the caller.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)][string]$Method,
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        # TcpIpPort only: driver to use instead of the Microsoft IPP Class Driver (must be installed already).
        [AllowNull()][AllowEmptyString()][string]$DriverName,
        [AllowNull()][AllowEmptyString()][string]$QueueName
    )
    $comment = Get-SpoolfreeComment -Printer $Printer -ServerId $ServerId
    $location = if ($Printer.location) { [string]$Printer.location } else { '' }
    $queue = if ($QueueName) { $QueueName } else { [string]$Printer.name }
    $final = $queue -eq [string]$Printer.name
    switch ($Method) {
        'IppURL' {
            # Windows names IPP queues after the device; create, then rename to the logical name.
            $before = @(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
            Add-Printer -IppURL $Printer.ippUrl -Name $queue -ErrorAction Stop
            $q = Get-SpoolfreeQueueByName -Name $queue
            if (-not $q) {
                $new = @(Get-Printer | Where-Object { $before -notcontains $_.Name })
                if ($new.Count -ne 1) { throw "Add-Printer -IppURL did not create a single identifiable queue for $($Printer.name)." }
                Rename-Printer -InputObject $new[0] -NewName $queue -ErrorAction Stop
                $q = Get-SpoolfreeQueueByName -Name $queue
                if (-not $q) { throw "Renaming the new queue to $queue failed." }
            }
            Set-Printer -Name $queue -Comment $comment -Location $location -ErrorAction SilentlyContinue
            if ($final) { Set-SpoolfreeMarker -Printer $Printer -Method 'IppURL' -PortName ([string]$q.PortName) -ServerId ([string]$ServerId) }
        }
        'Vendor' {
            $v = Get-SpoolfreeVendorDriver $Printer
            if (-not $v) { throw "No valid vendor driver in the manifest for $($Printer.name)." }
            $port = New-SpoolfreeVendorQueue -Printer $Printer -Vendor $v -QueueName $queue -Comment $comment -Location $location
            if ($final) { Set-SpoolfreeMarker -Printer $Printer -Method 'Vendor' -PortName $port -ServerId ([string]$ServerId) -Target (Get-SpoolfreeQueueTarget $Printer) }
        }
        'TcpIpPort' {
            if (-not $DriverName -or $DriverName -eq $script:IppDriver) { throw "No driver for a Standard TCP/IP queue for $($Printer.name): the IPP Class Driver is never used on a RAW port." }
            if (-not (Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue)) { throw "Driver '$DriverName' is not installed." }
            $port = 'SPOOLFREE_' + ([string]$Printer.host -replace '[^A-Za-z0-9\.\-]', '_')
            if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) {
                Add-PrinterPort -Name $port -PrinterHostAddress $Printer.host -ErrorAction Stop
            }
            Add-Printer -Name $queue -DriverName $DriverName -PortName $port -Comment $comment -Location $location -ErrorAction Stop
            if ($final) { Set-SpoolfreeMarker -Printer $Printer -Method 'TcpIpPort' -PortName $port -ServerId ([string]$ServerId) }
        }
        default { throw "No supported install method on this PC (method '$Method')." }
    }
}

function Test-SpoolfreeIppFallbackError {
    <#
    .SYNOPSIS
        Pure: should a failed Add-Printer -IppURL fall back to the TCP/IP port method? Yes for every error except
        "already exists" (a queue with that name exists: another method would fail the same way). With
        -NameFree ("already exists" while no queue has that name, 0.6.2) it is the device that is taken, not the
        name: a TCP/IP port queue is not affected by that, so the fallback is allowed.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Message, [switch]$NameFree)
    if (-not ([string]$Message -match 'already exists')) { return $true }
    return [bool]$NameFree
}

function Get-SpoolfreeQueueByName {
    <#
    .SYNOPSIS
        The queue with exactly this name, or $null. Get-Printer -Name treats [ ] * ? as wildcards, so queue names
        such as "HP Color LaserJet Pro MFP 3303 [HPI0AEEE8]" never match it (0.6.2).
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Name)
    if (-not $Name) { return $null }
    return (@(Get-Printer -ErrorAction SilentlyContinue) | Where-Object { [string]$_.Name -eq $Name } | Select-Object -First 1)
}

function Remove-SpoolfreeQueue {
    <#
    .SYNOPSIS
        Removes the queue with exactly this name (no wildcards) and checks it is gone. Throws when there is no
        such queue or Windows kept it: Remove-Printer -Name with a wildcard character in the name silently
        removes nothing, which before 0.6.2 was reported as "removed".
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $q = Get-SpoolfreeQueueByName -Name $Name
    if (-not $q) { throw "Queue '$Name' was not found." }
    Remove-Printer -InputObject $q -ErrorAction Stop
    if (Get-SpoolfreeQueueByName -Name $Name) { throw "Queue '$Name' is still there after Remove-Printer." }
}

function Get-SpoolfreeStaleAssociationKeys {
    <#
    .SYNOPSIS
        Pure: Device Association Framework store entries (HKLM\SYSTEM\CurrentControlSet\Services\
        DeviceAssociationService\State\Store\<key>) of one device that keep Add-Printer -IppURL failing with
        "The specified printer already exists" after its WSD/IPP queue was removed (0.6.2).
        HP printers use their WS-Discovery endpoint UUID as IPP printer-uuid; Windows keeps the WSD association
        (DAFWSDProvider#urn:uuid:<uuid>) after the queue is gone, and the IPP install then finds the endpoint
        "already" associated. Nothing is returned while any queue still uses a WSD/IPP port of the device.
    .PARAMETER Keys
        Store key names (PSChildName).
    .PARAMETER InUse
        $true when a queue uses a WSD/IPP port whose Printer UUID is the device.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$DeviceUuid,
        [AllowEmptyCollection()][string[]]$Keys = @(),
        [bool]$InUse = $false
    )
    $uuid = ConvertTo-SpoolfreeUuid $DeviceUuid
    if (-not $uuid -or $InUse) { return @() }
    $pattern = '^DAF[A-Za-z]*Provider#(urn:uuid:)?' + [regex]::Escape($uuid) + '$'
    return @(@($Keys) | Where-Object { $_ -and ([string]$_) -match $pattern } | ForEach-Object { [string]$_ })
}

function Clear-SpoolfreeStaleAssociation {
    <#
    .SYNOPSIS
        Removes the stale device association of one device (Get-SpoolfreeStaleAssociationKeys) when no queue uses
        it: backs each store key up to %ProgramData%\Spoolfree\Backup, deletes it with the device's WSD/IPP PnP
        nodes, and restarts the Device Association service so the change is seen. Returns what was done.
        Never throws.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([AllowNull()][AllowEmptyString()][string]$DeviceUuid)
    $done = New-Object System.Collections.Generic.List[string]
    try {
        $uuid = ConvertTo-SpoolfreeUuid $DeviceUuid
        if (-not $uuid) { return $done.ToArray() }
        $ports = @(Get-SpoolfreeWsdPortRegistry | Where-Object { (ConvertTo-SpoolfreeUuid ([string]$_.PrinterUuid)) -eq $uuid } | ForEach-Object { ([string]$_.Name).ToLowerInvariant() })
        $inUse = [bool](@(Get-Printer -ErrorAction SilentlyContinue | Where-Object { $ports -contains ([string]$_.PortName).ToLowerInvariant() }).Count)
        $store = 'HKLM:\SYSTEM\CurrentControlSet\Services\DeviceAssociationService\State\Store'
        $keys = @(Get-SpoolfreeStaleAssociationKeys -DeviceUuid $uuid -InUse $inUse -Keys @(Get-ChildItem -Path $store -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }))
        if (-not $keys.Count) { return $done.ToArray() }
        $backup = Join-Path $env:ProgramData 'Spoolfree\Backup'
        if (-not (Test-Path $backup)) { New-Item -ItemType Directory -Path $backup -Force | Out-Null }
        foreach ($k in $keys) {
            if (-not $PSCmdlet.ShouldProcess($k, 'Remove stale device association')) { continue }
            $file = Join-Path $backup ("daf-{0}-{1}.reg" -f ($k -replace '[^A-Za-z0-9\-]', '_'), [datetime]::UtcNow.ToString('yyyyMMddHHmmss'))
            $regPath = 'HKLM\SYSTEM\CurrentControlSet\Services\DeviceAssociationService\State\Store\' + $k
            & reg.exe export $regPath $file /y 2>&1 | Out-Null
            & reg.exe delete $regPath /f 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $done.Add("removed stale device association $k (backup $file)") }
            else { $done.Add("could not remove device association $k") }
        }
        $nodes = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match ('^SWD\\DAFWSDPROVIDER\\URN:UUID:' + [regex]::Escape($uuid) + '(/|$)') } |
                Sort-Object { $_.InstanceId.Length } -Descending)
        foreach ($n in $nodes) {
            $out = & pnputil.exe /remove-device "$($n.InstanceId)" 2>&1
            if ($LASTEXITCODE -eq 0) { $done.Add("removed device node $($n.InstanceId)") } else { $done.Add("could not remove device node $($n.InstanceId): $(($out | Out-String).Trim())") }
        }
        if (@($done | Where-Object { $_ -like 'removed stale device association*' }).Count -and $PSCmdlet.ShouldProcess('DeviceAssociationService', 'Restart')) {
            try { Restart-Service -Name DeviceAssociationService -Force -ErrorAction Stop; Start-Sleep -Seconds 3; $done.Add('restarted the Device Association service') }
            catch { $done.Add("could not restart the Device Association service: $($_.Exception.Message)") }
        }
    } catch {
        $done.Add("device association check failed: $($_.Exception.Message)")
    }
    return $done.ToArray()
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
        2. fall back (not when Windows Protected Print Mode is enforced) to a Standard TCP/IP queue with the replaced
           legacy queue's driver when there is one. 0.7.7: never to the IPP Class Driver on a RAW port; without a
           real driver the error says the printer needs a vendor driver.
        Returns Method (the method that worked), Fallback (bool) and Notes. Throws with every error when all fail.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)][string]$Method,
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [bool]$ProtectedPrintMode = $false,
        # 0.6.2: takeover is on for this printer, or took over a queue for it on this PC. Then "already exists"
        # (with no queue of that name) is recovered: blocking queues are removed, the stale device association
        # is cleared, and as a last resort the TCP/IP fallback is used, so the PC is never left without the printer.
        [bool]$TakeoverRecovery = $false,
        # Returns the names of queues that hold the device now (re-scan right after the failure; queues Windows
        # set up again by itself are included). Only called with -TakeoverRecovery.
        [scriptblock]$FindBlocking,
        # Driver for the TCP/IP fallback: the driver of the legacy queue takeover removed, when still installed.
        [AllowNull()][AllowEmptyString()][string]$FallbackDriver
    )
    $notes = New-Object System.Collections.Generic.List[string]
    $removedQueues = New-Object System.Collections.Generic.List[string]
    $result = { param($m, $fb) [pscustomobject]@{ Method = $m; Fallback = $fb; Notes = $notes.ToArray(); RemovedQueues = $removedQueues.ToArray() } }
    try {
        Install-SpoolfreePrinter -Printer $Printer -Method $Method -ServerId $ServerId
        return (& $result $Method $false)
    } catch {
        $first = $_.Exception.Message
        if ($Method -ne 'IppURL') { throw }
        $exists = $first -match 'already exists'
        # "already exists" for our own name is a real name clash; for a free name it is the device that is taken.
        $nameFree = $exists -and -not (Get-SpoolfreeQueueByName -Name ([string]$Printer.name))
        if (-not (Test-SpoolfreeIppFallbackError $first -NameFree:($nameFree -and $TakeoverRecovery))) { throw }
    }
    $notes.Add("Add-Printer -IppURL failed: $first")
    $uuid = [string](Get-SpoolfreeProperty $Printer 'deviceUuid')
    $retry = {
        param($why)
        try {
            Install-SpoolfreePrinter -Printer $Printer -Method 'IppURL' -ServerId $ServerId
            $notes.Add("Add-Printer -IppURL worked after $why")
            return $true
        } catch {
            $notes.Add("Add-Printer -IppURL retry failed: $($_.Exception.Message)")
            return $false
        }
    }
    if ($exists) {
        # (a) A queue for the same device may exist under another name, also one Windows created again moments
        # after takeover removed the old one: remove it and retry.
        if ($FindBlocking) {
            $blocking = @(try { & $FindBlocking } catch { $notes.Add("re-scan for blocking queues failed: $($_.Exception.Message)") })
            foreach ($b in @($blocking | Where-Object { $_ } | Select-Object -Unique)) {
                try { Remove-SpoolfreeQueue -Name ([string]$b); $removedQueues.Add([string]$b); $notes.Add("removed queue '$b' that held the device") }
                catch { $notes.Add("could not remove queue '$b': $($_.Exception.Message)") }
            }
            if ($removedQueues.Count -and (& $retry 'removing the queue that held the device')) { return (& $result 'IppURL' $false) }
        }
        # (b) No queue holds the device, but Windows still has its old WSD/IPP association.
        if ($uuid) {
            $cleaned = @(Clear-SpoolfreeStaleDevice -DeviceUuid $uuid) + @(Clear-SpoolfreeStaleAssociation -DeviceUuid $uuid)
            foreach ($c in $cleaned) { $notes.Add($c) }
            if (@($cleaned | Where-Object { $_ -like 'removed *' }).Count -and (& $retry 'removing the stale device association')) { return (& $result 'IppURL' $false) }
        }
    } elseif ($uuid) {
        $cleaned = @(Clear-SpoolfreeStaleDevice -DeviceUuid $uuid)
        foreach ($c in $cleaned) { $notes.Add($c) }
        if (@($cleaned | Where-Object { $_ -like 'removed *' }).Count -and (& $retry 'removing the stale device entries')) { return (& $result 'IppURL' $false) }
    }
    if ($ProtectedPrintMode) {
        throw "Add-Printer -IppURL failed ($first) and no fallback is possible: Windows Protected Print Mode is enforced."
    }
    $driver = if ($FallbackDriver -and $FallbackDriver -ne $script:IppDriver -and (Get-PrinterDriver -Name $FallbackDriver -ErrorAction SilentlyContinue)) { $FallbackDriver } else { '' }
    $fails = New-Object System.Collections.Generic.List[string]
    if ($driver) {
        try {
            Install-SpoolfreePrinter -Printer $Printer -Method 'TcpIpPort' -ServerId $ServerId -DriverName $driver
            $notes.Add("created with a Standard TCP/IP port and the driver of the replaced queue ($driver) instead")
            return (& $result 'TcpIpPort' $true)
        } catch {
            $fails.Add("TCP/IP port with '$driver' failed: $($_.Exception.Message)")
        }
    }
    $more = if ($fails.Count) { "; $($fails -join '; ')" } else { '' }
    throw "Add-Printer -IppURL failed ($first)$more. This printer needs a vendor driver (set one in its Driver setting)."
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
    $q = Get-SpoolfreeQueueByName -Name $Name
    if ($q) {
        # Double-check ownership through the comment before deleting.
        if ($q.Comment -and -not ([string]$q.Comment).StartsWith($script:CommentPrefix)) {
            throw "Queue '$Name' no longer carries the Spoolfree comment; leaving it alone."
        }
        Remove-SpoolfreeQueue -Name $Name
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
    <#
    .SYNOPSIS
        Hashtable PortName -> Monitor, Description, HostAddress, Addresses (resolved / device hosts), Uuids.
        -NoResolve skips DNS lookups (Addresses of TCP/IP and URL ports stay empty).
    #>
    param([switch]$NoResolve)
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
        if ($hostAddress) { if (-not $NoResolve) { $addresses = Resolve-SpoolfreeAddress $hostAddress } }
        elseif ($urlHost) { if (-not $NoResolve) { $addresses = Resolve-SpoolfreeAddress $urlHost } }
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

# ---------------------------------------------------------------------------
# Print analytics (0.5.0, opt-in per server: manifest analytics.enabled).
# Reads "document printed" events (ID 307) from the PrintService Operational log and posts them to
# /api/agent/jobs. A bookmark (last sent EventRecordID) in HKLM:\SOFTWARE\Spoolfree\Analytics advances only
# after the server accepted a batch, so nothing is lost and a re-send is harmless (the server dedups).
# ---------------------------------------------------------------------------

$script:PrintLogName = 'Microsoft-Windows-PrintService/Operational'
$script:PrintLogMinSize = 20971520
$script:AnalyticsRegistry = 'HKLM:\SOFTWARE\Spoolfree\Analytics'
$script:SidCache = @{}

function Get-SpoolfreeAnalyticsSettings {
    <# Pure: manifest analytics { enabled, collectDocumentNames } -> Enabled / CollectDocumentNames (absent = off). #>
    param($Manifest)
    $a = Get-SpoolfreeProperty $Manifest 'analytics'
    $enabled = (Get-SpoolfreeProperty $a 'enabled') -eq $true
    $docs = $enabled -and ((Get-SpoolfreeProperty $a 'collectDocumentNames') -eq $true)
    return [pscustomobject]@{ Enabled = [bool]$enabled; CollectDocumentNames = [bool]$docs }
}

function ConvertFrom-SpoolfreePrintEvent {
    <#
    .SYNOPSIS
        Pure: a PrintService event 307 ("document printed") as XML -> RecordId, Time (ISO 8601 UTC), UserSid,
        UserName (Param3), ClientComputer (without leading \\), Printer, Port, Bytes, Pages, Document.
        Document is $null unless -CollectDocumentNames. $null for anything that is not a parseable event 307.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Xml, [bool]$CollectDocumentNames = $false)
    if (-not $Xml) { return $null }
    $doc = New-Object System.Xml.XmlDocument
    $doc.XmlResolver = $null
    try { $doc.LoadXml($Xml) } catch { return $null }
    $sys = $doc.SelectSingleNode("/*[local-name()='Event']/*[local-name()='System']")
    if ($null -eq $sys) { return $null }
    $idNode = $sys.SelectSingleNode("*[local-name()='EventID']")
    if ($null -ne $idNode -and $idNode.InnerText.Trim() -ne '307') { return $null }
    $ridNode = $sys.SelectSingleNode("*[local-name()='EventRecordID']")
    [int64]$recordId = 0
    if ($null -eq $ridNode -or -not [int64]::TryParse($ridNode.InnerText.Trim(), [ref]$recordId) -or $recordId -le 0) { return $null }

    $time = $null
    $tc = $sys.SelectSingleNode("*[local-name()='TimeCreated']/@SystemTime")
    if ($null -ne $tc -and $tc.Value) {
        $dt = [datetime]::MinValue
        $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
        if ([datetime]::TryParse($tc.Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$dt)) {
            $time = $dt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        }
    }
    $sidNode = $sys.SelectSingleNode("*[local-name()='Security']/@UserID")
    $sid = if ($null -ne $sidNode -and $sidNode.Value) { $sidNode.Value.Trim() } else { $null }

    $data = $doc.SelectSingleNode("/*[local-name()='Event']/*[local-name()='UserData']/*[local-name()='DocumentPrinted']")
    $params = @{}
    for ($i = 1; $i -le 8; $i++) {
        $v = $null
        if ($null -ne $data) {
            $n = $data.SelectSingleNode("*[local-name()='Param$i']")
            if ($null -ne $n) { $v = $n.InnerText.Trim(); if (-not $v) { $v = $null } }
        }
        $params[$i] = $v
    }
    $client = $params[4]
    if ($client) { $client = $client.TrimStart([char]'\'); if (-not $client) { $client = $null } }
    [int64]$bytes = 0; [int]$pages = 0
    $bytesOut = if ($params[7] -and [int64]::TryParse($params[7], [ref]$bytes)) { $bytes } else { $null }
    $pagesOut = if ($params[8] -and [int]::TryParse($params[8], [ref]$pages)) { $pages } else { $null }
    return [pscustomobject]@{
        RecordId       = $recordId
        Time           = $time
        UserSid        = $sid
        UserName       = $params[3]
        ClientComputer = $client
        Printer        = $params[5]
        Port           = $params[6]
        Bytes          = $bytesOut
        Pages          = $pagesOut
        Document       = $(if ($CollectDocumentNames) { $params[2] } else { $null })
    }
}

function Resolve-SpoolfreeSidName {
    <# SID -> DOMAIN\name (cached per run); $null when it cannot be translated. #>
    param([AllowNull()][AllowEmptyString()][string]$Sid)
    if (-not $Sid) { return $null }
    if ($script:SidCache.ContainsKey($Sid)) { return $script:SidCache[$Sid] }
    $name = $null
    try {
        $id = New-Object System.Security.Principal.SecurityIdentifier $Sid
        $name = [string]$id.Translate([System.Security.Principal.NTAccount]).Value
    } catch { $name = $null }
    $script:SidCache[$Sid] = $name
    return $name
}

function Get-SpoolfreePortHost {
    <# Pure: the device host a port points at (TCP/IP host address, IPP/WSD URL host), lower-case; $null for local ports. #>
    param([AllowNull()][AllowEmptyString()][string]$PortName, $Port)
    if (-not $PortName -or $PortName -match $script:LocalPortPattern) { return $null }
    $h = Get-SpoolfreeUrlHost $PortName
    if ($h) { return $h }
    if ($null -eq $Port) { return $null }
    $monitor = [string](Get-SpoolfreeProperty $Port 'Monitor')
    $desc = [string](Get-SpoolfreeProperty $Port 'Description')
    if ($script:LocalMonitors -contains $monitor -or $script:LocalMonitors -contains $desc) { return $null }
    $hostAddress = ([string](Get-SpoolfreeProperty $Port 'HostAddress')).Trim()
    if ($hostAddress) {
        $h = Get-SpoolfreeUrlHost $hostAddress
        if ($h) { return $h }
        return $hostAddress.ToLowerInvariant()
    }
    if ($PortName -match '^WSD-' -or $monitor -like 'WSD Port*') {
        foreach ($a in @(Get-SpoolfreeProperty $Port 'Addresses')) { if ($a) { return ([string]$a).ToLowerInvariant() } }
    }
    return $null
}

function Resolve-SpoolfreePrintQueue {
    <#
    .SYNOPSIS
        Pure: maps a queue name from a print event to PrinterId (a manifest printer with that name, a queue this
        agent created, or a queue whose Spoolfree comment belongs to this server) and PortHost.
    .PARAMETER Queues
        Get-SpoolfreeQueueInventory objects (Name, PortName, Comment).
    .PARAMETER Ports
        Get-SpoolfreePortInventory hashtable.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$QueueName,
        [AllowNull()][AllowEmptyString()][string]$PortName,
        [AllowEmptyCollection()][object[]]$Printers = @(),
        [AllowEmptyCollection()][object[]]$Installed = @(),
        [AllowEmptyCollection()][object[]]$Queues = @(),
        [AllowNull()][hashtable]$Ports = @{},
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [AllowEmptyCollection()][string[]]$ServerPrinterIds = @()
    )
    if ($null -eq $Ports) { $Ports = @{} }
    $printerId = $null
    $queue = $null
    if ($QueueName) {
        foreach ($p in @($Printers)) {
            if ($p -and ([string](Get-SpoolfreeProperty $p 'name')) -ieq $QueueName) { $printerId = [string](Get-SpoolfreeProperty $p 'id'); break }
        }
        if (-not $printerId) {
            foreach ($m in @($Installed)) {
                if ($m -and ([string](Get-SpoolfreeProperty $m 'Name')) -ieq $QueueName -and (Get-SpoolfreeProperty $m 'Id')) { $printerId = [string](Get-SpoolfreeProperty $m 'Id'); break }
            }
        }
        foreach ($q in @($Queues)) { if ($q -and ([string](Get-SpoolfreeProperty $q 'Name')) -ieq $QueueName) { $queue = $q; break } }
        if (-not $printerId -and $queue) {
            $comment = [string](Get-SpoolfreeProperty $queue 'Comment')
            $c = ConvertFrom-SpoolfreeComment $comment
            if ($c -and $c.PrinterId -and (Get-SpoolfreeQueueOrigin -Comment $comment -ServerId $ServerId -ServerPrinterIds $ServerPrinterIds) -eq 'this') {
                $printerId = [string]$c.PrinterId
            }
        }
    }
    $pn = $PortName
    $port = if ($pn -and $Ports.ContainsKey($pn)) { $Ports[$pn] } else { $null }
    if (-not $port -and -not (Get-SpoolfreeUrlHost $pn) -and $queue) {
        # The event's port can be missing or a display name; fall back to the queue's own port.
        $qp = [string](Get-SpoolfreeProperty $queue 'PortName')
        if ($qp) { $pn = $qp; $port = $(if ($Ports.ContainsKey($qp)) { $Ports[$qp] } else { $null }) }
    }
    return [pscustomobject]@{ PrinterId = $(if ($printerId) { $printerId } else { $null }); PortHost = (Get-SpoolfreePortHost -PortName $pn -Port $port) }
}

function New-SpoolfreeJobRecord {
    <# Pure: the /api/agent/jobs event for a parsed print event, its queue mapping and the translated user name. #>
    param([Parameter(Mandatory)]$PrintEvent, $Mapping, [AllowNull()][AllowEmptyString()][string]$UserName)
    $user = if ($UserName) { $UserName } elseif ($PrintEvent.UserName) { [string]$PrintEvent.UserName } else { $null }
    return [ordered]@{
        recordId       = [int64]$PrintEvent.RecordId
        time           = $PrintEvent.Time
        user           = $user
        userSid        = $PrintEvent.UserSid
        clientComputer = $PrintEvent.ClientComputer
        printer        = $PrintEvent.Printer
        port           = $PrintEvent.Port
        portHost       = $(if ($Mapping) { $Mapping.PortHost } else { $null })
        pages          = $PrintEvent.Pages
        bytes          = $PrintEvent.Bytes
        document       = $PrintEvent.Document
        printerId      = $(if ($Mapping) { $Mapping.PrinterId } else { $null })
    }
}

function Get-SpoolfreePrintLogState {
    <# Enabled / MaxSizeBytes of the PrintService Operational log. #>
    $l = Get-WinEvent -ListLog $script:PrintLogName -ErrorAction Stop
    return [pscustomobject]@{ Enabled = [bool]$l.IsEnabled; MaxSizeBytes = [int64]$l.MaximumSizeInBytes }
}

function Invoke-SpoolfreeWevtutil {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $exe = Join-Path $env:SystemRoot 'System32\wevtutil.exe'
    $out = & $exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "wevtutil $($Arguments -join ' ') failed (exit $LASTEXITCODE): $(@($out) -join ' ')" }
}

function Enable-SpoolfreePrintLog {
    <# Makes sure the PrintService Operational log is on and at least 20 MB. Returns $true when it is enabled. #>
    $state = Get-SpoolfreePrintLogState
    if ($state.MaxSizeBytes -lt $script:PrintLogMinSize) { Invoke-SpoolfreeWevtutil -Arguments @('sl', $script:PrintLogName, "/ms:$($script:PrintLogMinSize)") }
    if (-not $state.Enabled) { Invoke-SpoolfreeWevtutil -Arguments @('sl', $script:PrintLogName, '/e:true') }
    return $true
}

function Get-SpoolfreeAnalyticsBookmark {
    <# The last EventRecordID the server accepted; 0 when none. #>
    $v = Get-ItemProperty -Path $script:AnalyticsRegistry -Name LastRecordId -ErrorAction SilentlyContinue
    if (-not $v) { return [int64]0 }
    [int64]$n = 0
    if ([int64]::TryParse([string]$v.LastRecordId, [ref]$n) -and $n -ge 0) { return $n }
    return [int64]0
}

function Set-SpoolfreeAnalyticsBookmark {
    param([Parameter(Mandatory)][int64]$RecordId)
    if (-not (Test-Path $script:AnalyticsRegistry)) { New-Item -Path $script:AnalyticsRegistry -Force | Out-Null }
    New-ItemProperty -Path $script:AnalyticsRegistry -Name LastRecordId -Value $RecordId -PropertyType QWord -Force | Out-Null
}

function Test-SpoolfreeNoEventsError {
    param($ErrorRecord)
    return ([string]$ErrorRecord.FullyQualifiedErrorId) -like 'NoMatchingEventsFound*'
}

function Get-SpoolfreePrintLogNewestRecordId {
    <# The newest EventRecordID in the PrintService Operational log; $null when it is empty. #>
    try { $e = @(Get-WinEvent -LogName $script:PrintLogName -MaxEvents 1 -ErrorAction Stop) }
    catch { if (Test-SpoolfreeNoEventsError $_) { return $null }; throw }
    if ($e.Count -eq 0 -or $null -eq $e[0]) { return $null }
    return [int64]$e[0].RecordId
}

function Get-SpoolfreePrintEventXml {
    <# XML of up to $Max event-307 records after $After, oldest first. #>
    param([int64]$After = 0, [int]$Max = 2000)
    $xpath = "*[System[(EventID=307) and (EventRecordID>$After)]]"
    try { $events = @(Get-WinEvent -LogName $script:PrintLogName -FilterXPath $xpath -Oldest -MaxEvents $Max -ErrorAction Stop) }
    catch { if (Test-SpoolfreeNoEventsError $_) { return @() }; throw }
    return @($events | Where-Object { $_ } | ForEach-Object { $_.ToXml() })
}

function Get-SpoolfreeHttpStatus {
    <# The HTTP status of a failed Invoke-RestMethod, or $null. #>
    param($ErrorRecord)
    try { $r = $ErrorRecord.Exception.Response; if ($r) { return [int]$r.StatusCode } } catch { }
    return $null
}

function Send-SpoolfreePrintJobs {
    <#
    .SYNOPSIS
        Posts $Jobs to /api/agent/jobs in batches of $BatchSize and moves the bookmark after each accepted batch
        (to the batch's highest recordId; to $FinalRecordId after the last). Stops at the first failure.
    .OUTPUTS
        Sent (events accepted), Unsupported (server answered 404), Error (message or $null).
    #>
    param(
        [AllowEmptyCollection()][object[]]$Jobs = @(),
        [Parameter(Mandatory)][string]$BaseUrl,
        [string]$Token,
        [int64]$FinalRecordId = 0,
        [int]$BatchSize = 500
    )
    $sent = 0
    [int64]$last = 0
    $all = @($Jobs | Where-Object { $_ })
    for ($i = 0; $i -lt $all.Count; $i += $BatchSize) {
        $end = [Math]::Min($i + $BatchSize, $all.Count) - 1
        $batch = @($all[$i..$end])
        foreach ($j in $batch) { if ([int64]$j['recordId'] -gt $last) { $last = [int64]$j['recordId'] } }
        try {
            Invoke-SpoolfreeHttp -Uri "$BaseUrl/api/agent/jobs" -Method POST -Token $Token -Body @{ events = $batch } | Out-Null
        } catch {
            if ((Get-SpoolfreeHttpStatus $_) -eq 404) { return [pscustomobject]@{ Sent = $sent; Unsupported = $true; Error = $null } }
            return [pscustomobject]@{ Sent = $sent; Unsupported = $false; Error = "jobs upload failed: $($_.Exception.Message)" }
        }
        $sent += $batch.Count
        Set-SpoolfreeAnalyticsBookmark -RecordId $last
    }
    if ($FinalRecordId -gt $last) { Set-SpoolfreeAnalyticsBookmark -RecordId $FinalRecordId }
    return [pscustomobject]@{ Sent = $sent; Unsupported = $false; Error = $null }
}

function Invoke-SpoolfreeAnalytics {
    <#
    .SYNOPSIS
        One analytics pass: enable the print log, read new event-307 records, map them and post them.
        Never throws; returns the report's analytics object { enabled, logEnabled, sent, error }.
    #>
    param(
        $Manifest,
        [Parameter(Mandatory)][string]$BaseUrl,
        [string]$Token,
        [AllowNull()][AllowEmptyString()][string]$ServerId,
        [AllowEmptyCollection()][string[]]$ServerPrinterIds = @(),
        [scriptblock]$Log,
        [int]$MaxEvents = 2000,
        [int]$BatchSize = 500
    )
    $settings = Get-SpoolfreeAnalyticsSettings $Manifest
    $report = [ordered]@{ enabled = $settings.Enabled; logEnabled = $null; sent = 0; error = $null }
    if (-not $settings.Enabled) { return $report }
    $errs = New-Object System.Collections.Generic.List[string]
    $notes = New-Object System.Collections.Generic.List[string]
    try {
        try { $report.logEnabled = [bool](Enable-SpoolfreePrintLog) }
        catch {
            $errs.Add("print log: $($_.Exception.Message)")
            try { $report.logEnabled = [bool](Get-SpoolfreePrintLogState).Enabled } catch { $report.logEnabled = $null }
        }

        [int64]$bookmark = Get-SpoolfreeAnalyticsBookmark
        $newest = Get-SpoolfreePrintLogNewestRecordId
        if ($bookmark -gt 0 -and ($null -eq $newest -or [int64]$newest -lt $bookmark)) {
            $notes.Add("Print analytics: the print log was cleared (newest record $newest, bookmark $bookmark); starting over.")
            Set-SpoolfreeAnalyticsBookmark -RecordId 0
            $bookmark = 0
        }
        $xmls = @(Get-SpoolfreePrintEventXml -After $bookmark -Max $MaxEvents)
        $parsed = New-Object System.Collections.Generic.List[object]
        foreach ($x in $xmls) {
            $e = ConvertFrom-SpoolfreePrintEvent -Xml ([string]$x) -CollectDocumentNames $settings.CollectDocumentNames
            if ($e) { $parsed.Add($e) }
        }
        # The newest record was read before the query, so when the query was not capped every event 307 up to
        # it has been seen: the bookmark can skip the other events in between.
        [int64]$final = 0
        foreach ($e in $parsed) { if ($e.RecordId -gt $final) { $final = $e.RecordId } }
        if ($xmls.Count -lt $MaxEvents -and $null -ne $newest -and [int64]$newest -gt $final) { $final = [int64]$newest }

        $jobs = New-Object System.Collections.Generic.List[object]
        if ($parsed.Count) {
            $queues = @(Get-SpoolfreeQueueInventory)
            $ports = Get-SpoolfreePortInventory -NoResolve
            $installed = @(Get-SpoolfreeInstalled)
            $printers = @(Get-SpoolfreeProperty $Manifest 'printers' | Where-Object { $_ })
            $maps = @{}
            foreach ($e in $parsed) {
                if (-not $e.Printer) { continue }
                $key = "$($e.Printer)|$($e.Port)".ToLowerInvariant()
                if (-not $maps.ContainsKey($key)) {
                    $maps[$key] = Resolve-SpoolfreePrintQueue -QueueName $e.Printer -PortName $e.Port -Printers $printers -Installed $installed -Queues $queues -Ports $ports -ServerId $ServerId -ServerPrinterIds $ServerPrinterIds
                }
                $jobs.Add((New-SpoolfreeJobRecord -PrintEvent $e -Mapping $maps[$key] -UserName (Resolve-SpoolfreeSidName $e.UserSid)))
            }
        }
        if ($jobs.Count -gt 0 -or $final -gt $bookmark) {
            $r = Send-SpoolfreePrintJobs -Jobs $jobs.ToArray() -BaseUrl $BaseUrl -Token $Token -FinalRecordId $final -BatchSize $BatchSize
            $report.sent = [int]$r.Sent
            if ($r.Unsupported) { $notes.Add('Print analytics: the server does not accept print jobs (HTTP 404); skipped.') }
            elseif ($r.Error) { $errs.Add($r.Error) }
            elseif ($r.Sent) { $notes.Add("Print analytics: sent $($r.Sent) print job(s).") }
        }
    } catch {
        $errs.Add($_.Exception.Message)
    }
    if ($errs.Count) { $report.error = ($errs -join '; ') }
    if ($Log) { foreach ($n in $notes) { try { & $Log $n } catch { } } }
    return $report
}

# ---------------------------------------------------------------------------
# Commands (0.8): test prints "from a PC". The server signs each command on its own with the manifest key, over
# "spoolfree-command-v1`n" + the JSON payload, so a command can never pass as a manifest or an agent bundle. A command
# runs only when its signature, computer, expiry and (single use) id check out, and only through a queue this agent
# manages for the command's printer. It arrives in the manifest or from the cheap /api/agent/commands poll.
# 0.8.1: the page is printed as the logged-on user (Print Support Apps drop jobs owned by SYSTEM), the result comes
# from PrintService events (never "printed" for a job nobody saw), a stuck test job is removed from the queue, and
# runs are serialised by a lock file only SYSTEM and Administrators can open.
# ---------------------------------------------------------------------------

$script:CommandRegistry = 'HKLM:\SOFTWARE\Spoolfree\Commands'
$script:CommandPrefix = "spoolfree-command-v1`n"
$script:CommandTaskName = 'Spoolfree Commands'
$script:TestPageTaskPrefix = 'Spoolfree Test Page '

function ConvertFrom-SpoolfreeCommand {
    <#
    .SYNOPSIS
        Verifies a signed command envelope and returns the payload. Throws unless the Ed25519 signature (over the
        domain prefix + payload) verifies with the pinned key, it is a test-print command for this computer, its id is
        a GUID and it has not expired.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Envelope,
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][string]$ObjectGuid,
        [datetime]$Now = [datetime]::UtcNow
    )
    $payload = [string](Get-SpoolfreeProperty $Envelope 'payload')
    $sig = [string](Get-SpoolfreeProperty $Envelope 'signature')
    if (-not $payload -or -not $sig) { throw 'Command envelope is missing payload or signature.' }
    $alg = Get-SpoolfreeProperty $Envelope 'alg'
    if ($alg -and $alg -ne 'Ed25519') { throw "Unsupported command algorithm '$alg'." }
    try { $bytes = [Convert]::FromBase64String($payload) } catch { throw 'Command payload is not base64.' }
    $prefix = [Text.Encoding]::UTF8.GetBytes($script:CommandPrefix)
    $msg = New-Object byte[] ($prefix.Length + $bytes.Length)
    [Array]::Copy($prefix, 0, $msg, 0, $prefix.Length)
    [Array]::Copy($bytes, 0, $msg, $prefix.Length, $bytes.Length)
    if (-not (Test-SpoolfreeSignature -PublicKey $PublicKey -Message $msg -Signature $sig)) { throw 'Command signature is invalid. Refusing to run it.' }
    $c = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if ((Get-SpoolfreeProperty $c 'kind') -ne 'spoolfree-command' -or (Get-SpoolfreeProperty $c 'v') -ne 1) { throw 'Not a Spoolfree command.' }
    if ((Get-SpoolfreeProperty $c 'type') -ne 'test-print') { throw "Unknown command type '$(Get-SpoolfreeProperty $c 'type')'." }
    if ([string]$c.id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Command id is not a GUID.' }
    if (([string]$c.computer.objectGuid).ToLowerInvariant() -ne $ObjectGuid.ToLowerInvariant()) { throw 'Command was issued for a different computer.' }
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $expires = [datetime]::Parse([string]$c.expiresAt, [Globalization.CultureInfo]::InvariantCulture, $styles)
    if ($expires -lt $Now) { throw "Command expired at $($c.expiresAt)." }
    if (-not [string]$c.printer.id -or -not [string]$c.printer.name) { throw 'Command names no printer.' }
    return $c
}

function Register-SpoolfreeCommandRun {
    <#
    .SYNOPSIS
        Single use: records the command id (HKLM:\SOFTWARE\Spoolfree\Commands, value = time) and returns $true, or
        $false when the id ran before. Ids older than 2 days are pruned (commands expire long before that).
    #>
    param([Parameter(Mandatory)][string]$Id, [string]$Key = $script:CommandRegistry, [datetime]$Now = [datetime]::UtcNow)
    if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
    $props = Get-ItemProperty -Path $Key
    $id = $Id.ToLowerInvariant()
    if ($props.PSObject.Properties[$id]) { return $false }
    foreach ($p in @($props.PSObject.Properties | Where-Object { $_.Name -match '^[0-9a-f-]{36}$' })) {
        $at = [datetime]::MinValue
        $ok = [datetime]::TryParse([string]$p.Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$at)
        if (-not $ok -or ($Now - $at).TotalDays -gt 2) { Remove-ItemProperty -Path $Key -Name $p.Name -ErrorAction SilentlyContinue }
    }
    New-ItemProperty -Path $Key -Name $id -Value $Now.ToUniversalTime().ToString('o') -PropertyType String -Force | Out-Null
    return $true
}

function Resolve-SpoolfreeCommandQueue {
    <#
    .SYNOPSIS
        Pure: the queue a command may print through, or $null. It must be a queue this agent created for the command's
        printer: a marker with the printer id and queue name, and a queue of that name whose "Managed by Spoolfree"
        comment carries the same printer id (and this server's id, when the comment names one).
    #>
    param(
        [Parameter(Mandatory)]$Command,
        [AllowEmptyCollection()]$Installed = @(),
        [AllowEmptyCollection()]$Queues = @(),
        [AllowNull()][AllowEmptyString()][string]$ServerId
    )
    $id = ([string]$Command.printer.id).ToLowerInvariant()
    $name = [string]$Command.printer.name
    $marker = @($Installed | Where-Object { ([string]$_.Id).ToLowerInvariant() -eq $id -and [string]$_.Name -eq $name }) | Select-Object -First 1
    if (-not $marker) { return $null }
    $queue = @($Queues | Where-Object { [string]$_.Name -eq [string]$marker.Name }) | Select-Object -First 1
    if (-not $queue) { return $null }
    $c = ConvertFrom-SpoolfreeComment ([string]$queue.Comment)
    if ($null -eq $c -or ([string]$c.PrinterId).ToLowerInvariant() -ne $id) { return $null }
    if ($c.ServerId -and $ServerId -and $c.ServerId -ne $ServerId.ToLowerInvariant()) { return $null }
    return [string]$queue.Name
}

function Get-SpoolfreeJobOutcome {
    <# Pure: what a spooler JobStatus (Get-PrintJob) means for a test print: printed, failed or pending. #>
    param([AllowNull()][AllowEmptyString()][string]$Status)
    $s = [string]$Status
    if ($s -match 'Error|Offline|PaperOut|Paper Out|Blocked|UserIntervention|User Intervention|Deleted|Deleting') { return 'failed' }
    if ($s -match 'Printed|Complete') { return 'printed' }
    return 'pending'
}

function ConvertFrom-SpoolfreeJobEvent {
    <#
    .SYNOPSIS
        Pure (0.8.1): a PrintService job event as XML (+ its rendered message) -> EventId, JobId (Param1), Params (all
        ParamN values, in order), ErrorCode (372: "Win32 error code ...: <code>" from the message, else the last
        numeric parameter) and Time. $null for anything that is not a parseable event 307 or 372.
        Document names are never used: Windows 11 records them as "Print Document".
    #>
    param([AllowNull()][AllowEmptyString()][string]$Xml, [AllowNull()][AllowEmptyString()][string]$Message)
    if (-not $Xml) { return $null }
    $doc = New-Object System.Xml.XmlDocument
    $doc.XmlResolver = $null
    try { $doc.LoadXml($Xml) } catch { return $null }
    $sys = $doc.SelectSingleNode("/*[local-name()='Event']/*[local-name()='System']")
    if ($null -eq $sys) { return $null }
    $idNode = $sys.SelectSingleNode("*[local-name()='EventID']")
    $eventId = 0
    if ($null -eq $idNode -or -not [int]::TryParse($idNode.InnerText.Trim(), [ref]$eventId) -or @(307, 372) -notcontains $eventId) { return $null }
    $time = $null
    $tc = $sys.SelectSingleNode("*[local-name()='TimeCreated']/@SystemTime")
    if ($null -ne $tc -and $tc.Value) {
        $dt = [datetime]::MinValue
        $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
        if ([datetime]::TryParse($tc.Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$dt)) { $time = $dt }
    }
    $data = $doc.SelectSingleNode("/*[local-name()='Event']/*[local-name()='UserData']/*")
    $params = New-Object System.Collections.Generic.List[string]
    if ($null -ne $data) {
        for ($i = 1; $i -le 20; $i++) {
            $n = $data.SelectSingleNode("*[local-name()='Param$i']")
            if ($null -eq $n) { break }
            $params.Add($n.InnerText.Trim())
        }
    }
    $jobId = $null
    $j = 0
    if ($params.Count -and [int]::TryParse($params[0], [ref]$j)) { $jobId = $j }
    $code = $null
    if ($eventId -eq 372) {
        $m = [regex]::Match([string]$Message, '(?i)error code[^:]*:\s*(0x[0-9a-f]+|\d+)')
        if ($m.Success) { $code = $m.Groups[1].Value }
        else {
            $num = @($params | Where-Object { $_ -match '^(0x[0-9a-fA-F]+|\d+)$' })
            if ($params.Count -gt 1 -and $params[$params.Count - 1] -match '^(0x[0-9a-fA-F]+|\d+)$') { $code = $params[$params.Count - 1] }
            elseif ($num.Count -gt 1) { $code = $num[$num.Count - 1] }
        }
    }
    return [pscustomobject]@{ EventId = $eventId; JobId = $jobId; Params = $params.ToArray(); ErrorCode = $code; Time = $time }
}

function Get-SpoolfreeJobEvents {
    <#
    .SYNOPSIS
        PrintService events since -Since: Admin 372 (a document failed to print) and Operational 307 (a document
        printed), parsed with ConvertFrom-SpoolfreeJobEvent. A log that is off or empty gives nothing; never throws.
    #>
    param([Parameter(Mandatory)][datetime]$Since)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(@{ LogName = 'Microsoft-Windows-PrintService/Admin'; Id = 372 }, @{ LogName = 'Microsoft-Windows-PrintService/Operational'; Id = 307 })) {
        try {
            $f['StartTime'] = $Since
            foreach ($e in @(Get-WinEvent -FilterHashtable $f -MaxEvents 200 -ErrorAction Stop)) {
                $msg = $null
                try { $msg = $e.Message } catch { }
                $r = ConvertFrom-SpoolfreeJobEvent -Xml $e.ToXml() -Message $msg
                if ($r) { $out.Add($r) }
            }
        } catch { }
    }
    return $out.ToArray()
}

function Wait-SpoolfreePrintJob {
    <#
    .SYNOPSIS
        Follows the test print in a queue until PrintService says it printed or failed, or the timeout passes (0.8.1).
        - Events since -Since for this queue (a parameter equal to the queue name; the job id too once the job was
          seen): Admin 372 -> failed (with the Win32 error code), Operational 307 -> printed.
        - Jobs in the queue that were not there before (-KnownJobIds): the first one is the test job; -OnSent is
          called once with it; a spooler error status -> failed.
        - Without an event the result is 'unknown' (submitted, not confirmed): never 'printed' for a job that was
          not seen printing. Document names are not used (Windows 11 records them as "Print Document").
        - On failure or timeout the test job is removed from the queue (-RemoveJob), so it does not print later.
    #>
    param(
        [Parameter(Mandatory)][string]$Queue,
        [datetime]$Since = (Get-Date),
        [AllowEmptyCollection()][int[]]$KnownJobIds = @(),
        [int]$TimeoutSeconds = 120,
        # Polls without a job and without an event before giving up with 'unknown'.
        [int]$QuietPolls = 5,
        [scriptblock]$GetJobs = { param($q) @(Get-PrintJob -PrinterName $q -ErrorAction Stop) },
        [scriptblock]$GetEvents = { param($since) Get-SpoolfreeJobEvents -Since $since },
        [scriptblock]$RemoveJob = { param($q, $id) Remove-PrintJob -PrinterName $q -ID $id -ErrorAction Stop },
        [scriptblock]$Sleep = { Start-Sleep -Seconds 2 },
        [scriptblock]$OnSent = { param($job) }
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $seen = $null
    $status = $null
    $polls = 0
    $gonePolls = 0
    $remove = {
        param($why)
        if (-not $seen) { return $why }
        try { & $RemoveJob $Queue ([int]$seen.Id); return "$why; the test job was removed from the queue" }
        catch { return "$why; removing the test job from the queue failed: $($_.Exception.Message)" }
    }
    $result = { param($state, $msg) [pscustomobject]@{ State = $state; JobId = $(if ($seen) { [int]$seen.Id } else { $null }); JobStatus = $status; Message = $msg } }
    while ($true) {
        $polls++
        $job = @(@(& $GetJobs $Queue) | Where-Object { $_ -and $KnownJobIds -notcontains [int]$_.Id }) | Sort-Object { [int]$_.Id } | Select-Object -First 1
        if ($job) {
            $status = [string]$job.JobStatus
            if (-not $seen) { $seen = $job; & $OnSent $job }
            $gonePolls = 0
        } elseif ($seen) { $gonePolls++ }

        $events = @(@(& $GetEvents $Since) | Where-Object {
                $_ -and (@($_.Params) -contains $Queue) -and (-not $seen -or $null -eq $_.JobId -or [int]$_.JobId -eq [int]$seen.Id)
            })
        $fail = @($events | Where-Object { $_.EventId -eq 372 }) | Select-Object -First 1
        if ($fail) {
            if (-not $seen -and $null -ne $fail.JobId) { $seen = [pscustomobject]@{ Id = [int]$fail.JobId; JobStatus = 'Error' } }
            $code = if ($fail.ErrorCode) { " (Win32 error code $($fail.ErrorCode))" } else { '' }
            $why = "Windows could not print the job$(if ($null -ne $fail.JobId) { " $($fail.JobId)" }) (PrintService event 372)$code"
            if ($job) { $why = & $remove $why }
            return (& $result 'failed' $why)
        }
        $ok = @($events | Where-Object { $_.EventId -eq 307 }) | Select-Object -First 1
        if ($ok) {
            if (-not $seen -and $null -ne $ok.JobId) { $seen = [pscustomobject]@{ Id = [int]$ok.JobId; JobStatus = 'Printed' } }
            $status = 'Printed'
            return (& $result 'printed' "job$(if ($null -ne $ok.JobId) { " $($ok.JobId)" }) printed: Windows sent it to the printer (PrintService event 307)")
        }
        if ($job -and (Get-SpoolfreeJobOutcome $status) -eq 'failed') {
            return (& $result 'failed' (& $remove "spooler job $($job.Id): $status"))
        }
        if ($seen -and $gonePolls -ge 3) {
            return (& $result 'unknown' "spooler job $($seen.Id) left the queue, but Windows logged no printed or failed event for it (is the PrintService Operational log on?)")
        }
        if (-not $seen -and $polls -ge $QuietPolls) {
            return (& $result 'unknown' 'no job showed up in the queue and Windows logged no printed or failed event: the page may not have been sent')
        }
        if ((Get-Date) -ge $deadline) {
            $why = "still in the queue after $TimeoutSeconds s ($status): check the printer and the queue on this PC"
            return (& $result 'failed' (& $remove $why))
        }
        & $Sleep
    }
}

function Get-SpoolfreeTestPageLines {
    <# Pure: the text of the PC test page (below its title). #>
    param([Parameter(Mandatory)]$Command, [string]$Computer, [string]$Queue, [string]$Driver, [string]$Port, [string]$User, [datetime]$Now = (Get-Date))
    return @(
        "Printer:    $Queue",
        "Computer:   $Computer",
        "Driver:     $Driver",
        "Port:       $Port",
        "Sent:       from this PC through its Spoolfree queue$(if ($User) { " as $User" })",
        "Time:       $($Now.ToString('yyyy-MM-dd HH:mm:ss zzz', [Globalization.CultureInfo]::InvariantCulture))",
        "Reference:  $($Command.id)",
        '',
        'Check: the box 10 mm from the edges is complete and the text is sharp.',
        "Pages of random characters mean this PC's driver sends a format the",
        'printer does not understand: check the driver mode in Spoolfree.'
    )
}

function Send-SpoolfreeTestPage {
    <#
    .SYNOPSIS
        Prints the test page through the queue with its own driver (System.Drawing PrintDocument: mono, one-sided,
        an alignment box 10 mm from the paper edge). Falls back to the Windows test page (printui /k) when
        System.Drawing cannot print. Returns Route ('page' or 'windows-test-page') and Warning (why System.Drawing
        failed, kept for the result even when printui submits the Windows test page).
    #>
    param([Parameter(Mandatory)][string]$Queue, [Parameter(Mandatory)][string]$DocumentName, [Parameter(Mandatory)][AllowEmptyString()][string[]]$Lines, [string]$PrintToFile)
    try {
        Add-Type -AssemblyName System.Drawing
        $doc = New-Object System.Drawing.Printing.PrintDocument
        $doc.PrinterSettings.PrinterName = $Queue
        if (-not $doc.PrinterSettings.IsValid) { throw "Windows does not know a printer named '$Queue'." }
        $doc.DocumentName = $DocumentName
        # Tests and troubleshooting only: render through the driver into a file instead of the printer.
        if ($PrintToFile) { $doc.PrinterSettings.PrintToFile = $true; $doc.PrinterSettings.PrintFileName = $PrintToFile }
        $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
        try { $doc.DefaultPageSettings.Color = $false } catch { }
        try { if ($doc.PrinterSettings.CanDuplex) { $doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex } } catch { }
        $text = $Lines
        $handler = {
            param($sender, $e)
            $g = $e.Graphics
            $g.PageUnit = [System.Drawing.GraphicsUnit]::Millimeter
            # The origin is the printable area; move it to the paper edge.
            $g.TranslateTransform(-[float]($e.PageSettings.HardMarginX * 0.254), -[float]($e.PageSettings.HardMarginY * 0.254))
            $w = [float]($e.PageBounds.Width * 0.254)
            $h = [float]($e.PageBounds.Height * 0.254)
            $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 0.5
            $thin = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 0.2
            $g.DrawRectangle($pen, [float]10, [float]10, [float]($w - 20), [float]($h - 20))
            $title = New-Object System.Drawing.Font 'Arial', 22, ([System.Drawing.FontStyle]::Bold)
            $body = New-Object System.Drawing.Font 'Consolas', 10
            $g.DrawString('Spoolfree test page', $title, [System.Drawing.Brushes]::Black, [float]20, [float]20)
            $y = [float]38
            foreach ($l in $text) { $g.DrawString($l, $body, [System.Drawing.Brushes]::Black, [float]20, $y); $y += [float]6 }
            for ($i = 0; $i -le 100; $i++) {
                $len = if ($i % 10 -eq 0) { 6 } elseif ($i % 5 -eq 0) { 4 } else { 2.5 }
                $g.DrawLine($thin, [float](20 + $i), [float]($y + 6), [float](20 + $i), [float]($y + 6 + $len))
            }
            $g.DrawString('100 mm', $body, [System.Drawing.Brushes]::Black, [float]124, [float]($y + 6))
            $e.HasMorePages = $false
        }.GetNewClosure()
        $doc.add_PrintPage($handler)
        $doc.Print()
        $doc.Dispose()
        return [pscustomobject]@{ Route = 'page'; Warning = $null }
    } catch {
        $why = $_.Exception.Message
        if ($PrintToFile) { throw }
        # The Windows test page, through the same queue and driver. The queue name is checked and quoted (L1).
        try { $code = Invoke-SpoolfreePrintUi -Arguments @('/k', '/q', '/n', $Queue) }
        catch { throw "printing failed ($why) and the Windows test page could not be sent: $($_.Exception.Message)" }
        if ($code -ne 0) { throw "printing failed ($why) and printui /k exited with $code" }
        return [pscustomobject]@{ Route = 'windows-test-page'; Warning = "System.Drawing could not print ($why); the Windows test page was sent instead" }
    }
}

function Get-SpoolfreeInteractiveUser {
    <#
    .SYNOPSIS
        The logged-on interactive user (DOMAIN\name): the console user (Win32_ComputerSystem.UserName), else the owner
        of an explorer.exe (a Remote Desktop session). $null when nobody is logged on.
    #>
    param(
        [scriptblock]$GetConsoleUser = { [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName },
        [scriptblock]$GetShellOwners = {
            @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | ForEach-Object {
                    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
                    if ($o -and $o.ReturnValue -eq 0 -and $o.User) { "$($o.Domain)\$($o.User)" }
                })
        }
    )
    $u = $null
    try { $u = [string](& $GetConsoleUser) } catch { }
    if ($u) { return $u }
    try { $u = @(& $GetShellOwners | Where-Object { $_ }) | Select-Object -First 1 } catch { }
    if ($u) { return [string]$u }
    return $null
}

function Invoke-SpoolfreeTestPageJob {
    <#
    .SYNOPSIS
        Runs in the user's session (the one-off "Spoolfree Test Page" task, Invoke-SpoolfreeSync.ps1 -TestPageJob):
        reads queue, document name and lines from the job file, prints the page (Send-SpoolfreeTestPage) and writes
        { ok, route, warning, error } to the result file next to it. Never throws.
    #>
    param([Parameter(Mandatory)][string]$Path, [scriptblock]$Print = { param($q, $d, $l) Send-SpoolfreeTestPage -Queue $q -DocumentName $d -Lines $l })
    $resultPath = Join-Path (Split-Path -Parent $Path) 'result.json'
    $r = [ordered]@{ ok = $false; route = $null; warning = $null; error = $null; user = "$env:USERDOMAIN\$env:USERNAME" }
    try {
        $job = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        $sent = & $Print ([string]$job.queue) ([string]$job.documentName) ([string[]]@($job.lines | ForEach-Object { [string]$_ }))
        $r.ok = $true
        $r.route = [string](Get-SpoolfreeProperty $sent 'Route')
        $r.warning = Get-SpoolfreeProperty $sent 'Warning'
    } catch {
        $r.error = $_.Exception.Message
    }
    try { [IO.File]::WriteAllText($resultPath, ($r | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch { }
}

function New-SpoolfreeTestPageWorkDir {
    <#
    .SYNOPSIS
        A job directory for one test page: SYSTEM and Administrators full control, the user read only, and a
        result.json the user may write. Nothing else is shared with the user.
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$User)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $id = New-Object System.Security.Principal.SecurityIdentifier $sid
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    $userId = New-Object System.Security.Principal.NTAccount $User
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userId, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
    $result = Join-Path $Path 'result.json'
    [IO.File]::WriteAllText($result, '')
    $facl = Get-Acl -LiteralPath $result
    $facl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userId, 'Modify', 'Allow')))
    Set-Acl -LiteralPath $result -AclObject $facl
    return $Path
}

function Send-SpoolfreeTestPageAsUser {
    <#
    .SYNOPSIS
        0.8.1: prints the test page as the logged-on interactive user, not as SYSTEM. Print Support Apps (for example
        Brother's) run a per-user print workflow and fail jobs owned by SYSTEM, which has no user session. A one-off
        task "\Spoolfree\Spoolfree Test Page <id>" with the user's interactive principal runs
        Invoke-SpoolfreeSync.ps1 -TestPageJob <job.json>; the queue name and the page text travel in that file,
        never on a command line. Waits for the result (at most -TimeoutSeconds), then removes the task and the files.
        Throws "can't test: no user session ..." when nobody is logged on (nothing is printed), and on failure.
        Returns Route, Warning and User.
    #>
    param(
        [Parameter(Mandatory)][string]$Queue,
        [Parameter(Mandatory)][string]$DocumentName,
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$Lines,
        [int]$TimeoutSeconds = 90,
        [string]$User,
        [string]$WorkRoot = (Join-Path $env:ProgramData 'Spoolfree\TestPage'),
        [string]$SyncScript = (Join-Path $PSScriptRoot 'Invoke-SpoolfreeSync.ps1'),
        [scriptblock]$GetUser = { Get-SpoolfreeInteractiveUser },
        [scriptblock]$NewWorkDir = { param($path, $user) New-SpoolfreeTestPageWorkDir -Path $path -User $user },
        [scriptblock]$RegisterTask = {
            param($name, $user, $script, $jobFile)
            $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            # Only fixed paths on this command line (the install folder and a GUID-named job file): no names.
            $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -TestPageJob `"$jobFile`""
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
            Register-ScheduledTask -TaskName $name -TaskPath '\Spoolfree\' -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
            Start-ScheduledTask -TaskName $name -TaskPath '\Spoolfree\' -ErrorAction Stop
        },
        [scriptblock]$RemoveTask = { param($name) Unregister-ScheduledTask -TaskName $name -TaskPath '\Spoolfree\' -Confirm:$false -ErrorAction SilentlyContinue },
        [scriptblock]$Sleep = { Start-Sleep -Milliseconds 500 }
    )
    if (-not $User) { $User = [string](& $GetUser) }
    if (-not $User) { throw "can't test: no user session on this PC (nobody is logged on; the test page is printed as the logged-on user)" }
    $id = [guid]::NewGuid().ToString('N')
    $dir = Join-Path $WorkRoot $id
    $task = "$($script:TestPageTaskPrefix)$id"
    $registered = $false
    try {
        if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }
        & $NewWorkDir $dir $User | Out-Null
        $jobFile = Join-Path $dir 'job.json'
        $resultFile = Join-Path $dir 'result.json'
        $json = [ordered]@{ queue = $Queue; documentName = $DocumentName; lines = @($Lines) } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($jobFile, $json, (New-Object Text.UTF8Encoding($false)))
        $registered = $true
        & $RegisterTask $task $User $SyncScript $jobFile
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $r = $null
        while ((Get-Date) -lt $deadline) {
            $text = ''
            try { $text = [IO.File]::ReadAllText($resultFile) } catch { }
            if ($text.Trim()) { try { $r = $text | ConvertFrom-Json; break } catch { } }
            & $Sleep
        }
        if (-not $r) { throw "the test page task in $User's session did not finish within $TimeoutSeconds s" }
        if (-not [bool](Get-SpoolfreeProperty $r 'ok')) { throw "printing as ${User} failed: $(Get-SpoolfreeProperty $r 'error')" }
        return [pscustomobject]@{ Route = [string](Get-SpoolfreeProperty $r 'route'); Warning = (Get-SpoolfreeProperty $r 'warning'); User = $User }
    } finally {
        if ($registered) { try { & $RemoveTask $task } catch { } }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Remove-SpoolfreeTestPageTasks {
    <#
    .SYNOPSIS
        Removes one-off test page tasks left by an interrupted run: registered more than 15 minutes ago (a running test
        page is never touched), or with no readable registration date.
    #>
    param(
        [scriptblock]$GetTasks = { @(Get-ScheduledTask -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue) },
        [scriptblock]$Unregister = { param($name) Unregister-ScheduledTask -TaskName $name -TaskPath '\Spoolfree\' -Confirm:$false -ErrorAction SilentlyContinue },
        [datetime]$Now = (Get-Date)
    )
    foreach ($t in @(& $GetTasks | Where-Object { $_ -and ([string]$_.TaskName).StartsWith($script:TestPageTaskPrefix) })) {
        $at = [datetime]::MinValue
        $date = [string](Get-SpoolfreeProperty $t 'Date')
        if ($date -and [datetime]::TryParse($date, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$at) -and ($Now - $at).TotalMinutes -lt 15) { continue }
        & $Unregister ([string]$t.TaskName)
    }
}

function Enter-SpoolfreeCommandLock {
    <#
    .SYNOPSIS
        0.8.1 (L4): one command run at a time on the machine. Opens a lock file exclusively (FileShare None) and
        returns the open stream; close it to release (the system also releases it when the process ends). Returns
        $null when another run holds it after -WaitSeconds (0 = do not wait) or the file cannot be opened. The file
        lives in the install folder with an ACL of SYSTEM and Administrators only, so a user cannot open (squat) it,
        unlike the 0.8.0 named mutex.
    #>
    param([Parameter(Mandatory)][string]$Path, [int]$WaitSeconds = 0, [switch]$Secure, [scriptblock]$Sleep = { Start-Sleep -Milliseconds 500 })
    $deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $new = -not (Test-Path -LiteralPath $Path)
    while ($true) {
        try {
            $fs = New-Object IO.FileStream($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            if ($new -and $Secure) {
                try {
                    $acl = New-Object System.Security.AccessControl.FileSecurity
                    $acl.SetAccessRuleProtection($true, $false)
                    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
                        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', 'Allow')))
                    }
                    $fs.SetAccessControl($acl)
                } catch { }
            }
            return $fs
        } catch {
            if ((Get-Date) -ge $deadline) { return $null }
            & $Sleep
        }
    }
}

function Get-SpoolfreeCommandLockPath {
    <# The lock file: <install folder>\commands.lock (SYSTEM and Administrators only), else under %ProgramData%. #>
    $root = Join-Path $env:ProgramFiles 'Spoolfree'
    if (Test-Path -LiteralPath $root) { return (Join-Path $root 'commands.lock') }
    return (Join-Path $env:ProgramData 'Spoolfree\commands.lock')
}

function Invoke-SpoolfreeCommands {
    <#
    .SYNOPSIS
        Verifies and runs signed commands (test prints) and reports each result to /api/agent/commands/<id>. Returns
        how many ran. One run at a time on the machine (lock file), each id once.
        -LockWaitSeconds: how long to wait for another run (the hourly sync passes 0). -BudgetSeconds: the total time
        for this call (0 = no limit); a command that does not fit is left for the next run (it is not marked as run).
    #>
    param(
        [AllowEmptyCollection()]$Commands = @(),
        [Parameter(Mandatory)][string]$PublicKey,
        [Parameter(Mandatory)][string]$ObjectGuid,
        [string]$BaseUrl,
        [string]$Token,
        [string]$ServerId,
        [scriptblock]$Log = { param($m) },
        [scriptblock]$Report,
        [scriptblock]$Print,
        [scriptblock]$Wait,
        [scriptblock]$GetQueues = { @(Get-Printer -ErrorAction SilentlyContinue) },
        [scriptblock]$GetJobs = { param($q) @(Get-PrintJob -PrinterName $q -ErrorAction SilentlyContinue) },
        [scriptblock]$EnableEventLog = { try { Enable-SpoolfreePrintLog | Out-Null } catch { } },
        [AllowEmptyCollection()]$Installed,
        [string]$RunKey = $script:CommandRegistry,
        [string]$LockPath,
        [int]$LockWaitSeconds = 30,
        [int]$BudgetSeconds = 0,
        [datetime]$Now = [datetime]::UtcNow
    )
    $list = @($Commands | Where-Object { $_ })
    if ($list.Count -eq 0) { return 0 }
    $started = Get-Date
    if (-not $Report) { $Report = { param($id, $body) Invoke-SpoolfreeHttp -Uri "$BaseUrl/api/agent/commands/$id" -Method POST -Token $Token -Body $body | Out-Null } }
    if (-not $Print) { $Print = { param($queue, $docName, $lines, $timeout) Send-SpoolfreeTestPageAsUser -Queue $queue -DocumentName $docName -Lines $lines -TimeoutSeconds $timeout } }
    if (-not $Wait) { $Wait = { param($queue, $since, $known, $onSent, $timeout) Wait-SpoolfreePrintJob -Queue $queue -Since $since -KnownJobIds $known -OnSent $onSent -TimeoutSeconds $timeout } }
    $send = {
        param($id, $body)
        try { & $Report $id $body } catch { & $Log "Command ${id}: reporting '$($body.state)' failed: $($_.Exception.Message)" }
    }
    $secure = -not $LockPath
    if (-not $LockPath) { $LockPath = Get-SpoolfreeCommandLockPath }
    $lock = $null
    try { $lock = Enter-SpoolfreeCommandLock -Path $LockPath -WaitSeconds $LockWaitSeconds -Secure:$secure } catch { $lock = $null }
    if (-not $lock) { & $Log 'Commands: another run holds the lock (or it cannot be opened); trying again next time.'; return 0 }
    try {
        if ($null -eq $Installed) { $Installed = @(Get-SpoolfreeInstalled) }
        $ran = 0
        $logReady = $false
        foreach ($envelope in $list) {
            $left = if ($BudgetSeconds -gt 0) { $BudgetSeconds - ((Get-Date) - $started).TotalSeconds } else { 600 }
            if ($left -lt 20) { & $Log 'Commands: no time left in this run; the rest is left for the next run.'; break }
            try {
                $c = ConvertFrom-SpoolfreeCommand -Envelope $envelope -PublicKey $PublicKey -ObjectGuid $ObjectGuid -Now $Now
            } catch {
                & $Log "Command refused: $($_.Exception.Message)"
                continue
            }
            $id = ([string]$c.id).ToLowerInvariant()
            if (-not (Register-SpoolfreeCommandRun -Id $id -Key $RunKey -Now $Now)) { continue }
            $ran++
            $queues = @(& $GetQueues)
            $queue = Resolve-SpoolfreeCommandQueue -Command $c -Installed @($Installed) -Queues $queues -ServerId $ServerId
            if (-not $queue) {
                $why = "queue '$($c.printer.name)' is not a Spoolfree queue for this printer on this PC"
                & $Log "Command ${id} (test print): rejected: $why."
                & $send $id ([ordered]@{ state = 'rejected'; message = $why })
                continue
            }
            $q = @($queues | Where-Object { [string]$_.Name -eq $queue }) | Select-Object -First 1
            $lines = Get-SpoolfreeTestPageLines -Command $c -Computer $env:COMPUTERNAME -Queue $queue -Driver ([string]$q.DriverName) -Port ([string]$q.PortName)
            $docName = "Spoolfree test page $id"
            & $Log "Command ${id}: test print through '$queue' (driver '$($q.DriverName)')."
            if (-not $logReady) { & $EnableEventLog; $logReady = $true }
            $printTimeout = [int][Math]::Max(10, [Math]::Min(90, $left / 2))
            try {
                $known = @(@(& $GetJobs $queue) | Where-Object { $_ } | ForEach-Object { [int]$_.Id })
                $since = (Get-Date).AddSeconds(-2)
                $sent = & $Print $queue $docName $lines $printTimeout
                $warning = [string](Get-SpoolfreeProperty $sent 'Warning')
                $onSent = { param($job) & $send $id ([ordered]@{ state = 'sent'; jobId = [int]$job.Id; jobStatus = [string]$job.JobStatus; message = "spooler job $($job.Id) in '$queue'" }) }.GetNewClosure()
                $waitLeft = if ($BudgetSeconds -gt 0) { [int][Math]::Max(5, $BudgetSeconds - ((Get-Date) - $started).TotalSeconds - 5) } else { 120 }
                $r = & $Wait $queue $since $known $onSent ([Math]::Min(120, $waitLeft))
                $msg = [string]$r.Message
                if ($warning) { $msg = "$msg ($warning)" }
                & $Log "Command ${id}: $($r.State): $msg"
                & $send $id ([ordered]@{ state = [string]$r.State; jobId = $r.JobId; jobStatus = $(if ($r.JobStatus) { [string]$r.JobStatus } else { $null }); message = $msg })
            } catch {
                $why = $_.Exception.Message
                & $Log "Command ${id}: test print failed: $why"
                $msg = if ($why -like "can't test:*") { $why } else { "test print through '$queue' failed: $why" }
                & $send $id ([ordered]@{ state = 'failed'; message = $msg })
            }
        }
        return $ran
    } finally {
        try { $lock.Dispose() } catch { }
    }
}

function Get-SpoolfreeCommandPollMinutes {
    <# Pure: the poll interval from the manifest: 0 (off) or 1..60 minutes; invalid or missing => 0. #>
    param($Minutes)
    $m = 0
    if (-not [int]::TryParse([string]$Minutes, [ref]$m)) { return 0 }
    if ($m -le 0) { return 0 }
    if ($m -gt 60) { return 60 }
    return $m
}

function Get-SpoolfreeSyncCommandPlan {
    <#
    .SYNOPSIS
        Pure (0.8.1, M3): what the hourly sync does with the manifest's commands. 'defer' when the poll task runs them
        (poll interval > 0 and the task exists): the sync must never wait on a test print, so a stuck job cannot make
        the launcher count a timeout (and roll back a good agent version). Otherwise 'run' with no lock wait and a
        time budget far below the launcher's 12-minute limit. 'none' without commands.
    #>
    param([int]$PollMinutes, [bool]$TaskExists, [int]$Count, [int]$BudgetSeconds = 60)
    if ($Count -le 0) { return [pscustomobject]@{ Action = 'none'; LockWaitSeconds = 0; BudgetSeconds = 0 } }
    if ($PollMinutes -gt 0 -and $TaskExists) { return [pscustomobject]@{ Action = 'defer'; LockWaitSeconds = 0; BudgetSeconds = 0 } }
    return [pscustomobject]@{ Action = 'run'; LockWaitSeconds = 0; BudgetSeconds = $BudgetSeconds }
}

function Test-SpoolfreeCommandTask {
    <# Does the "Spoolfree Commands" task exist? #>
    return [bool](Get-ScheduledTask -TaskName $script:CommandTaskName -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue)
}

function Update-SpoolfreeCommandTask {
    <#
    .SYNOPSIS
        Creates, updates or removes the "Spoolfree Commands" task (SYSTEM, every N minutes): it runs
        <Root>\current\Invoke-SpoolfreeSync.ps1 -CommandsOnly, which polls /api/agent/commands. 0 removes it. Only
        changes the task when the interval changed (HKLM:\SOFTWARE\Spoolfree\CommandPollMinutes) or the task is
        missing. Returns the interval when it changed something, else $null.
    #>
    param($Minutes, [Parameter(Mandatory)][string]$Root)
    $m = Get-SpoolfreeCommandPollMinutes $Minutes
    $task = Get-ScheduledTask -TaskName $script:CommandTaskName -TaskPath '\Spoolfree\' -ErrorAction SilentlyContinue
    $current = Get-ItemProperty -Path $script:RegistryRoot -Name CommandPollMinutes -ErrorAction SilentlyContinue
    if ($m -eq 0) {
        if (-not $task -and -not $current) { return $null }
        if ($task) { Unregister-ScheduledTask -TaskName $script:CommandTaskName -TaskPath '\Spoolfree\' -Confirm:$false -ErrorAction Stop }
        Remove-ItemProperty -Path $script:RegistryRoot -Name CommandPollMinutes -ErrorAction SilentlyContinue
        return 0
    }
    if ($task -and $current -and [int]$current.CommandPollMinutes -eq $m) { return $null }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sync = Join-Path $Root 'current\Invoke-SpoolfreeSync.ps1'
    $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$sync`" -CommandsOnly"
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $m)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
    $system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $script:CommandTaskName -TaskPath '\Spoolfree\' -Action $action -Trigger $trigger -Settings $settings -Principal $system -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $script:RegistryRoot -Name CommandPollMinutes -Value $m -PropertyType DWord -Force | Out-Null
    return $m
}

function Set-SpoolfreeIdentityCache {
    <#
    .SYNOPSIS
        0.8.1 (M2): stores this computer's objectGUID in HKLM:\SOFTWARE\Spoolfree (ObjectGuid, also written at
        enrollment), so the minute command poll never asks AD. Writes only when it changed. Returns $true when it wrote.
    #>
    param([Parameter(Mandatory)][string]$ObjectGuid, [string]$Key = $script:RegistryRoot)
    $g = $ObjectGuid.ToLowerInvariant()
    $cur = Get-ItemProperty -Path $Key -Name ObjectGuid -ErrorAction SilentlyContinue
    if ($cur -and ([string]$cur.ObjectGuid).ToLowerInvariant() -eq $g) { return $false }
    New-ItemProperty -Path $Key -Name ObjectGuid -Value $g -PropertyType String -Force | Out-Null
    return $true
}

function Get-SpoolfreeAgentVersion { return $script:AgentVersion }

Export-ModuleMember -Function *-Spoolfree*
