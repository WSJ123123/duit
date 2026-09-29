"use client";

import { Fragment, startTransition, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { plColor, unrealizedPct, formatPct } from "@/lib/pl-display";
import { unitPriceMinor } from "@/lib/portfolio";
import { useMoney } from "@/components/Money";
import {
  createHolding,
  updateHolding,
  archiveHolding,
  unarchiveHolding,
  deleteHolding,
  setHoldingsDisplay,
} from "@/app/(app)/investments/actions";
import { Button } from "@/components/Button";
import {
  inputStyle,
  ActionLink,
  Field,
  DialogShell,
  ErrorLine,
  DialogButtons,
} from "@/components/DialogKit";
import type { InvestmentsData, HoldingRow, ArchivedHoldingRow, HoldingsDisplay } from "@/db/portfolio";

/**
 * Holdings table + holding dialogs for the Investments page (Task 7,
 * mockup v5 §7). Grouped-by-kind table with the Cash·MMF row, row-click
 * edit dialog, and the header/empty-state "Add holding" trigger. Trade UI
 * lives in TradeSheet.tsx — split because holdings and trades are separate
 * write surfaces even though they share this one page.
 */

const KIND_GROUP_LABEL: Record<string, string> = { etf: "ETFs", stock: "Stocks", crypto: "Crypto" };
const KIND_PILL_LABEL: Record<string, string> = { etf: "ETF", stock: "stock", crypto: "crypto" };
const KIND_OPTIONS = [
  { value: "etf", label: "ETF" },
  { value: "stock", label: "Stock" },
  { value: "crypto", label: "Crypto" },
] as const;

/** quantity_e8 -> decimal string, trailing zeros trimmed (contract: Qty column + edit inputs). */
export function formatQty(e8: number): string {
  const s = (e8 / 1e8).toFixed(8);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function pctLabel(tenths: number): string {
  return `${(tenths / 10).toFixed(1)}%`;
}

export function dayMonthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function Pill({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className="ml-1.5 inline-block flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: "var(--chip)", color: muted ? "var(--ink-3)" : "var(--ink-2)" }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add holding
// ---------------------------------------------------------------------------

export function AddHoldingButton({ variant = "secondary" }: { variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        Add holding
      </Button>
      {open ? <CreateHoldingDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CreateHoldingDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KIND_OPTIONS)[number]["value"]>("etf");
  const [currency, setCurrency] = useState("MYR");
  const [priceSource, setPriceSource] = useState<"auto" | "manual">("auto");
  const [manualPrice, setManualPrice] = useState("");
  const [error, setError] = useState<string>();

  function submit() {
    if (!symbol.trim()) return setError("Symbol is required.");
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) return setError("Currency must be a 3-letter code.");
    let manual_price_e8: number | null = null;
    if (priceSource === "manual") {
      const n = Number(manualPrice);
      if (!manualPrice.trim() || !Number.isFinite(n) || n <= 0) return setError("Enter a valid manual price.");
      manual_price_e8 = Math.round(n * 1e8);
    }
    startTransition(async () => {
      const result = await createHolding({
        symbol: symbol.trim().toUpperCase(),
        name: name.trim() || undefined,
        kind,
        currency: currency.trim().toUpperCase(),
        price_source: priceSource,
        manual_price_e8,
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title="Add holding" onClose={onClose}>
      <div className="flex gap-3">
        <Field label="Symbol">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none uppercase"
            style={inputStyle}
          />
        </Field>
        <Field label="Currency">
          <input
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
            className="w-20 rounded-lg px-3 py-2 text-sm outline-none uppercase"
            style={inputStyle}
          />
        </Field>
      </div>
      <Field label="Name — optional">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>
      <Field label="Kind">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Price source">
        <select
          value={priceSource}
          onChange={(e) => setPriceSource(e.target.value as typeof priceSource)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          <option value="auto">Auto (daily fetch)</option>
          <option value="manual">Manual</option>
        </select>
      </Field>
      {priceSource === "manual" ? (
        <Field label={`Manual price (${currency.trim().toUpperCase() || "…"})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      ) : null}
      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} saveLabel="Add holding" />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Edit holding
// ---------------------------------------------------------------------------

function EditHoldingDialog({ holding, onClose }: { holding: HoldingRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(holding.name);
  const [priceSource, setPriceSource] = useState<"auto" | "manual">(
    holding.price_source === "manual" ? "manual" : "auto",
  );
  const [manualPrice, setManualPrice] = useState(
    holding.manual_price_e8 !== null ? formatQty(holding.manual_price_e8) : "",
  );
  const [error, setError] = useState<string>();

  function submit() {
    let manual_price_e8: number | null = null;
    if (priceSource === "manual") {
      const n = Number(manualPrice);
      if (!manualPrice.trim() || !Number.isFinite(n) || n <= 0) return setError("Enter a valid manual price.");
      manual_price_e8 = Math.round(n * 1e8);
    }
    startTransition(async () => {
      const result = await updateHolding(holding.id, {
        name: name.trim(),
        price_source: priceSource,
        manual_price_e8,
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  function archive() {
    startTransition(async () => {
      const result = await archiveHolding(holding.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  /** Ruling 4: archiving is reversible everywhere — this holding's row is
   *  archived-with-position (it's clickable from the group, not the
   *  disclosure), so the flip lives right here in its edit dialog. */
  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveHolding(holding.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title={`Edit holding — ${holding.symbol}`} onClose={onClose}>
      <p className="text-xs" style={{ color: "var(--ink-3)" }}>
        {holding.symbol} · {KIND_PILL_LABEL[holding.kind] ?? holding.kind} · {holding.currency}
        {" — symbol is immutable; recreate the holding to change identity."}
      </p>
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>
      <Field label="Price source">
        <select
          value={priceSource}
          onChange={(e) => setPriceSource(e.target.value as typeof priceSource)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          <option value="auto">Auto (daily fetch)</option>
          <option value="manual">Manual</option>
        </select>
      </Field>
      {priceSource === "manual" ? (
        <Field label={`Manual price (${holding.currency})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      ) : null}
      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} />
      {holding.archived ? (
        <Button type="button" variant="ghost" className="w-full" onClick={unarchive} disabled={pending}>
          Unarchive holding
        </Button>
      ) : (
        <Button type="button" variant="ghost" className="w-full" onClick={archive} disabled={pending}>
          Archive holding
        </Button>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Archived (n) disclosure (ruling 4) — archived + zero-position holdings,
// invisible-forever pre-Task-3. House "Entries (n)" expand-in-place pattern
// (see BusinessDialogs.tsx's BusinessEntriesSection); per-row Unarchive, plus
// two-tap Delete (house pattern from the same file's EntryRow) when the
// holding has zero trades — with trades, archive remains the only path.
// ---------------------------------------------------------------------------

function ArchivedHoldingRowItem({ holding, columns }: { holding: ArchivedHoldingRow; columns: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveHolding(holding.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const result = await deleteHolding(holding.id);
      if (!result.ok) {
        setConfirming(false);
        return setError(result.error);
      }
      router.refresh();
    });
  }

  return (
    <tr style={{ borderTop: "1px solid var(--grid)" }}>
      <td colSpan={columns} className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2.5 text-sm">
          <span className="flex-1 font-semibold" style={{ color: "var(--ink-3)" }}>
            {holding.symbol}
            <Pill muted>{KIND_PILL_LABEL[holding.kind] ?? holding.kind}</Pill>
            <Pill muted>archived</Pill>
          </span>
          <ActionLink onClick={unarchive}>Unarchive</ActionLink>
          {holding.tradeCount === 0 ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="flex-shrink-0 whitespace-nowrap text-xs font-medium"
              style={{ color: confirming || pending ? "var(--critical)" : "var(--accent)" }}
            >
              {pending ? "Deleting…" : confirming ? "Confirm delete" : "Delete"}
            </button>
          ) : null}
          {error ? (
            // Rule 15: a failed write never fails silently — always visible.
            <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
              {error}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ArchivedDisclosure({ holdings, columns }: { holdings: ArchivedHoldingRow[]; columns: number }) {
  const [expanded, setExpanded] = useState(false);
  if (holdings.length === 0) return null;
  return (
    <>
      <tr style={{ borderTop: "1px solid var(--grid)" }}>
        <td colSpan={columns} className="px-2 py-2">
          <ActionLink onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide archived" : `Archived (${holdings.length})`}
          </ActionLink>
        </td>
      </tr>
      {expanded
        ? holdings.map((h) => <ArchivedHoldingRowItem key={h.id} holding={h} columns={columns} />)
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Display-currency seg (Plan 6 ruling 8) — house seg-mini vocabulary,
// CategoryTagControl's optimistic-with-rollback pattern. Persisted via
// setHoldingsDisplay (revalidates /investments, so the table re-renders
// with the new mode); the page renders it only when a non-MYR holding
// exists (nothing to toggle otherwise).
// ---------------------------------------------------------------------------

const DISPLAY_OPTIONS: Array<{ value: HoldingsDisplay; label: string }> = [
  { value: "myr", label: "MYR" },
  { value: "native", label: "native" },
];

export function HoldingsDisplaySeg({ display }: { display: HoldingsDisplay }) {
  const router = useRouter();
  const [current, setCurrent] = useState(display);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function select(next: HoldingsDisplay) {
    if (next === current || pending) return;
    const prev = current;
    setCurrent(next);
    setPending(true);
    setError(undefined);
    startTransition(() => {
      void setHoldingsDisplay(next).then((result) => {
        setPending(false);
        if (!result.ok) {
          setCurrent(prev);
          setError(result.error);
          return;
        }
        router.refresh();
      });
    });
  }

  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-1">
      <div
        className="flex overflow-hidden rounded-lg"
        style={{ border: "1px solid var(--border)", opacity: pending ? 0.6 : 1 }}
      >
        {DISPLAY_OPTIONS.map((opt) => (
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

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

type HoldingsTableProps = Pick<InvestmentsData, "holdings" | "archivedHoldings" | "groups" | "cash"> & {
  display: HoldingsDisplay;
};

export function HoldingsTable({ holdings, archivedHoldings, groups, cash, display }: HoldingsTableProps) {
  const [editing, setEditing] = useState<HoldingRow | null>(null);
  const { fmt, fmtCcy } = useMoney();
  const native = display === "native";
  // Ruling 8: only the PER-HOLDING Value and Unrealized P/L cells switch to
  // the holding's own currency — group subtotals, % and the Cash row are
  // MYR-only figures, so their cells (and the strip above) never change.
  const columns = ["Holding", "Qty", "Avg cost", "Price", native ? "Value" : "Value (MYR)", "%", "Unrealized P/L"];

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((h, i) => (
              <th
                key={h}
                className={`px-2 py-1.5 text-xs font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.kind}>
              <tr>
                <td
                  className="px-2 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)", letterSpacing: "0.03em" }}
                >
                  {KIND_GROUP_LABEL[g.kind] ?? g.kind}
                </td>
                <td colSpan={3} style={{ borderBottom: "1px solid var(--grid)" }} />
                <td
                  className="px-2 pb-1.5 pt-3 text-right text-xs font-semibold normal-case tracking-normal"
                  style={{ color: "var(--ink-1)", borderBottom: "1px solid var(--grid)" }}
                >
                  {fmt(g.value_sen)}
                </td>
                <td
                  className="px-2 pb-1.5 pt-3 text-right text-xs font-semibold normal-case tracking-normal"
                  style={{ color: "var(--ink-1)", borderBottom: "1px solid var(--grid)" }}
                >
                  {pctLabel(g.pct_tenths)}
                </td>
                <td colSpan={1} style={{ borderBottom: "1px solid var(--grid)" }} />
              </tr>
              {holdings
                .filter((h) => g.holding_ids.includes(h.id))
                .map((h) => (
                  <tr
                    key={h.id}
                    onClick={() => setEditing(h)}
                    className="cursor-pointer"
                    style={{ borderBottom: "1px solid var(--grid)" }}
                  >
                    <td className="px-2 py-2 text-left font-semibold" style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
                      {h.symbol}
                      <Pill muted={h.archived}>{KIND_PILL_LABEL[h.kind] ?? h.kind}</Pill>
                      {h.archived ? <Pill muted>archived</Pill> : null}
                      <span className="mt-0.5 block text-[10.5px] font-normal" style={{ color: "var(--ink-3)" }}>
                        {h.currency}
                      </span>
                    </td>
                    {/* A quantity, not money (ruling 3): its decimals stay visible. */}
                    <td
                      data-not-money
                      className="px-2 py-2 text-right tabular-nums"
                      style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-2)" }}
                    >
                      {formatQty(h.position.quantity_e8)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-2)" }}>
                      {fmtCcy(h.currency, unitPriceMinor(h.position.avg_cost_e8))}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-2)" }}>
                      {h.price === null ? (
                        "—"
                      ) : (
                        <>
                          {fmtCcy(h.currency, unitPriceMinor(h.price.price_e8))}
                          <span
                            className="mt-0.5 block text-[10.5px] font-normal"
                            style={{ color: h.price.stale ? "var(--warning)" : "var(--ink-3)", fontWeight: h.price.stale ? 600 : 400 }}
                          >
                            {h.price.manual ? "manual" : `${dayMonthLabel(h.price.as_of)}${h.price.stale ? " · stale" : ""}`}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-2)" }}>
                      {native ? fmtCcy(h.currency, h.value_cent) : fmt(h.value_sen)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" style={{ color: h.archived ? "var(--ink-3)" : "var(--ink-2)" }}>
                      {pctLabel(h.pct_tenths)}
                    </td>
                    <td
                      className="px-2 py-2 text-right tabular-nums font-semibold"
                      style={{ color: h.archived ? "var(--ink-3)" : plColor(native ? h.unrealized_cent : h.unrealized_sen) }}
                    >
                      {native
                        ? fmtCcy(h.currency, h.unrealized_cent, { signed: true })
                        : fmt(h.unrealized_sen, { signed: true })}{" "}
                      ·{" "}
                      {formatPct(unrealizedPct(h.unrealized_cent, h.position.cost_cent))}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
          <tr style={{ borderTop: "1px solid var(--grid)" }}>
            <td className="px-2 py-2 text-left font-semibold" style={{ color: "var(--ink-1)" }}>
              Cash
              <Pill>MMF</Pill>
              <span className="mt-0.5 block text-[10.5px] font-normal" style={{ color: "var(--ink-3)" }}>
                auto-swept ·{" "}
                {cash.accounts
                  .map((a) =>
                    // ruling 7: non-MYR balances stay NAMED natively; the MYR
                    // column above carries the converted value. No rate yet →
                    // say so instead of pretending a converted figure exists.
                    a.currency === "MYR"
                      ? a.name
                      : `${a.name} (${fmtCcy(a.currency, a.balance_sen)}${a.myr_sen === null ? ", no rate yet" : ""})`,
                  )
                  .join(", ") || "no brokerage cash accounts"}
              </span>
            </td>
            <td className="px-2 py-2 text-right" style={{ color: "var(--ink-2)" }}>—</td>
            <td className="px-2 py-2 text-right" style={{ color: "var(--ink-2)" }}>—</td>
            <td className="px-2 py-2 text-right" style={{ color: "var(--ink-2)" }}>—</td>
            <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
              {fmt(cash.value_sen)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
              {pctLabel(cash.pct_tenths)}
            </td>
            <td className="px-2 py-2 text-right" style={{ color: "var(--ink-2)" }}>—</td>
          </tr>
          <ArchivedDisclosure holdings={archivedHoldings} columns={columns.length} />
        </tbody>
      </table>
      {editing ? <EditHoldingDialog holding={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
