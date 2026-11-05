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

$script:AgentVersion = '0.4.0'
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

function Get-SpoolfreeLegacyMatches {
    <#
    .SYNOPSIS
        Pure: the non-Spoolfree queues that point at the same device as $Printer.
    .PARAMETER Queues
        Objects with Name, Type (Local/Connection), PortName, DriverName, Comment.
    .PARAMETER Ports
        Hashtable PortName -> object with Monitor, Description, HostAddress, Addresses (resolved IPs).
    .PARAMETER PrinterAddresses
        The printer's host name(s) and resolved IPs, lower-case.
    .PARAMETER ConnectionsOnly
        Only consider \\server\share connections (per-user logon task).
    .OUTPUTS
        Objects with Queue and Reason (use @(...) around the call).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Printer,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Queues,
        [AllowNull()][hashtable]$Ports = @{},
        [AllowEmptyCollection()][string[]]$PrinterAddresses = @(),
        [AllowEmptyCollection()][string[]]$LegacyServers = @(),
        [AllowEmptyCollection()][string[]]$Installed = @(),
        [switch]$ConnectionsOnly
    )
    $out = New-Object System.Collections.Generic.List[object]
    if ((Get-SpoolfreeLegacyMode $Printer) -eq 'off') { return }
    if ($null -eq $Ports) { $Ports = @{} }
    $legacy = Get-SpoolfreeProperty $Printer 'legacy'
    $shares = @{}
    foreach ($s in @(Get-SpoolfreeProperty $legacy 'shares')) { if ($s) { $shares[([string]$s).Trim().ToLowerInvariant()] = $true } }
    $addr = @{}
    foreach ($a in @($PrinterAddresses)) { if ($a) { $addr[$a.ToLowerInvariant()] = $true } }
    $mine = @{}
    foreach ($n in @($Installed)) { if ($n) { $mine[$n.ToLowerInvariant()] = $true } }
    $target = ([string](Get-SpoolfreeProperty $Printer 'name')).ToLowerInvariant()

    foreach ($q in @($Queues)) {
        $name = [string](Get-SpoolfreeProperty $q 'Name')
        if (-not $name) { continue }
        $lname = $name.ToLowerInvariant()
        if ($lname -eq $target -or $mine.ContainsKey($lname)) { continue }
        if (([string](Get-SpoolfreeProperty $q 'Comment')).StartsWith($script:CommentPrefix)) { continue }

        $conn = [regex]::Match($name, '^\\\\([^\\]+)\\(.+)$')
        $isConnection = $conn.Success -or ([string](Get-SpoolfreeProperty $q 'Type')) -eq 'Connection'
        if ($isConnection) {
            if (-not $conn.Success) { continue }
            $server = $conn.Groups[1].Value
            $share = $conn.Groups[2].Value
            if ((Test-SpoolfreeLegacyServer -Server $server -Servers $LegacyServers) -and $shares.ContainsKey($share.ToLowerInvariant())) {
                $out.Add([pscustomobject]@{ Queue = $name; Reason = "print server connection \\$server\$share" })
            }
            continue
        }
        if ($ConnectionsOnly -or $addr.Count -eq 0) { continue }

        $portName = [string](Get-SpoolfreeProperty $q 'PortName')
        $port = if ($portName -and $Ports.ContainsKey($portName)) { $Ports[$portName] } else { $null }
        if (Test-SpoolfreeVirtualQueue -Queue $q -Port $port) { continue }

        $hostAddress = ([string](Get-SpoolfreeProperty $port 'HostAddress')).Trim().ToLowerInvariant()
        $candidates = New-Object System.Collections.Generic.List[string]
        foreach ($a in @(Get-SpoolfreeProperty $port 'Addresses')) { if ($a) { $candidates.Add(([string]$a).ToLowerInvariant()) } }
        $monitor = [string](Get-SpoolfreeProperty $port 'Monitor')
        $urlHost = Get-SpoolfreeUrlHost $portName
        if (-not $urlHost) { $urlHost = Get-SpoolfreeUrlHost $hostAddress }

        $kind = $null; $label = $null
        if ($portName -match '^WSD-' -or $monitor -eq 'WSD Port') {
            # Only when the impure layer found the device's address; otherwise unidentifiable.
            $kind = 'WSD port'
        } elseif ($urlHost) {
            $kind = 'IPP port'; $label = $urlHost; $candidates.Add($urlHost)
        } elseif ($hostAddress -or $monitor -eq 'Standard TCP/IP Port') {
            $kind = 'TCP/IP port'; $label = $hostAddress
            if ($hostAddress) { $candidates.Add($hostAddress) }
        } else { continue }

        $hit = $null
        foreach ($c in $candidates) { if ($addr.ContainsKey($c)) { $hit = $c; break } }
        if (-not $hit) { continue }
        if (-not $label) { $label = $hit }
        $out.Add([pscustomobject]@{ Queue = $name; Reason = "$kind $label" })
    }
    # Emitted one by one: wrap calls in @() for an array (empty => @()).
    return $out.ToArray()
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

function Get-SpoolfreeWsdAddresses {
    <# Best effort: URL-looking values stored for a WSD port. Empty when the address is not detectable. #>
    param([Parameter(Mandatory)][string]$PortName)
    $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\WSD Port\Ports\$PortName"
    $out = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $key)) { return @() }
    $props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    if (-not $props) { return @() }
    foreach ($p in $props.PSObject.Properties) {
        if ($p.Name -like 'PS*' -or -not ($p.Value -is [string])) { continue }
        $h = Get-SpoolfreeUrlHost $p.Value
        if ($h) { $out.Add($h); foreach ($a in (Resolve-SpoolfreeAddress $h)) { $out.Add($a) } }
    }
    return @($out | Select-Object -Unique)
}

function Get-SpoolfreePortInventory {
    <# Hashtable PortName -> Monitor, Description, HostAddress, Addresses (resolved). #>
    $ports = @{}
    foreach ($p in @(Get-PrinterPort -ErrorAction SilentlyContinue)) {
        $name = [string]$p.Name
        $hostAddress = ''
        if ($p.PSObject.Properties['PrinterHostAddress'] -and $p.PrinterHostAddress) { $hostAddress = [string]$p.PrinterHostAddress }
        $monitor = if ($p.PSObject.Properties['PortMonitor']) { [string]$p.PortMonitor } else { '' }
        $addresses = @()
        $urlHost = Get-SpoolfreeUrlHost $name
        if ($hostAddress) { $addresses = Resolve-SpoolfreeAddress $hostAddress }
        elseif ($urlHost) { $addresses = Resolve-SpoolfreeAddress $urlHost }
        elseif ($name -match '^WSD-' -or $monitor -eq 'WSD Port') { $addresses = Get-SpoolfreeWsdAddresses -PortName $name }
        $ports[$name] = [pscustomobject]@{ Monitor = $monitor; Description = [string]$p.Description; HostAddress = $hostAddress; Addresses = @($addresses) }
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
