import type { ReactNode } from "react";

interface BarMeterProps {
  /** Left-hand row label (category name, "Income", "Expenses", …). */
  label: ReactNode;
  /** Right-hand value text, e.g. a formatted sen amount. */
  trailing: ReactNode;
  /** 0..1 fill fraction — callers compute this against their own scale. */
  fraction: number;
  /** Bar fill color; defaults to the accent token. */
  color?: string;
}

/**
 * Simple horizontal bar meter — the v1 mockup's `.b-row` treatment
 * (label · track · trailing value), reused for both the spending-by-category
 * card and the income-vs-expense paired bars. Purely presentational: callers
 * own the money math and pass a precomputed 0..1 fraction.
 */
export function BarMeter({ label, trailing, fraction, color = "var(--accent)" }: BarMeterProps) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="grid grid-cols-[minmax(0,120px)_1fr_auto] items-center gap-3 py-1.5">
      <span className="truncate text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>
      <span className="h-2.5 overflow-hidden rounded-full" style={{ background: "var(--accent-track)" }}>
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="text-right text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
        {trailing}
      </span>
    </div>
  );
}
