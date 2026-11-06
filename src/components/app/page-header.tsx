import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Sticky page header: sidebar toggle (tablet/desktop), title and actions. On phones the bottom bar replaces the
 * toggle, and actions wrap under the title instead of squeezing it.
 */
export function PageHeader({
  title,
  description,
  actions,
  wideActions = false,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Actions take a full row under the title on phones (pickers, filters). */
  wideActions?: boolean;
}) {
  return (
    <>
      <header className="sticky top-0 z-30 flex min-h-14 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <SidebarTrigger className="-ml-1 hidden md:inline-flex" />
        <Separator orientation="vertical" className="mr-2 hidden data-[orientation=vertical]:h-4 md:block" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold md:text-base md:font-medium">{title}</h1>
        {actions && <div className={wideActions ? "flex w-full flex-wrap items-center gap-2 sm:w-auto" : "flex flex-wrap items-center gap-2"}>{actions}</div>}
      </header>
      {description && <p className="px-4 pt-4 text-sm text-muted-foreground md:px-6">{description}</p>}
    </>
  );
}
