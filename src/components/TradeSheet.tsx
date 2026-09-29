"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { holdingValueSen, priceIsStale, unitPriceMinor } from "@/lib/portfolio";
import { parseAmountToSen, parseAmountToE8 } from "@/lib/money";
import {
  FX_IDENTITY_E8,
  resolveFxRateE8,
  tradeCashPrefillSen,
  type FxRateRow,
} from "@/lib/fx";
import { saveTrade, deleteTrade } from "@/app/(app)/investments/actions";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { inputStyle, senToInputStr, Field, DialogShell, ErrorLine, DialogButtons } from "@/components/DialogKit";
import { formatQty, dayMonthLabel } from "@/components/HoldingsTable";
import { Money, useMoney } from "@/components/Money";
import type { HoldingRow, TradeRow, InvestmentsData } from "@/db/portfolio";

/**
 * Trade UI for the Investments page (Task 7, mockup v5 §7): the add/edit
 * trade sheet (`TradeDialog`, shared by the header "Add trade" button and
 * the recent-trades list's row click) and the "Recent trades" card itself.
 * Holdings display lives in HoldingsTable.tsx; both files share its qty/date
 * formatters (money prints through `useMoney()`, Plan 9).
 */

type AccountOption = InvestmentsData["accounts"][number];

// Ruling 13: both form parsers share parseAmountToSen's strictness — digits
// with optional thousands commas and bounded decimals; no signs, exponents
// or bare dots; null instead of an unsafe integer.
const toE8 = parseAmountToE8; // quantity / unit price → e8 fixed point
const toCents = parseAmountToSen; // fees / cash → minor units

// ---------------------------------------------------------------------------
// Add trade trigger
// ---------------------------------------------------------------------------

export function AddTradeButton({
  holdings,
  accounts,
  fxRates,
  todayStr,
  variant = "primary",
}: {
  holdings: HoldingRow[];
  accounts: AccountOption[];
  fxRates: FxRateRow[];
  todayStr: string;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const disabled = holdings.length === 0 || accounts.length === 0;
  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)} disabled={disabled}>
        Add trade
      </Button>
      {open ? (
        <TradeDialog mode="create" holdings={holdings} accounts={accounts} fxRates={fxRates} todayStr={todayStr} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add/edit trade dialog
// ---------------------------------------------------------------------------

function TradeDialog({
  mode,
  trade,
  holdings,
  accounts,
  fxRates,
  todayStr,
  onClose,
}: {
  mode: "create" | "edit";
  trade?: TradeRow;
  holdings: HoldingRow[];
  accounts: AccountOption[];
  fxRates: FxRateRow[];
  todayStr: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [clientId] = useState(() => trade?.id ?? crypto.randomUUID());
  const [side, setSide] = useState<"buy" | "sell">((trade?.side as "buy" | "sell") ?? "buy");
  const [holdingId, setHoldingId] = useState(trade?.holding_id ?? holdings[0]?.id ?? "");
  const [date, setDate] = useState(trade?.date ?? todayStr);
  const [qty, setQty] = useState(trade ? formatQty(trade.quantity_e8) : "");
  const [price, setPrice] = useState(trade ? formatQty(trade.price_e8) : "");
  const [fees, setFees] = useState(trade ? senToInputStr(trade.fees_cent) : "");
  const [accountId, setAccountId] = useState(trade?.account_id ?? accounts[0]?.id ?? "");
  const [cash, setCash] = useState(trade ? senToInputStr(trade.cash_delta_sen) : "");
  // Edit mode starts "dirty" so the live prefill effect below never overwrites
  // the trade's saved cash_delta_sen (which may be a divergent broker-reported
  // figure) — the field is still fully editable, it just isn't auto-derived.
  const [cashDirty, setCashDirty] = useState(mode === "edit");
  const [error, setError] = useState<string>();

  const selectedHolding = holdings.find((h) => h.id === holdingId);
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const currenciesMatch = !!selectedHolding && !!selectedAccount && selectedHolding.currency === selectedAccount.currency;
  const holdingCurrency = selectedHolding?.currency ?? "";
  const accountCurrency = selectedAccount?.currency ?? "";

  // Ruling 6: cross-currency rate resolution (identity / direct pair /
  // via-MYR cross) from the fx_rates rows the page already loads. null →
  // no prefill + the "no rate yet" helper line below — never a guess.
  const fxResolved =
    !currenciesMatch && selectedHolding && selectedAccount
      ? resolveFxRateE8(holdingCurrency, accountCurrency, fxRates)
      : null;
  const prefillFxE8 = currenciesMatch ? FX_IDENTITY_E8 : (fxResolved?.fx_e8 ?? null);
  const fxStale = fxResolved?.as_of ? priceIsStale(fxResolved.as_of, todayStr) : false;

  // Ruling 3 (same currency) + ruling 6 (cross-currency estimate): prefill
  // the cash amount from qty x price +/- fees at the resolved rate —
  // recomputed live until the user types into the field themselves
  // (cashDirty), after which it's theirs. tradeCashPrefillSen is the single
  // gate: edit mode never re-prefills over a saved cash_delta_sen
  // (Session-9 T7 lesson, pinned in src/lib/fx.test.ts), and an
  // unresolvable rate never prefills.
  useEffect(() => {
    const qtyE8 = toE8(qty);
    const priceE8 = toE8(price);
    if (qtyE8 === null || qtyE8 <= 0 || priceE8 === null || priceE8 < 0) return;
    const prefill = tradeCashPrefillSen({
      mode,
      cashDirty,
      side,
      gross_cent: holdingValueSen(qtyE8, priceE8, FX_IDENTITY_E8),
      fees_cent: toCents(fees) ?? 0,
      fx_e8: prefillFxE8,
    });
    if (prefill === null) return;
    // Deliberate derived-state sync (ruling 3's live prefill), not a render
    // cascade: it only fires while the user hasn't touched the field
    // (cashDirty stays false), same one-shot-until-overridden shape as
    // Sidebar's collapsed-state read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCash(senToInputStr(prefill));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty, price, fees, side, currenciesMatch, prefillFxE8]);

  function buildInput() {
    return {
      id: clientId,
      holding_id: holdingId,
      account_id: accountId,
      side,
      date,
      quantity_e8: toE8(qty) ?? 0,
      price_e8: toE8(price) ?? 0,
      fees_cent: toCents(fees) ?? 0,
      cash_delta_sen: toCents(cash) ?? 0,
      note: "",
    };
  }

  function submit() {
    if (!holdingId) return setError("Choose a holding.");
    if (!accountId) return setError("Choose an account.");
    const qtyE8 = toE8(qty);
    if (qtyE8 === null || qtyE8 <= 0) return setError("Enter a valid quantity.");
    const priceE8 = toE8(price);
    if (priceE8 === null || priceE8 < 0) return setError("Enter a valid price.");
    // Empty fees still means 0 (buildInput's ?? 0); a non-empty entry the
    // tightened parser rejects must error visibly, never record as 0 —
    // fees feed cost basis (buy) and realized P/L (sell).
    if (fees.trim() !== "" && toCents(fees) === null) return setError("Enter a valid fees amount.");
    const cashCent = toCents(cash);
    if (cashCent === null || cashCent < 0) return setError("Enter a valid cash amount.");
    startTransition(async () => {
      const result = await saveTrade(buildInput());
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  function handleDelete() {
    if (!trade) return;
    startTransition(async () => {
      const result = await deleteTrade(trade.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title={mode === "create" ? "Add trade" : "Edit trade"} onClose={onClose}>
      <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className="flex-1 py-2 text-sm capitalize"
            style={{
              background: side === s ? "var(--chip)" : "transparent",
              color: side === s ? "var(--ink-1)" : "var(--ink-3)",
              fontWeight: side === s ? 650 : 400,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <Field label="Holding">
        <select
          value={holdingId}
          onChange={(e) => setHoldingId(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {holdings.map((h) => (
            <option key={h.id} value={h.id}>
              {h.symbol} · {h.currency}
              {h.archived ? " (archived)" : ""}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex gap-3">
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
        <Field label="Quantity">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>

      <div className="flex gap-3">
        <Field label={`Price (${holdingCurrency || "…"})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
        <Field label={`Fees (${holdingCurrency || "…"})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>

      <Field label="Account">
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.currency}
            </option>
          ))}
        </select>
      </Field>

      <Field label={`Cash amount (${accountCurrency || "…"})`}>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={cash}
          onChange={(e) => {
            setCashDirty(true);
            setCash(e.target.value);
          }}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>
      {!currenciesMatch && selectedHolding && selectedAccount ? (
        fxResolved ? (
          // Ruling 6 helper: in ADD mode the prefill is an ESTIMATE at the
          // latest known rate — warn-colored when stale (ruling 10's test).
          // In EDIT mode the field already holds the broker's actual saved
          // figure (never re-prefilled), so the line only reports the rate:
          // it must not read as calling that saved figure an estimate.
          <p className="text-xs" style={{ color: fxStale ? "var(--warning)" : "var(--ink-3)" }}>
            {mode === "edit" ? "latest rate " : "≈ estimate at "}
            {/* A rate, not money (ruling 3). */}
            <span data-not-money>{formatQty(fxResolved.fx_e8)}</span>
            {fxResolved.as_of ? ` (${dayMonthLabel(fxResolved.as_of)})` : ""}
          </p>
        ) : (
          <p className="text-xs" style={{ color: "var(--ink-3)" }}>
            no {holdingCurrency}→{accountCurrency} rate yet — enter the actual amount
          </p>
        )
      ) : null}

      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} />
      {mode === "edit" && trade ? (
        <Button type="button" variant="ghost" className="w-full" onClick={handleDelete} disabled={pending}>
          Delete trade
        </Button>
      ) : null}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Recent trades card
// ---------------------------------------------------------------------------

function TradeListRow({
  trade,
  accountCurrency,
  onClick,
}: {
  trade: TradeRow;
  accountCurrency: string;
  onClick: () => void;
}) {
  const { fmtCcy } = useMoney();
  const grossCent = holdingValueSen(trade.quantity_e8, trade.price_e8, FX_IDENTITY_E8);
  const feeSign = trade.side === "buy" ? "+" : "−";
  const cashSign = trade.side === "buy" ? "−" : "+";
  const isBuy = trade.side === "buy";
  return (
    <div
      onClick={onClick}
      className="grid cursor-pointer items-center gap-3 py-2 text-[12.5px]"
      style={{ gridTemplateColumns: "86px 1fr auto auto", borderBottom: "1px solid var(--grid)" }}
    >
      <span className="tabular-nums" style={{ color: "var(--ink-3)" }}>
        {dayMonthLabel(trade.date)}
      </span>
      <span className="font-medium" style={{ color: "var(--ink-1)" }}>
        <span
          className="mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[10.5px] font-bold"
          style={{
            color: isBuy ? "var(--good-text)" : "var(--critical)",
            background: isBuy ? "color-mix(in srgb, var(--good) 12%, transparent)" : "color-mix(in srgb, var(--critical) 12%, transparent)",
          }}
        >
          {trade.side.toUpperCase()}
        </span>
        {trade.symbol} · <span data-not-money>{formatQty(trade.quantity_e8)}</span> @{" "}
        {fmtCcy(trade.holding_currency, unitPriceMinor(trade.price_e8))}
      </span>
      <span className="text-right font-semibold tabular-nums" style={{ color: "var(--ink-1)" }}>
        {/* The fee's bare figure: its currency is implied by the gross beside it. */}
        {fmtCcy(trade.holding_currency, grossCent)} {feeSign} <Money sen={trade.fees_cent} bare /> fee
      </span>
      <span className="text-right text-[11.5px] tabular-nums" style={{ color: "var(--ink-3)" }}>
        {cashSign} {fmtCcy(accountCurrency, trade.cash_delta_sen)} {trade.account_name}
      </span>
    </div>
  );
}

export function RecentTradesCard({
  trades,
  holdings,
  accounts,
  fxRates,
  todayStr,
}: {
  trades: TradeRow[];
  holdings: HoldingRow[];
  accounts: AccountOption[];
  fxRates: FxRateRow[];
  todayStr: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null);
  const accountCurrency = new Map(accounts.map((a) => [a.id, a.currency]));
  const shown = expanded ? trades : trades.slice(0, 10);

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Recent trades
      </h3>
      <Tip className="mb-2">
        a buy is an asset exchange, never an expense — it debits cash and grows the holding · budgets never see it
      </Tip>
      {trades.length === 0 ? (
        <p className="py-4 text-sm" style={{ color: "var(--ink-3)" }}>
          No trades yet.
        </p>
      ) : (
        <>
          {shown.map((t) => (
            <TradeListRow
              key={t.id}
              trade={t}
              accountCurrency={accountCurrency.get(t.account_id) ?? "MYR"}
              onClick={() => setEditingTrade(t)}
            />
          ))}
          <div
            className="mt-2 flex items-center justify-between pt-2 text-xs"
            style={{ borderTop: "1px solid var(--grid)", color: "var(--ink-3)" }}
          >
            <span>
              {trades.length} trade{trades.length === 1 ? "" : "s"}
            </span>
            {trades.length > 10 ? (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="text-xs font-medium"
                style={{ color: "var(--accent)" }}
              >
                {expanded ? "Show less" : "View all"}
              </button>
            ) : null}
          </div>
        </>
      )}
      {editingTrade ? (
        <TradeDialog
          mode="edit"
          trade={editingTrade}
          holdings={holdings}
          accounts={accounts}
          fxRates={fxRates}
          todayStr={todayStr}
          onClose={() => setEditingTrade(null)}
        />
      ) : null}
    </div>
  );
}
