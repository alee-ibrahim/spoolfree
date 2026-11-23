import {
  ActivityIcon,
  ChartColumnIcon,
  FolderTreeIcon,
  MonitorSmartphoneIcon,
  PackageIcon,
  PrinterIcon,
  ScrollTextIcon,
  SearchCheckIcon,
  ServerCogIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  /** Shorter label for the mobile bottom bar. */
  short?: string;
  icon: LucideIcon;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Status", icon: ActivityIcon },
      { href: "/analytics", label: "Analytics", icon: ChartColumnIcon },
      { href: "/agents", label: "Agents", icon: ServerCogIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/printers", label: "Printers", icon: PrinterIcon },
      { href: "/drivers", label: "Drivers", icon: PackageIcon },
      { href: "/assignments", label: "Assignments", short: "OUs", icon: FolderTreeIcon },
      { href: "/preview", label: "Preview", icon: SearchCheckIcon },
      { href: "/unassigned", label: "Unassigned PCs", icon: MonitorSmartphoneIcon },
    ],
  },
  {
    label: "Admin",
    items: [{ href: "/audit", label: "Audit log", icon: ScrollTextIcon }],
  },
];

/** The four destinations on the mobile bottom bar; everything else is under "More" (the sidebar sheet). */
export const BOTTOM_NAV = ["/", "/printers", "/assignments", "/analytics"];

export function isActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
