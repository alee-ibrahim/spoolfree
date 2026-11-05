import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export interface Admin {
  name: string;
  email: string;
  /** Signed in with a break-glass local account (shown with a "local" badge). */
  local: boolean;
}

/** Use in every admin page and server action. Redirects to /login otherwise. */
export async function requireAdmin(): Promise<Admin> {
  const session = await auth();
  if (!session?.user || !session.isAdmin) redirect("/login");
  const local = session.authMethod === "local";
  return { name: session.user.name ?? "admin", email: session.user.email ?? (local ? "local" : "unknown"), local };
}
