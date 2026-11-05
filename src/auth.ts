import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { adminFromClaims } from "@/lib/admin-claims";
import { config, devLoginEnabled } from "@/lib/config";

declare module "next-auth" {
  interface Session {
    isAdmin: boolean;
    authError?: string;
  }
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

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 8 * 3600 },
  trustHost: true,
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "dev-login") {
        token.isAdmin = true;
        token.authError = undefined;
      } else if (account && profile) {
        const r = adminFromClaims(profile as Record<string, unknown>, config().ADMIN_GROUP_IDS);
        token.isAdmin = r.isAdmin;
        token.authError = r.error;
      }
      return token;
    },
    async session({ session, token }) {
      session.isAdmin = token.isAdmin === true;
      session.authError = typeof token.authError === "string" ? token.authError : undefined;
      return session;
    },
  },
});
