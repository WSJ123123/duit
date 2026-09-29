"use client";

import { useState } from "react";
import { chartSeries } from "@/lib/networth";
import { useMoney } from "@/components/Money";
import { Tip } from "@/components/Tip";

const RANGES = ["3M", "6M", "1Y", "All"] as const;
type Range = (typeof RANGES)[number];

interface NetWorthChartProps {
  snapshots: Array<{ date: string; total_sen: number }>;
  todayIso: string;
  liveTotalSen: number;
}

function monthAbbrev(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

/** First-appearance-order unique month labels across the series — flex
 *  space-between spaces them evenly regardless of count (house convention,
 *  matching the mockup's Mar…Aug axis for the default 6M range). */
function axisLabels(series: Array<{ date: string }>): string[] {
  const out: string[] = [];
  let lastMonth = "";
  for (const s of series) {
    const month = s.date.slice(0, 7);
    if (month !== lastMonth) {
      out.push(monthAbbrev(s.date));
      lastMonth = month;
    }
  }
  return out;
}

const VIEW_W = 1000;
const VIEW_H = 190;
const TOP_PAD = 12;
const BOTTOM_PAD = 12;

/** Index-spaced x, min/max-scaled y — same coordinate system as the mockup's
 *  static SVG (viewBox 0 0 1000 190, baseline near y=188). */
function toPoints(series: Array<{ total_sen: number }>): string {
  const values = series.map((s) => s.total_sen);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const n = series.length;
  return series
    .map((s, i) => {
      const x = n === 1 ? VIEW_W : (i / (n - 1)) * VIEW_W;
      const y = VIEW_H - BOTTOM_PAD - ((s.total_sen - min) / span) * (VIEW_H - TOP_PAD - BOTTOM_PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function lastPoint(series: Array<{ total_sen: number }>): { x: number; y: number } {
  const points = toPoints(series).split(" ");
  const [x, y] = points[points.length - 1]!.split(",").map(Number);
  return { x: x!, y: y! };
}

/** Snapshot line card (v5 §6 binding). Range is client state (default 6M);
 *  fewer than 2 points (no history yet — cron hasn't snapshotted) renders
 *  the live total + a Tip instead of an empty chart (contract: never blank). */
export function NetWorthChart({ snapshots, todayIso, liveTotalSen }: NetWorthChartProps) {
  const [range, setRange] = useState<Range>("6M");
  const { fmt } = useMoney();
  const series = chartSeries(snapshots, range, todayIso, liveTotalSen);
  const empty = series.length < 2;
  const dot = empty ? null : lastPoint(series);

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="mb-2 flex items-center gap-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
          Net worth over time
        </h3>
        <div
          className="ml-auto flex overflow-hidden rounded-lg text-xs"
          style={{ border: "1px solid var(--border)" }}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className="px-2.5 py-1"
              style={{
                background: range === r ? "var(--chip)" : "transparent",
                color: range === r ? "var(--ink-1)" : "var(--ink-3)",
                fontWeight: range === r ? 650 : 400,
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <Tip className="-mt-1 mb-3">
        one point per day from the daily snapshot · manual-value changes step the line the day you record them
      </Tip>

      {empty ? (
        <div className="flex flex-col items-center gap-2 py-8">
          <span className="text-2xl font-semibold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
            {fmt(liveTotalSen)}
          </span>
          <Tip>your net worth history starts today — this chart grows a point every day</Tip>
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="block h-[190px] w-full">
            <line x1="0" y1={VIEW_H * 0.25} x2={VIEW_W} y2={VIEW_H * 0.25} stroke="var(--grid)" strokeWidth="1" />
            <line x1="0" y1={VIEW_H * 0.5} x2={VIEW_W} y2={VIEW_H * 0.5} stroke="var(--grid)" strokeWidth="1" />
            <line x1="0" y1={VIEW_H * 0.75} x2={VIEW_W} y2={VIEW_H * 0.75} stroke="var(--grid)" strokeWidth="1" />
            <line x1="0" y1={VIEW_H - 2} x2={VIEW_W} y2={VIEW_H - 2} stroke="var(--baseline)" strokeWidth="1.5" />
            <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={toPoints(series)} />
            {dot ? <circle cx={dot.x} cy={dot.y} r="4" fill="var(--accent)" /> : null}
          </svg>
          <div className="mt-1 flex justify-between text-[11px]" style={{ color: "var(--ink-3)" }}>
            {axisLabels(series).map((label, i) => (
              <span key={`${label}-${i}`}>{label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
