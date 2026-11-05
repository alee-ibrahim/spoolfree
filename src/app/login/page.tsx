import { PrinterIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { auth, signIn, signOut } from "@/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { devLoginEnabled } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await auth();
  if (session?.isAdmin) redirect("/");
  const params = await searchParams;
  const error = session?.authError ?? (params.error ? "Sign-in failed. Try again or contact your administrator." : null);

  async function entra() {
    "use server";
    await signOut({ redirect: false });
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }
  async function dev() {
    "use server";
    await signIn("dev-login", { redirectTo: "/" });
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <PrinterIcon className="size-5" />
          </div>
          <CardTitle>Spoolfree</CardTitle>
          <CardDescription>Sign in with your organisation account. Only members of the admin group have access.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Access denied</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form action={entra}>
            <Button type="submit" className="w-full">
              Sign in with Microsoft Entra ID
            </Button>
          </form>
          {devLoginEnabled() && (
            <form action={dev}>
              <Button type="submit" variant="outline" className="w-full">
                Development login (no Entra)
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
