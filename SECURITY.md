# Security

## Reporting a vulnerability

Please report vulnerabilities privately using GitHub's **"Report a vulnerability"** (Security Advisories) on this repository. Do not open a public issue. Expect an acknowledgement within a week.

## Threat model (v0.1)

### Assets

| Asset | Where | Impact if compromised |
|---|---|---|
| Manifest signing key (Ed25519 seed) | Server secret `MANIFEST_SIGNING_KEY` | Attacker could make agents install printer queues pointing at an attacker-controlled IPP endpoint, and jobs sent there could be read. **From 0.4.3 the attacker can also push agent code that runs as SYSTEM on every enrolled PC** (self-update). |
| Enrollment token | Server secret + restricted share | Attacker can enroll as any **existing, enabled** computer and read that computer's printer list. |
| Per-machine token | PC registry, DPAPI LocalMachine | Attacker can read that one computer's printer list and file fake reports for it. |
| Admin session | Browser cookie (Auth.js JWT, encrypted with `AUTH_SECRET`) | Full control of printer policy. |
| LDAP bind password | Server secret (in snapshot mode: only the adsync sidecar) | Read access to the directory (the same as any domain user). |
| Directory sync token | Server secret `DIRECTORY_SYNC_TOKEN` (snapshot mode) | Attacker who can also reach `/api/internal/directory-snapshot` could replace the directory snapshot: move computers between OUs (other printers) or mark them disabled. Keep the path off the ingress. |

### Trust boundaries and controls

**Admin UI**
- Login is by Entra ID OIDC (optionally automatic, `AUTH_AUTO_SIGNIN`), plus optional break-glass local accounts (below). Who gets in through Entra depends on `ADMIN_ACCESS_MODE` (see [docs/admin-access.md](docs/admin-access.md)):
  - `group` (default): the ID token's `groups` claim must contain one of `ADMIN_GROUP_IDS`. Group overage tokens (no `groups` list) are refused.
  - `entra-assignment`: every user who signs in through the single-tenant Entra app is an admin. **"Assignment required" MUST be enabled on the enterprise app in this mode**; otherwise every account in the tenant becomes a Spoolfree admin. The token's `tid` and `iss` must both match the tenant in `AUTH_MICROSOFT_ENTRA_ID_ISSUER`, and a `common`, `organizations` or `consumers` issuer is refused.
  - A production server refuses to start in `group` mode with an empty `ADMIN_GROUP_IDS`, or in `entra-assignment` mode without a single-tenant issuer.
  - The check runs at login, and the session lasts 8 hours.
  - Every server action re-checks the session.
- All changes are written to the audit log, with the actor's e-mail.
- **Break-glass local accounts** (`LOCAL_LOGIN_ENABLED`, **off by default**) exist for when Entra ID is down. They are created only with `scripts/local-user.ts` (password from stdin or a hidden prompt, never argv; no self-signup), stored as argon2id hashes, and offered only at `/login?local=1`. Accounts lock after 5 wrong passwords for 15 minutes, each IP gets 20 attempts per 15 minutes, unknown and disabled usernames cost the same argon2 work, and every attempt is audit-logged; the UI marks such sessions with a "local" badge. They bypass Entra MFA and conditional access, so keep the feature off, keep the password in a vault, and disable the account after use. See [docs/admin-access.md](docs/admin-access.md#break-glass-local-accounts).
- Automatic sign-in never loops: Auth.js errors, sign-out, `?local=1` and a one-minute guard cookie all stop the redirect.
- The development login and fake directory are compiled out of production builds: they depend on `NODE_ENV !== "production"`, which `next build` fixes at build time.

**Manifest integrity (server → agent)**
- Every manifest is a base64 JSON payload with an **Ed25519 signature over the exact bytes**. No JSON canonicalisation is needed.
- The agent pins the public key at install time, in `HKLM:\SOFTWARE\Spoolfree` (ACL: SYSTEM and Administrators). A different key passed later is ignored unless `-Force` is used.
- The agent rejects a manifest if any of these fail:
  - the signature is bad;
  - `computer.objectGuid` is not its own;
  - `expiresAt` has passed (default TTL 24 h). This limits replay of old manifests.
- Compromising TLS or the network therefore cannot redirect printers. Only the signing key can.

**Agent self-update (0.4.3+)**
- **Threat model, plainly:** whoever can sign with the manifest key can run code as SYSTEM on every enrolled PC. In practice that means the key itself, or anyone who controls the Spoolfree server or its image, because the server holds the key. This is the same trust the manifest already needs, and the same as the GPO share the agent was installed from. Treat the server, its image and `MANIFEST_SIGNING_KEY` like a software-deployment system, not like a printer list.
- Agents accept a bundle only if all of these hold:
  - its SHA-256 matches the signed manifest;
  - a detached Ed25519 signature over the exact bundle bytes verifies with the **pinned** key;
  - its file names come from a fixed list of four (no paths);
  - every file matches its hash;
  - its version is the one offered.
- An unsigned or mismatched bundle is never installed, and neither is a downgrade, unless the signed manifest sets `agentAllowDowngrade` (`AGENT_ALLOW_DOWNGRADE`).
- The bundle is downloaded with the machine token. TLS or a network attacker can at most block an update, not change it.
- Installing stages the files and then swaps folders. The staged folder must not be writable by anyone but SYSTEM and Administrators, or the swap is refused.
- A launcher that self-update never replaces rolls back a version that fails twice, and never re-installs that bundle on the PC.
- `AGENT_SELF_UPDATE=0` turns it off (the manifest stops offering a bundle and `/api/agent/bundle` answers 404). That does not reduce what a key holder could do, because the key also controls the printers. It only stops updates.
- The bundle and the manifest are signed with one key. They cannot be swapped for each other: a manifest needs `schema: 1` and this PC's `objectGuid`, and a bundle needs `type: "spoolfree-agent-bundle"`.

**Agent authentication (agent → server)**
- *Enrollment.* The GPO startup script, running as SYSTEM, reads a shared enrollment token from a file on a share readable only by Domain Computers. The token is never on the command line, because GPO script parameters are readable by every user. The server then:
  - checks the token (constant-time);
  - looks the computer up in AD **by `objectGUID`**;
  - requires it to exist, be enabled, and match the claimed DN and name;
  - issues a random 256-bit per-machine token, storing only its SHA-256 hash, bound to the `objectGUID`.
- *Token storage.* The machine token is encrypted with DPAPI (LocalMachine scope) in a registry key readable only by SYSTEM and Administrators.
- *Every request.* The server maps the bearer token to its `objectGUID` and queries AD **live**:
  - disabled or deleted computer accounts are refused immediately;
  - the OU used for policy is always the one in AD. The client never asserts it.
  - With `DIRECTORY_MODE=snapshot` the lookup uses the last snapshot from the AD sync sidecar instead (default every 5 minutes), so a disable or move takes effect at the next sync. If no snapshot is younger than `DIRECTORY_MAX_AGE_HOURS` (default 24), agents are refused with 503 (fail closed).
- *Revocation.* Revoking an agent in the UI invalidates its token. The PC re-enrolls at its next startup if it can still read the enrollment token.

**What an attacker can do**

| Attacker | Can | Cannot |
|---|---|---|
| Ordinary domain user on a PC | See which printers exist (as today) | Read the machine token (DPAPI + ACL), read the enrollment token (share ACL), change queues |
| Local admin on one PC | Read that PC's machine token and the enrollment token (it runs as the computer account); enroll as **other** computers and read their printer lists; file fake reports | Change any PC's printers (no signing key); affect other PCs' queues |
| Network attacker (MITM) | Block syncs (PCs keep their current queues) | Inject printers (signature) |
| Holder of the signing key (or of the server) | Redirect printing anywhere; from 0.4.3 run code as SYSTEM on enrolled PCs (self-update) | (rotate the key: see below) |

Printer lists are low-sensitivity, so the residual risk of the shared enrollment token is accepted for v0.1. A planned stronger mode binds enrollment to the computer account itself, either with Kerberos/Negotiate (the agent authenticates as `COMPUTER$`) or with AD CS machine certificates over mutual TLS. Either would remove the shared secret.

**Status poller and printers**
- The poller sends read-only IPP Get-Printer-Attributes requests and SNMP v2c GETs.
- For `ipps://` it skips certificate validation, because printers use self-signed certificates and only public status data is read.
- PCs print directly to printers over IPP/IPPS. Use IPPS where printers support it, and put printers on a network segment that is filtered appropriately.

**Server hardening**
- Non-root container with a read-only root filesystem in the Helm chart.
- LDAPS with a configurable CA and TLS 1.2+, or (snapshot mode) Kerberos SASL GSSAPI with a sealed connection (the sidecar refuses a security strength factor below 128). The sidecar keeps its keytab and ticket cache in a memory-backed volume and reads the password from a mounted file only.
- `/api/internal/directory-snapshot` answers 404 unless `DIRECTORY_MODE=snapshot`, 503 when `DIRECTORY_SYNC_TOKEN` is unset or shorter than 32 characters, and 401 without the exact bearer token. Snapshots of another base DN, with objects outside it, duplicates or no computers are rejected.
- No secrets in images. `*_FILE` variants are available for secrets mounted as files.
- `/metrics` can require a bearer token (`METRICS_TOKEN`).
- Admin-only routes are not reachable without a session. `/api/agent/*`, `/api/internal/*` (sync token), `/healthz` and `/metrics` are the only unauthenticated-by-session endpoints.

### Key rotation

1. `pnpm keygen`, and deploy the new `MANIFEST_SIGNING_KEY`.
2. Update the GPO parameters with the new public key and add `-Force` for one boot cycle. (`-Force` also re-installs the share's agent files over a self-updated version; put the current release's files on the share first.) (v0.1 does not support two keys at once, so expect a short window of rejected manifests. PCs keep their existing queues during it.)
3. Rotating the enrollment token only needs the server secret and the share file updated. Already-enrolled PCs are unaffected.

### Print analytics and privacy (0.5.0+)

Print analytics is **off by default** (`ANALYTICS_ENABLED`). When it is on, agents send the PC's PrintService
"document printed" events (event 307) to `/api/agent/jobs`. That endpoint is authenticated like every agent endpoint:
a per-machine token, then a live directory check. Each event carries the time, user, PC, queue, port host, pages and
size. Document names are sent and stored only with `ANALYTICS_COLLECT_DOCUMENT_NAMES=1`; otherwise the agent never
sends them, and the server drops any it receives.

- **What is kept.** Jobs are kept for `ANALYTICS_RETENTION_DAYS` (default 365), and an hourly purge deletes older
  rows. Database backups keep data until they expire.
- **Who can see it.** Only admins can see the Analytics page and download the CSV export. The export neutralises
  spreadsheet formulas.
- **What is never collected.** Document contents, page images, file paths and print settings.
- **Tell staff.** Print logs are personal data. Tell staff that printing is logged, what is kept and for how long,
  before you turn analytics on.

How to turn it off and delete the data: [docs/analytics.md](docs/analytics.md#privacy).
