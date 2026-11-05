# Production deployment

- **Container:** `docker build -t spoolfree .` gives a single non-root image that serves the UI and API and runs the poller. Migrations run at startup (`MIGRATE_ON_START=1`).
- **Kubernetes:** a generic Helm chart is in [`deploy/helm/spoolfree`](../deploy/helm/spoolfree), with an example in [`deploy/values.example.yaml`](../deploy/values.example.yaml). Secrets come from an existing Secret that you manage.
- **Configuration:** everything is set through environment variables, all documented in [`.env.example`](../.env.example).
- **Multiple replicas:** safe. A Postgres advisory lock makes sure only one replica polls printers at a time.

## 1. Entra ID app registration

1. Register an app (single tenant). Add the redirect URI `https://spoolfree.example.org/api/auth/callback/microsoft-entra-id`.
2. Create a client secret.
3. Under **Token configuration**, add a **groups claim** (Security groups, *Group ID*).
   - For users who belong to many groups, use **"Groups assigned to the application"**. This avoids the 200-group overage, which Spoolfree rejects with a clear message.
4. Set `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` (`https://login.microsoftonline.com/<tenant-id>/v2.0`) and `ADMIN_GROUP_IDS` (the admin group's object ID).

## 2. Read-only AD account

Create a plain user (for example `svc-spoolfree`). It needs no extra rights: authenticated users can already read OUs and computer objects.

- Use `ldaps://` and point `LDAP_CA_CERT_FILE` at your AD CS root CA (PEM).
- Spoolfree never writes to AD.

## 3. Keys

Run `pnpm keygen` once:

- store `MANIFEST_SIGNING_KEY` and `AGENT_ENROLLMENT_TOKEN` in your secret store;
- keep the printed **public key** for the GPO.

## 4. GPO setup (agent)

1. Copy the files from `agent/` (`Install-SpoolfreeAgent.ps1`, `Invoke-SpoolfreeSync.ps1`, `Set-SpoolfreeUserDefault.ps1`, `Spoolfree.Agent.psm1`) to a share that computers can read, for example `\\example.org\NETLOGON\spoolfree\`.
2. Write the enrollment token to a file on a **restricted** share, for example `\\fs01.example.org\spoolfree$\enroll.token`:
   - share and NTFS permissions: **Domain Computers: Read**, Domain Admins: Full. **Not** Authenticated Users or Domain Users.
   - **Do not use SYSVOL or NETLOGON for the token.** Every user can read those.
3. Create a GPO linked to the OUs that hold your PCs. Under *Computer Configuration → Policies → Windows Settings → Scripts → Startup → PowerShell Scripts*, add:
   - Script: `\\example.org\NETLOGON\spoolfree\Install-SpoolfreeAgent.ps1`
   - Parameters: `-ServerUrl https://spoolfree.example.org -PublicKey <public key> -EnrollmentTokenPath \\fs01.example.org\spoolfree$\enroll.token`
4. Recommended: in the same GPO, set *Computer Configuration → Administrative Templates → System → Logon → "Always wait for the network at computer startup and logon"* = Enabled.
5. Reboot a test PC. Within a few minutes it appears under **Agents**.
   - Sync log: `C:\ProgramData\Spoolfree\Logs\sync.log`.
   - Scheduled tasks: under `\Spoolfree\`.

The installer is idempotent, so leaving it as a startup script is fine. It also updates the agent files when you update the share.
