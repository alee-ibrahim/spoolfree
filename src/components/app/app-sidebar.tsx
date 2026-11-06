"use client";

import { Badge } from "@/components/ui/badge";
import { LogOutIcon, PrinterIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { ModeToggle } from "./mode-toggle";
import { isActive, NAV_GROUPS } from "./nav";

export function AppSidebar({ user, devMode, signOutAction }: { user: { name: string; email: string; local?: boolean }; devMode: boolean; signOutAction: () => Promise<void> }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // On phones the sidebar is a sheet: close it when a page is chosen.
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/" onClick={close}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <PrinterIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Spoolfree</span>
                  <span className="truncate text-xs text-muted-foreground">Driverless printing</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => {
                  const active = isActive(item.href, pathname);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <Link href={item.href} onClick={close} aria-current={active ? "page" : undefined}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {devMode && (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Development mode: fake AD and dev login" className="text-amber-700 dark:text-amber-500">
                <TriangleAlertIcon />
                <span>Dev mode (fake AD)</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <ModeToggle />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <form action={signOutAction}>
              <SidebarMenuButton type="submit" tooltip="Sign out">
                <LogOutIcon />
                <span className="truncate">{user.name} · Sign out</span>
                {user.local && (
                  <Badge variant="outline" title="Signed in with a break-glass local account">
                    local
                  </Badge>
                )}
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
