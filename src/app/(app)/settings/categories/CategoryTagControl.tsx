"use client";

import { startTransition, useState } from "react";
import { updateCategoryTag } from "@/app/(app)/budget/actions";
import type { Tag } from "@/lib/budget";

const OPTIONS: Array<{ value: Tag; label: string }> = [
  { value: "needs", label: "Needs" },
  { value: "wants", label: "Wants" },
  { value: "savings", label: "Savings" },
];

/** Compact needs/wants/savings segmented control (mockup v3 `.seg-mini`
 *  visual vocabulary) for a top-level expense category. Subcategories inherit
 *  the parent's tag for guide math and have no control of their own; income
 *  categories have no budget tag to edit. Optimistic with rollback + a
 *  visible error on failure — same pattern as `RecurringRuleRow`'s
 *  `ArchiveToggle`. */
export function CategoryTagControl({ categoryId, tag }: { categoryId: string; tag: Tag }) {
  const [current, setCurrent] = useState(tag);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function select(next: Tag) {
    if (next === current || pending) return;
    const prev = current;
    setCurrent(next);
    setPending(true);
    setError(undefined);
    startTransition(() => {
      void updateCategoryTag(categoryId, next).then((result) => {
        setPending(false);
        if (!result.ok) {
          setCurrent(prev);
          setError(result.error);
        }
      });
    });
  }

  return (
    <div className="flex flex-shrink-0 flex-col gap-1">
      <div
        className="flex overflow-hidden rounded-lg"
        style={{ border: "1px solid var(--border)", opacity: pending ? 0.6 : 1 }}
      >
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={pending}
            onClick={() => select(opt.value)}
            className="px-2 py-1 text-[11px]"
            style={{
              background: current === opt.value ? "var(--chip)" : "transparent",
              color: current === opt.value ? "var(--ink-1)" : "var(--ink-3)",
              fontWeight: current === opt.value ? 650 : 400,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {error ? (
        <span className="text-[11px]" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
