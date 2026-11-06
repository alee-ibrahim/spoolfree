import { AppSidebar } from "@/components/app/app-sidebar";
import { DirectorySyncAlert } from "@/components/app/directory-sync-status";
import { MobileNav } from "@/components/app/mobile-nav";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { signOut } from "@/auth";
import { fakeAdEnabled } from "@/lib/config";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const user = await requireAdmin();
  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login?signedout=1" });
  }
  return (
    <SidebarProvider>
      <AppSidebar user={user} devMode={fakeAdEnabled()} signOutAction={signOutAction} />
      {/* Bottom padding keeps content clear of the mobile bottom bar (and the home indicator). */}
      <SidebarInset className="min-w-0 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <DirectorySyncAlert />
        {children}
      </SidebarInset>
      <MobileNav />
    </SidebarProvider>
  );
}
