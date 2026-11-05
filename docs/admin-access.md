# Admin access

People sign in with Microsoft Entra ID (OIDC). `ADMIN_ACCESS_MODE` decides which of them are admins. Optional [break-glass local accounts](#break-glass-local-accounts) cover the case where Entra is down.

| Mode | Who is an admin | Entra setup |
|---|---|---|
| `group` (default) | Members of one of the groups in `ADMIN_GROUP_IDS` | Groups claim (Security groups, *Group ID*); "Groups assigned to the application" avoids the 200-group overage |
| `entra-assignment` | Every user the Entra app lets sign in | **"Assignment required" switched on** for the enterprise app; assign users or groups to it. No groups claim needed |

## `group` mode

1. In the app registration, under **Token configuration**, add a **groups claim** (Security groups, *Group ID*).
2. Set `ADMIN_GROUP_IDS` to the admin group's object ID (several IDs: comma-separated).

A production server refuses to start when `ADMIN_GROUP_IDS` is empty in this mode, so a missing setting can never leave the UI open or locked by accident.

## `entra-assignment` mode

Use it when you would rather manage access in the enterprise application's **Users and groups** page than in a dedicated security group.

1. In **Enterprise applications** → the app → **Properties**, set **Assignment required?** = **Yes**.
   **This is mandatory.** Without it, every account in the tenant can sign in and becomes a Spoolfree admin.
2. Under **Users and groups**, assign the people (or groups) who should administer Spoolfree.
3. Set:
   ```
   ADMIN_ACCESS_MODE=entra-assignment
   AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   ```
   `ADMIN_GROUP_IDS` is ignored.

Spoolfree still checks every ID token: its `tid` claim and its `iss` must both match the tenant in `AUTH_MICROSOFT_ENTRA_ID_ISSUER`. A multi-tenant issuer (`common`, `organizations`, `consumers`) is refused, and a production server will not start with one in this mode. Removing a user's assignment stops new sign-ins; an existing session ends within its 8-hour lifetime.

## Automatic sign-in

With `AUTH_AUTO_SIGNIN` on (the default when Entra is configured and the development login is off), a signed-out visit to any admin page goes straight to Entra, with no button page in between (like Grafana's auto login). The login page stays on screen instead when:

- the URL has `?local=1` (the escape hatch, and where break-glass accounts sign in);
- you just signed out (`/login?signedout=1`), so you are not signed straight back in;
- Entra or Auth.js reported an error (for example a user who is not assigned to the app): the page shows it with a **Try again** button;
- you are signed in to Entra but not a Spoolfree admin;
- an automatic attempt started less than a minute ago and came back (a short-lived cookie stops redirect loops).

Set `AUTH_AUTO_SIGNIN=false` to always show the button.

## Break-glass local accounts

Off by default. For when Entra ID is unavailable. Turn on with `LOCAL_LOGIN_ENABLED=true`, then create an account with the CLI from a checkout that can reach the database (`DATABASE_URL`, e.g. through `kubectl port-forward`):

```sh
npx tsx scripts/local-user.ts add breakglass          # password: hidden prompt (twice), or the first line of stdin
your-secret-manager read breakglass | npx tsx scripts/local-user.ts reset breakglass
npx tsx scripts/local-user.ts list | unlock <user> | disable <user> | enable <user> | delete <user>
```

The password is never taken from the command line (minimum 12 characters; use a long random one kept in your vault). There is no self-signup and no UI to create accounts.

- Sign in at `/login?local=1`. The form is not shown on the normal login page, so everyone else keeps the automatic Entra sign-in.
- Passwords are stored as argon2id hashes (Node.js built-in `crypto.argon2`, 19 MiB, 2 passes).
- After `LOCAL_LOGIN_MAX_FAILURES` (5) wrong passwords the account is locked for `LOCAL_LOGIN_LOCKOUT_MINUTES` (15). Each client IP gets `LOCAL_LOGIN_IP_MAX_ATTEMPTS` (20) attempts per 15 minutes (counted per replica).
- Every attempt (success, failure, lockout, rate limit) and every CLI change is in the audit log; actions by a local account are logged as `local:<username>`, and the sidebar shows a **local** badge.
- Local accounts are full admins and skip Entra's MFA and conditional access: keep the feature off unless you need it, and disable the account again after use.
