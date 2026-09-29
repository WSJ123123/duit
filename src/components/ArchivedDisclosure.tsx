"use client";

import { useState, type ReactNode } from "react";
import { ActionLink } from "@/components/DialogKit";

/**
 * The house `Archived (n)` disclosure (Plan 6 shipped it for holdings in
 * HoldingsTable.tsx; Plan 7 ruling 14 needs it for the Net Worth page's four
 * lists). Collapsed by default, same link vocabulary — the only thing this
 * copy changes is the container, because the Net Worth lists are stacked divs
 * rather than table rows and cannot reuse a `<tr colSpan>` shell.
 *
 * `children` are rendered by the SERVER component that owns the list and
 * passed straight through, so no row markup has to cross into client code.
 */
export function ArchivedDisclosure({ count, children }: { count: number; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  if (count === 0) return null;
  return (
    <div className="pt-2.5">
      <ActionLink onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide archived" : `Archived (${count})`}
      </ActionLink>
      {expanded ? children : null}
    </div>
  );
}
