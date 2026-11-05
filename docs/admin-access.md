# Admin access

Only people who sign in with Microsoft Entra ID (OIDC) reach the admin UI. `ADMIN_ACCESS_MODE` decides which of them are admins.

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
