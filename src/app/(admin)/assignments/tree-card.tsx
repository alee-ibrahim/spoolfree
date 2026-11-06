"use client";

import { ChevronsUpDownIcon, NetworkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * The directory card. On phones the tree is collapsed behind the selected OU's name (open when nothing is selected
 * yet), so the OU's settings are visible without scrolling past the whole tree; from lg up it is always open.
 */
export function TreeCard({ selectedLabel, defaultOpen, children }: { selectedLabel: string; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="h-fit gap-3 py-4 lg:gap-6 lg:py-6">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="px-4 lg:px-6">
          <CardTitle className="flex items-center gap-2">
            <NetworkIcon className="size-4" aria-hidden /> Directory
          </CardTitle>
          <CardDescription className="hidden lg:block">Printers assigned to an OU flow down to its child OUs.</CardDescription>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="mt-2 w-full justify-between lg:hidden" aria-label={`Choose OU (selected: ${selectedLabel})`}>
              <span className="truncate">{selectedLabel}</span>
              <ChevronsUpDownIcon aria-hidden />
            </Button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent forceMount className="data-[state=closed]:hidden lg:data-[state=closed]:block">
          <CardContent className="px-0 pt-3 lg:pt-0">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
