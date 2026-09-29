"use client";

import { startTransition, useState } from "react";
import { setAllocationBucket } from "./actions";
import { defaultBucket, type Bucket } from "@/lib/allocation";

const OPTIONS: Array<{ value: Bucket; label: string }> = [
  { value: "bank", label: "Bank" },
  { value: "cashlike", label: "Cash-like" },
  { value: "equities", label: "Equities" },
  { value: "exclude", label: "Exclude" },
];

/** Compact bank/cash-like/equities/exclude segmented control (mockup v4
 *  `.seg-mini` visual vocabulary), Task-8 contract — mirrors
 *  CategoryTagControl.tsx exactly (same optimistic-with-rollback pattern).
 *  `bucket` is the raw column value (null until the owner picks one
 *  explicitly); the control shows defaultBucket(type) until then, so the
 *  displayed selection never lies about what the allocation math is using
 *  (ruling 12). */
export function AllocationBucketControl({
  accountId,
  accountType,
  bucket,
}: {
  accountId: string;
  accountType: string;
  bucket: Bucket | null;
}) {
  const [current, setCurrent] = useState<Bucket>(bucket ?? defaultBucket(accountType));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function select(next: Bucket) {
    if (next === current || pending) return;
    const prev = current;
    setCurrent(next);
    setPending(true);
    setError(undefined);
    startTransition(() => {
      void setAllocationBucket(accountId, next).then((result) => {
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
