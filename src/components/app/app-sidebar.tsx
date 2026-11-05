"use client";

import {
  ActivityIcon,
  FolderTreeIcon,
  LogOutIcon,
  MonitorSmartphoneIcon,
  PrinterIcon,
  ScrollTextIcon,
  SearchCheckIcon,
  ServerCogIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
} from "@/components/ui/sidebar";

const groups = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Status", icon: ActivityIcon },
      { href: "/agents", label: "Agents", icon: ServerCogIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/printers", label: "Printers", icon: PrinterIcon },
      { href: "/assignments", label: "Assignments", icon: FolderTreeIcon },
      { href: "/preview", label: "Preview", icon: SearchCheckIcon },
      { href: "/unassigned", label: "Unassigned PCs", icon: MonitorSmartphoneIcon },
    ],
  },
  {
    label: "Admin",
    items: [{ href: "/audit", label: "Audit log", icon: ScrollTextIcon }],
  },
];

export function AppSidebar({ user, devMode, signOutAction }: { user: { name: string; email: string }; devMode: boolean; signOutAction: () => Promise<void> }) {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
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
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => {
                  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                        <Link href={item.href}>
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
              <SidebarMenuButton tooltip="Development mode: fake AD and dev login" className="text-amber-600">
                <TriangleAlertIcon />
                <span>Dev mode (fake AD)</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <form action={signOutAction}>
              <SidebarMenuButton type="submit" tooltip="Sign out">
                <LogOutIcon />
                <span className="truncate">
                  {user.name} · Sign out
                </span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
