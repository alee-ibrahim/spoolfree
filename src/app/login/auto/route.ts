import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { AUTO_SIGNIN_GUARD_COOKIE, AUTO_SIGNIN_GUARD_SECONDS } from "@/lib/auth-flow";
import { autoSignIn, config } from "@/lib/config";

/**
 * GET /login/auto: starts the Entra sign-in (AUTH_AUTO_SIGNIN). /login sends signed-out visitors here.
 * A short-lived cookie marks the attempt; if the visitor lands on /login again while it is set, the page
 * shows the button instead of redirecting again (no loops).
 */
export async function GET() {
  if (!autoSignIn()) redirect("/login");
  (await cookies()).set(AUTO_SIGNIN_GUARD_COOKIE, "1", {
    maxAge: AUTO_SIGNIN_GUARD_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: config().PUBLIC_URL.startsWith("https:"),
    path: "/",
  });
  await signIn("microsoft-entra-id", { redirectTo: "/" });
}
