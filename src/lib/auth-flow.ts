/**
 * Automatic Entra sign-in (like Grafana's auto_login): a signed-out visit to /login goes straight to Entra,
 * unless one of these says "stay on the page":
 *   ?local=1      the break-glass page (also the escape hatch when Entra is down)
 *   ?signedout=1  just signed out (otherwise you would be signed straight back in)
 *   ?error=...    Auth.js reported a sign-in error (e.g. user not assigned to the Entra app)
 *   authError     signed in to Entra but not allowed into Spoolfree
 *   guard cookie  an automatic attempt started less than a minute ago and came back here: stop the loop
 */
export const AUTO_SIGNIN_GUARD_COOKIE = "spoolfree-auto-signin";
export const AUTO_SIGNIN_GUARD_SECONDS = 60;

export function shouldAutoSignIn(input: {
  enabled: boolean;
  params: Record<string, string | string[] | undefined>;
  authError?: string | null;
  guardCookie?: string | null;
}): boolean {
  if (!input.enabled || input.authError || input.guardCookie) return false;
  const p = input.params;
  return !p.local && !p.signedout && !p.error;
}

/**
 * AUTH_AUTO_SIGNIN default: on when Entra is configured and is the only provider shown on the plain
 * /login page (the development login adds a second one). Local break-glass users do not count: they
 * only appear at /login?local=1.
 */
export function autoSignInEnabled(input: { setting: string | undefined; entraConfigured: boolean; devLogin: boolean }): boolean {
  if (!input.entraConfigured) return false;
  const s = input.setting?.trim().toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return !input.devLogin;
}
