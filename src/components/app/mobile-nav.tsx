"use client";

import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { BOTTOM_NAV, isActive, NAV_GROUPS } from "./nav";

/**
 * Bottom navigation for phones (below md): the four most used pages plus "More", which opens the sidebar as a sheet.
 * Hidden from md up, where the sidebar is always there.
 */
export function MobileNav() {
  const pathname = usePathname();
  const { setOpenMobile, openMobile } = useSidebar();
  const items = NAV_GROUPS.flatMap((g) => g.items).filter((i) => BOTTOM_NAV.includes(i.href));
  const inMore = !items.some((i) => isActive(i.href, pathname));
  const itemClass = "h-auto min-h-14 flex-1 flex-col gap-1 rounded-none px-1 py-2 text-[0.7rem] font-medium";
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden"
    >
      {items.map((i) => {
        const active = isActive(i.href, pathname);
        return (
          <Button key={i.href} asChild variant="ghost" className={cn(itemClass, active ? "text-foreground" : "text-muted-foreground")}>
            <Link href={i.href} aria-current={active ? "page" : undefined}>
              <i.icon className={cn("size-5", active && "stroke-[2.5]")} aria-hidden />
              <span>{i.short ?? i.label}</span>
            </Link>
          </Button>
        );
      })}
      <Button
        variant="ghost"
        className={cn(itemClass, inMore || openMobile ? "text-foreground" : "text-muted-foreground")}
        onClick={() => setOpenMobile(true)}
        aria-haspopup="dialog"
        aria-expanded={openMobile}
      >
        <MenuIcon className={cn("size-5", inMore && "stroke-[2.5]")} aria-hidden />
        <span>More</span>
      </Button>
    </nav>
  );
}
