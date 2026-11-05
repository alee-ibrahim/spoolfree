import { PrinterIcon } from "lucide-react";
import { AuthError } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { AUTO_SIGNIN_GUARD_COOKIE, shouldAutoSignIn } from "@/lib/auth-flow";
import { autoSignIn, devLoginEnabled, localLoginEnabled } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await auth();
  if (session?.isAdmin) redirect("/");
  const params = await searchParams;
  const guard = (await cookies()).get(AUTO_SIGNIN_GUARD_COOKIE)?.value;
  if (shouldAutoSignIn({ enabled: autoSignIn(), params, authError: session?.authError, guardCookie: guard })) {
    redirect("/login/auto");
  }

  const showLocal = localLoginEnabled() && Boolean(params.local);
  const localError = params.error === "local";
  const entraError = session?.authError ?? (params.error && !localError ? "Sign-in failed. Try again or contact your administrator." : null);

  async function entra() {
    "use server";
    await signOut({ redirect: false });
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }
  async function dev() {
    "use server";
    await signIn("dev-login", { redirectTo: "/" });
  }
  async function localSignIn(form: FormData) {
    "use server";
    try {
      await signIn("local", { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? ""), redirectTo: "/" });
    } catch (e) {
      if (e instanceof AuthError) redirect("/login?local=1&error=local");
      throw e;
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <PrinterIcon className="size-5" />
          </div>
          <CardTitle>Spoolfree</CardTitle>
          <CardDescription>Sign in with your organisation account. Only Spoolfree administrators have access.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {entraError && (
            <Alert variant="destructive">
              <AlertTitle>Access denied</AlertTitle>
              <AlertDescription>{entraError}</AlertDescription>
            </Alert>
          )}
          {params.signedout && !entraError && (
            <Alert>
              <AlertTitle>Signed out</AlertTitle>
              <AlertDescription>You have been signed out of Spoolfree.</AlertDescription>
            </Alert>
          )}
          <form action={entra}>
            <Button type="submit" className="w-full">
              {entraError ? "Try again" : "Sign in with Microsoft Entra ID"}
            </Button>
          </form>
          {devLoginEnabled() && (
            <form action={dev}>
              <Button type="submit" variant="outline" className="w-full">
                Development login (no Entra)
              </Button>
            </form>
          )}
          {showLocal && (
            <>
              <Separator className="my-2" />
              <form action={localSignIn}>
                <FieldGroup>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Break-glass account</span>
                    <Badge variant="outline">local</Badge>
                  </div>
                  {localError && (
                    <Alert variant="destructive">
                      <AlertDescription>Wrong username or password, or the account is locked.</AlertDescription>
                    </Alert>
                  )}
                  <Field>
                    <FieldLabel htmlFor="username">Username</FieldLabel>
                    <Input id="username" name="username" autoComplete="username" required maxLength={64} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
                  </Field>
                  <Button type="submit" variant="outline" className="w-full">
                    Sign in with a local account
                  </Button>
                </FieldGroup>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
