import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { adminFromClaims } from "@/lib/admin-claims";
import { adminAccessPolicy, config, devLoginEnabled, localLoginEnabled } from "@/lib/config";
import { clientIp, LocalLogin } from "@/lib/local-auth/login";
import { DbLocalLoginStore } from "@/lib/local-auth/store-db";

declare module "next-auth" {
  interface Session {
    isAdmin: boolean;
    authError?: string;
    /** "entra", "local" (break-glass user) or "dev". */
    authMethod?: string;
  }
}

let localLogin: LocalLogin | null = null;
function local(): LocalLogin {
  const c = config();
  localLogin ??= new LocalLogin(new DbLocalLoginStore(), {
    enabled: localLoginEnabled(),
    maxFailures: c.LOCAL_LOGIN_MAX_FAILURES,
    lockoutMinutes: c.LOCAL_LOGIN_LOCKOUT_MINUTES,
    ipMaxAttempts: c.LOCAL_LOGIN_IP_MAX_ATTEMPTS,
    ipWindowMinutes: 15,
  });
  return localLogin;
}

const providers: NextAuthConfig["providers"] = [
  MicrosoftEntraID({
    // Request the groups claim; group IDs only, no Graph calls, no photo download.
    authorization: { params: { scope: "openid profile email" } },
    profile(profile) {
      return { id: profile.sub, name: profile.name, email: profile.email ?? profile.preferred_username, image: null };
    },
  }),
];

if (devLoginEnabled()) {
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Development login",
      credentials: {},
      authorize: async () => ({ id: "dev-admin", name: "Dev Admin", email: "admin@example.org" }),
    }),
  );
}

if (localLoginEnabled()) {
  providers.push(
    Credentials({
      id: "local",
      name: "Local break-glass account",
      credentials: { username: {}, password: {} },
      authorize: async (credentials, request) => {
        const username = typeof credentials?.username === "string" ? credentials.username : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!username || !password) return null;
        const r = await local().login({ username, password, ip: clientIp(request?.headers) });
        if (!r.ok) return null;
        return { id: `local:${r.user.id}`, name: r.user.username, email: `local:${r.user.username}` };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 8 * 3600 },
  trustHost: true,
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "dev-login" || account?.provider === "local") {
        token.isAdmin = true;
        token.authError = undefined;
        token.authMethod = account.provider === "local" ? "local" : "dev";
      } else if (account && profile) {
        const r = adminFromClaims(profile as Record<string, unknown>, adminAccessPolicy());
        token.isAdmin = r.isAdmin;
        token.authError = r.error;
        token.authMethod = "entra";
      }
      return token;
    },
    async session({ session, token }) {
      session.isAdmin = token.isAdmin === true;
      session.authError = typeof token.authError === "string" ? token.authError : undefined;
      session.authMethod = typeof token.authMethod === "string" ? token.authMethod : undefined;
      return session;
    },
  },
});
