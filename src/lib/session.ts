import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export interface Admin {
  name: string;
  email: string;
}

/** Use in every admin page and server action. Redirects to /login otherwise. */
export async function requireAdmin(): Promise<Admin> {
  const session = await auth();
  if (!session?.user || !session.isAdmin) redirect("/login");
  return { name: session.user.name ?? "admin", email: session.user.email ?? "unknown" };
}
