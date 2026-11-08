<div align="center">

# Spoolfree

**Driverless printer management for Windows Active Directory.**<br/>
No print server. No printer drivers. PrintNightmare-safe.

[![CI](https://img.shields.io/github/actions/workflow/status/alee-ibrahim/spoolfree/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/alee-ibrahim/spoolfree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PowerShell 5.1+](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE)](agent)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6)](docs/agent.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

Spoolfree gives each Windows PC local, machine-wide **driverless IPP queues** that print straight to the printer through the inbox *Microsoft IPP Class Driver*. You pick which PCs get which printers by **AD OU**; a small PowerShell agent applies a **signed manifest** on each PC.

> **Status:** v0.4, usable for pilots. See [limitations](#limitations).

## Why

- **PrintNightmare** fixes made Point-and-Print driver installs admin-only, and many shops switched off spooler RPC to print servers.
- **Windows Protected Print Mode** (Windows 11 24H2) blocks third-party drivers completely.
- Most printers since ~2015 speak **IPP Everywhere / AirPrint / Mopria**, so Windows needs no vendor driver.
- What was missing is the management layer: *which PC gets which printer, which is default, is it out of toner?*

## Features

| | |
|---|---|
| **Entra ID login** | OIDC sign-in (automatic by default), limited to admins; optional break-glass local accounts. |
| **Printers** | Add, edit, delete, [bulk import/export](docs/deployment.md#bulk-import-and-export), delete/rename from the [CLI](docs/deployment.md#deleting-and-renaming-printers). **Test** checks driverless support over IPP and detects the IPP path (`/ipp/print`, `/ipp`, `/ipp/printer`, `/printers/lp1`, `/`; manual override possible); **Replace** swaps the device and keeps the name; default duplex; takeover of old queues for the same device (on for new printers, `DEFAULT_LEGACY_TAKEOVER`), including old host names that are no longer in DNS, in the form's collapsed **Advanced (migration)** section. |
| **OU assignments** | Read-only LDAP(S) view of AD with inheritance, block rules, per-OU defaults and per-computer overrides. Assign OUs (and the per-OU default) and specific PCs (per-computer overrides) straight from the Add/Edit printer form, with a live "will reach N computers" count that counts each PC once. |
| **Vendor drivers** | For printers the IPP Class Driver cannot drive, or drives too slowly (IPP 1.x only, no driverless format, slow old colour lasers): **auto driver mode** (default) switches just those printers to a signed vendor driver. It picks the exact-model package by IEEE 1284 device ID, or the brand's universal driver. Agents check the SHA-256 and the catalog's Authenticode signature, and switch without leaving the PC printerless. [docs/drivers.md](docs/drivers.md). |
| **Preview** | "What will computer X get?", with a step-by-step trace and the exact manifest. |
| **Unassigned PCs** | Computers in `CN=Computers`, or whose OU chain gets no printers. |
| **Status dashboard** | IPP polling with SNMP fallback: online/offline, toner, jams, paper-out, page count; optional webhook alerts. |
| **Agents view** | Last check-in, applied printers and errors per PC; a red alert when a takeover left a PC without a printer; revoke a PC's token. |
| **Print analytics** | Opt-in. Jobs from each PC's print log and printer page counters: pages over time; top users, PCs, printers and OUs; pages not sent from PCs; unmanaged queues; a job log with CSV export. [Privacy notes](docs/analytics.md#privacy). |
| **Phone-friendly** | Bottom navigation, cards instead of tables, 44 px touch targets, light and dark themes. |
| **Ops** | Audit log of every admin change, Prometheus `/metrics`, `/healthz`. |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/01-printers.png" alt="Printers"/><br/><sub><b>Printers</b>: driverless check and replace</sub></td>
    <td width="50%"><img src="docs/screenshots/02-assignments.png" alt="Assignments"/><br/><sub><b>Assignments</b>: printers by OU</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/03-status.png" alt="Status"/><br/><sub><b>Status</b>: toner, jams, online state</sub></td>
    <td width="50%"><img src="docs/screenshots/04-agents.png" alt="Agents"/><br/><sub><b>Agents</b>: per-PC check-ins and errors</sub></td>
  </tr>
</table>

<sub>Screenshots use the built-in development mode with sample data.</sub>

## Architecture

```mermaid
flowchart LR
  admin(["Admin browser<br/>Entra SSO"])

  subgraph server["Spoolfree server"]
    direction TB
    app["Next.js app<br/>UI + agent API"]
    poller["Status poller"]
    db[("PostgreSQL")]
    app --- db
    poller --- db
  end

  ad[("Active Directory")]

  subgraph pc["Windows PC"]
    direction TB
    agent["Agent<br/>SYSTEM task via GPO"]
    queues["Driverless IPP queues"]
    agent -->|creates| queues
  end

  printers[["Printers"]]

  admin -->|HTTPS| app
  app <-->|"LDAP (read-only)"| ad
  app -->|"signed manifest<br/>HTTPS"| agent
  poller -->|"IPP / SNMP"| printers
  queues -->|"IPP print jobs"| printers
```

**How it works**

1. An admin assigns printers to OUs in the web UI.
2. At startup and every `AGENT_SYNC_INTERVAL_MINUTES` (default 15), each PC's agent requests its manifest with a per-machine token.
3. The server looks the PC up in AD by `objectGUID` (the OU always comes from AD, never the client), resolves inheritance and overrides, and signs the manifest with **Ed25519**.
4. The agent checks the signature against its pinned public key, the computer identity and the expiry.
5. It creates, re-points or removes the queues it owns, records the default printer, and reports back.
6. When the server ships a different agent version, the agent downloads it, checks its hash and signature against the same pinned key, and swaps it in. The new version runs at the next sync and is rolled back if it fails twice.

## Quick start

Development mode needs no AD or Entra. Requires Node.js 24.7+, pnpm and Docker.

```bash
pnpm install
docker compose up -d postgres          # PostgreSQL on 127.0.0.1:55432
cp .env.example .env                   # then set DEV_FAKE_AD=1, DEV_LOGIN=1, AUTH_SECRET
pnpm keygen --env >> .env              # signing key + enrollment token
pnpm seed:dev                          # sample printers, assignments and agents
pnpm dev:printers                      # (separate terminal) fake IPP printers on :8631-8635
pnpm dev                               # http://localhost:3000 -> "Development login"
```

`DEV_FAKE_AD=1` swaps LDAP for a built-in `example.org` directory; `DEV_LOGIN=1` skips Entra. **Production builds ignore both.**

## Deploy

**Server:** one non-root container (`docker build -t spoolfree .`) runs the UI, API and poller; migrations run at startup. For Kubernetes use the Helm chart in [`deploy/helm/spoolfree`](deploy/helm/spoolfree) with [`deploy/values.example.yaml`](deploy/values.example.yaml). Multiple replicas are safe.

**PCs (one GPO):**

1. Run `pnpm keygen`; store the signing key and enrollment token as secrets, keep the public key.
2. Copy `agent/*` to a share PCs can read, e.g. `\\example.org\NETLOGON\spoolfree\`.
3. Put the enrollment token in a file on a share only **Domain Computers** can read (never SYSVOL/NETLOGON).
4. Add `Install-SpoolfreeAgent.ps1` as a computer startup script with `-ServerUrl https://spoolfree.example.org -PublicKey <key> -EnrollmentTokenPath <token file>`.
5. Reboot a test PC; it shows up under **Agents** within minutes.

Domains that require LDAP signing and have no LDAPS certificate can use the optional Kerberos [AD sync sidecar](docs/deployment.md#ad-sync-sidecar-kerberos) instead.

Full guide, including the Entra app registration and the read-only AD account: [docs/deployment.md](docs/deployment.md). Agent internals: [docs/agent.md](docs/agent.md).

## Configuration

Everything is an environment variable, documented in [`.env.example`](.env.example). Secrets can also be read from files (`MANIFEST_SIGNING_KEY_FILE`, `AGENT_ENROLLMENT_TOKEN_FILE`).

<details>
<summary><b>All environment variables</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | | **Required.** PostgreSQL connection string. |
| `PUBLIC_URL` | | **Required.** External URL of the app. |
| `MIGRATE_ON_START` | `1` | Apply database migrations at startup. |
| `AUTH_SECRET` | | **Required.** Random 32+ byte session secret. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` | | **Required.** Entra app client ID and secret. |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | | **Required.** `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `AUTH_AUTO_SIGNIN` | on with Entra | Skip the login page and go straight to Entra ([details](docs/admin-access.md#automatic-sign-in)). |
| `LOCAL_LOGIN_ENABLED` | `false` | Break-glass local accounts at `/login?local=1` ([details](docs/admin-access.md#break-glass-local-accounts)). |
| `ADMIN_GROUP_IDS` | | **Required.** Comma-separated Entra group object IDs allowed to sign in. |
| `DIRECTORY_MODE` | `ldap` | `ldap`, or `snapshot` for the [AD sync sidecar](docs/deployment.md#ad-sync-sidecar-kerberos). |
| `DIRECTORY_SYNC_TOKEN` | | Snapshot mode: sidecar token (32+ characters). |
| `DIRECTORY_STALE_MINUTES` / `DIRECTORY_MAX_AGE_HOURS` | `30` / `24` | Snapshot mode: UI warning / agents refused. |
| `LDAP_URL` | | e.g. `ldaps://dc1.example.org:636` |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` | | Read-only service account. |
| `LDAP_BASE_DN` | | e.g. `DC=example,DC=org` |
| `LDAP_CA_CERT_FILE` | | PEM CA for validating the DC's LDAPS certificate. |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` only for testing. |
| `LDAP_CACHE_SECONDS` | `300` | Cache for OU and computer lists. Agent auth always queries live. |
| `MANIFEST_SIGNING_KEY` | | **Required.** Base64 Ed25519 seed from `pnpm keygen`. |
| `AGENT_ENROLLMENT_TOKEN` | | **Required.** Shared enrollment token from `pnpm keygen`. |
| `AGENT_SYNC_INTERVAL_MINUTES` | `15` | How often agents sync (5-240); agents update their own task, no GPO change. |
| `MANIFEST_TTL_HOURS` | `24` | Manifest validity (replay protection). |
| `AGENT_STALE_HOURS` | `26` | Agents without a report for this long show as stale. |
| `AGENT_SELF_UPDATE` | `1` | Offer the agent scripts in the image to agents (0.4.3+), which install them themselves. See [docs/agent.md](docs/agent.md#self-update). |
| `AGENT_ALLOW_DOWNGRADE` | `0` | Let agents install an older bundled version than they run (for rolling back a release). |
| `AGENT_BUNDLE_DIR` | `./agent` | Directory with the agent scripts served as the bundle (`/app/agent` in the image). |
| `POLLER_ENABLED` | `1` | Run the status poller. |
| `POLL_INTERVAL_SECONDS` | `120` | Poll interval. |
| `POLL_TIMEOUT_MS` | `5000` | Per-printer timeout. |
| `POLL_CONCURRENCY` | `8` | Printers polled in parallel. |
| `SNMP_COMMUNITY` | `public` | SNMP v2c community for the Printer-MIB fallback. |
| `LOW_TONER_PERCENT` | `15` | Low-toner threshold. |
| `ALERT_WEBHOOK_URL` | | POST a JSON alert on offline / jam / low toner and recovery. |
| `DEFAULT_LEGACY_TAKEOVER` | `on` | Takeover setting a printer added in the web UI starts with: `on`, `dry-run` or `off` ([takeover](docs/agent.md#legacy-queue-takeover)). Editing keeps a printer's value; the bulk CLI is unchanged (`off` unless the file says otherwise). |
| `LEGACY_PRINT_SERVERS` | | Old print servers whose `\\server\share` queues agents may replace ([takeover](docs/agent.md#legacy-queue-takeover)). |
| `ANALYTICS_ENABLED` | `0` | Print analytics: agents collect print jobs from the PCs' print log ([docs/analytics.md](docs/analytics.md)). |
| `ANALYTICS_COLLECT_DOCUMENT_NAMES` | `0` | Also collect document names. Personal data: see the privacy notes first. |
| `ANALYTICS_RETENTION_DAYS` | `365` | Print jobs and daily page counters older than this are deleted (hourly purge). |
| `ANALYTICS_TIME_ZONE` | `UTC` | IANA time zone for daily buckets (charts, counters). |
| `DRIVER_PACKAGE_MAX_MB` | `200` | Largest vendor driver package (zip), stored in Postgres ([docs/drivers.md](docs/drivers.md)). |
| `DRIVER_AUTO_SLOW_SECONDS_PER_PAGE` | `20` | Auto driver mode: a median above this (over `DRIVER_AUTO_SLOW_MIN_JOBS`=3 jobs of at least `DRIVER_AUTO_SLOW_MIN_PAGES`=2 pages) means slow. |
| `DRIVER_AUTO_SPEED_INTERVAL_MINUTES` | `30` | How often the poller reads completed IPP jobs to measure speed; `0` turns it off. |
| `METRICS_TOKEN` | | Bearer token required to scrape `/metrics`. |
| `DEV_FAKE_AD`, `DEV_FAKE_AD_FILE`, `DEV_LOGIN` | `0` | Development only; ignored by production builds. |

</details>

<details>
<summary><b>Security model (summary)</b></summary>

- Admin login is Entra ID (automatic redirect by default), gated on the `groups` claim or app assignment; optional break-glass local accounts are off by default; every change is audit-logged.
- Manifests carry an **Ed25519 signature** over the exact bytes. Agents pin the public key and reject bad signatures, the wrong computer, or expired manifests, so a network attacker cannot inject printers.
- PCs enroll with a shared token read from a Domain Computers-only share, then get a per-machine token (stored DPAPI-encrypted; only its hash is kept server-side).
- Every agent request is checked live against AD by `objectGUID`; disabled or deleted computers are refused.
- Vendor drivers (opt-in per printer, or auto mode) are installed only from admin-uploaded packages whose SHA-256 is in the signed manifest and whose catalog has a valid Authenticode signature; never under Windows Protected Print Mode.
- Spoolfree never writes to AD.

Full threat model and key rotation: [SECURITY.md](SECURITY.md).

</details>

<details>
<summary><b>Limitations</b></summary>

- `Add-Printer -IppURL` is verified on Windows 11 25H2 with WPP off over plain IPP. Windows 10 22H2, WPP on and IPPS queues are untested. See [real-device findings](docs/agent.md#real-device-findings).
- Laptops in Modern Standby apply changes at the next wake, not on the hour.
- IPPS printers with self-signed certificates may need their certificate trusted on PCs.
- No per-user printer targeting; per-computer only.
- SNMP v2c only.
- The webhook payload is generic JSON (no Teams or Slack formats yet).
- The enrollment token is a shared secret; Kerberos or certificate-based machine auth is on the roadmap.

</details>

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and ground rules.

## Licence

[MIT](LICENSE) © Alee Ibrahim
