import { SearchXIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/** Empty state for a filtered list: says nothing matched and offers to clear the filters. */
export function NoMatches({ what, clearHref }: { what: string; clearHref: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No {what} match</EmptyTitle>
        <EmptyDescription>Try fewer words in the search, or another filter.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href={clearHref}>Clear filters</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
