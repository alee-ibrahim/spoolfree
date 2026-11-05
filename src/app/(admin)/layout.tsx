import { AppSidebar } from "@/components/app/app-sidebar";
import { DirectorySyncAlert } from "@/components/app/directory-sync-status";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { signOut } from "@/auth";
import { fakeAdEnabled } from "@/lib/config";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const user = await requireAdmin();
  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }
  return (
    <SidebarProvider>
      <AppSidebar user={user} devMode={fakeAdEnabled()} signOutAction={signOutAction} />
      <SidebarInset>
        <DirectorySyncAlert />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
