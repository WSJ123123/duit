"use client";

import { startTransition, useActionState, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { DIALOG_SHELL_CLASS, senToInputStr } from "@/components/DialogKit";
import { Portal } from "@/components/Portal";
import { Tip } from "@/components/Tip";
import { parseAmountToSen } from "@/lib/money";
import { useMoney } from "@/components/Money";
import { resolveFxRateE8, transferReceivedPrefillSen, type FxRateRow } from "@/lib/fx";
import { fundDrawLine } from "@/lib/funds-display";
import { recordNowNotice } from "@/lib/bills-display";
import type { FundOption } from "@/db/funds";
import type { TxInput, TxType } from "@/lib/transactions";
import { upsertTransaction, updateTransaction, deleteTransaction } from "@/app/(app)/transactions/actions";
import type { OptimisticRowHandlers, RowPatch } from "@/lib/optimistic-entry";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface AccountOption {
  id: string;
  name: string;
  /** Ruling 7: non-MYR accounts take transfers (and reconcile adjustments)
   *  only — the form disables them for income/expense. */
  currency: string;
  archived: boolean;
}

interface CategoryOption {
  id: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
}

export interface ExistingTx {
  id: string;
  type: TxType;
  amount_sen: number;
  account_id: string;
  transfer_account_id: string | null;
  /** Cross-currency transfers: destination amount (its minor units); null =
   *  same-currency (Task 1 storage shape). */
  received_sen: number | null;
  category_id: string | null;
  date: string;
  note: string;
  needs_review: boolean;
  expected_back_sen: number;
  /** Plan 7 ruling 7: the fund this expense is paid from, or null. */
  fund_id: string | null;
  splits: Array<{ category_id: string; amount_sen: number }>;
}

/**
 * Plan 7 ruling 14: `Record now` opens THIS form — the ordinary transaction
 * form, one write path, every existing guard — prefilled from one
 * recurring-rule occurrence. `id` is the materializer's deterministic
 * `uuidv5(`${rule.id}:${date}`)` and `recurring_rule_id` is the link that
 * flips the occurrence to `recorded ✓`; together they mean a later cron fire
 * is the already-handled 23505 no-op. The amount stays editable — a variable
 * bill's real figure is the whole reason this button exists.
 */
export interface TxPrefill {
  id: string;
  recurring_rule_id: string;
  rule_name: string;
  type: TxType;
  amount_sen: number;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  date: string;
}

interface TxFormSheetProps {
  mode: "create" | "edit";
  accounts: AccountOption[];
  categories: CategoryOption[];
  /** fx_rates rows for the cross-currency transfer prefill (ruling 7 via
   *  ruling 6's resolution). Optional: without them the received field still
   *  works, it just never prefills. */
  fxRates?: FxRateRow[];
  /** Plan 7 ruling 7's `Paid from a fund` picker (mockup v6 §10 phone 3).
   *  Omitted ⇒ no picker; an existing tag is still carried back on save, so
   *  no surface can silently clear one. */
  funds?: FundOption[];
  tx?: ExistingTx;
  /** Create mode only — see TxPrefill. */
  prefill?: TxPrefill;
  todayStr: string;
  triggerLabel: string;
  triggerVariant?: "primary" | "secondary" | "ghost";
  triggerClassName?: string;
  /**
   * Replace the default Button trigger with custom content (e.g. a tappable
   * mobile Activity row). Receives the open-the-sheet callback; triggerLabel
   * is ignored when this is provided.
   */
  renderTrigger?: (onClick: () => void) => ReactNode;
  /**
   * Edit-mode only (Task 6). When provided, Save patches `tx.id` into the
   * caller's own `useOptimistic` row list and Delete removes it — both
   * close the sheet immediately, before the server round-trip. Omit (e.g.
   * mode="create") to keep the original await-then-close behavior.
   */
  optimistic?: OptimisticRowHandlers;
}

export function TxFormSheet({
  mode,
  accounts,
  categories,
  fxRates,
  funds,
  tx,
  prefill,
  todayStr,
  triggerLabel,
  triggerVariant = "secondary",
  triggerClassName,
  renderTrigger,
  optimistic,
}: TxFormSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {renderTrigger ? (
        renderTrigger(() => setOpen(true))
      ) : (
        <Button
          type="button"
          variant={triggerVariant}
          className={triggerClassName}
          onClick={() => setOpen(true)}
        >
          {triggerLabel}
        </Button>
      )}
      {open ? (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4"
            style={{ background: "var(--dim)" }}
            onClick={() => setOpen(false)}
          >
            <SheetForm
              mode={mode}
              accounts={accounts}
              categories={categories}
              fxRates={fxRates ?? []}
              funds={funds ?? []}
              tx={tx}
              prefill={prefill}
              todayStr={todayStr}
              onClose={() => setOpen(false)}
              optimistic={optimistic}
            />
          </div>
        </Portal>
      ) : null}
    </>
  );
}

interface SubmitState {
  error?: string;
  /** Q11b: the write was the 23505 no-op on a `Record now` — see recordNowNotice. */
  notice?: { text: string; href: string };
}

interface SheetFormProps {
  mode: "create" | "edit";
  accounts: AccountOption[];
  categories: CategoryOption[];
  fxRates: FxRateRow[];
  funds: FundOption[];
  tx?: ExistingTx;
  prefill?: TxPrefill;
  todayStr: string;
  onClose: () => void;
  optimistic?: OptimisticRowHandlers;
}

/** Exported for the masked-state test only — the sheet itself sits behind
 *  `Portal`, which renders nothing outside the browser. */
export function SheetForm({ mode, accounts, categories, fxRates, funds, tx, prefill, todayStr, onClose, optimistic }: SheetFormProps) {
  const router = useRouter();
  const { fmt, text } = useMoney();
  // Ruling 14: the occurrence's deterministic id, so whichever of `Record
  // now` and the cron writes second is a no-op rather than a duplicate.
  const [clientId] = useState(() => tx?.id ?? prefill?.id ?? crypto.randomUUID());
  const [type, setType] = useState<TxType>(tx?.type ?? prefill?.type ?? "expense");
  const [amount, setAmount] = useState(
    tx ? senToInputStr(tx.amount_sen) : prefill ? senToInputStr(prefill.amount_sen) : "",
  );
  const [accountId, setAccountId] = useState(
    tx?.account_id ?? prefill?.account_id ?? accounts[0]?.id ?? "",
  );
  const [transferAccountId, setTransferAccountId] = useState(
    tx?.transfer_account_id ?? prefill?.transfer_account_id ?? "",
  );
  const [categoryId, setCategoryId] = useState(tx?.category_id ?? prefill?.category_id ?? "");
  const [date, setDate] = useState(tx?.date ?? prefill?.date ?? todayStr);
  const [note, setNote] = useState(tx?.note ?? prefill?.rule_name ?? "");
  const [expectedBack, setExpectedBack] = useState(
    tx && tx.expected_back_sen > 0 ? senToInputStr(tx.expected_back_sen) : "",
  );
  const [splits, setSplits] = useState<Array<{ categoryId: string; amount: string }>>(
    tx?.splits.map((s) => ({ categoryId: s.category_id, amount: senToInputStr(s.amount_sen) })) ?? [],
  );
  // Cross-currency transfer (ruling 7): the destination's own amount. Edit
  // mode starts "dirty" so the prefill effect never overwrites the saved
  // received_sen — the broker's actual figure (same shape as TradeSheet's
  // cashDirty, pinned in src/lib/fx.test.ts).
  const [received, setReceived] = useState(
    tx?.received_sen != null ? senToInputStr(tx.received_sen) : "",
  );
  const [receivedDirty, setReceivedDirty] = useState(mode === "edit");
  // Ruling 7: the existing tag is state from the first render, whether or not
  // the picker is shown — a surface without a fund list still saves it back.
  const [fundId, setFundId] = useState(tx?.fund_id ?? "");

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const fromCurrency = accountById.get(accountId)?.currency ?? "MYR";
  const toCurrency = transferAccountId ? (accountById.get(transferAccountId)?.currency ?? "MYR") : null;
  const crossCurrency = type === "transfer" && toCurrency !== null && toCurrency !== fromCurrency;

  // Ruling 6-style estimate prefill for the destination amount — live until
  // the user types into the field; no resolvable rate → no prefill.
  const receivedFxE8 =
    crossCurrency && toCurrency ? (resolveFxRateE8(fromCurrency, toCurrency, fxRates)?.fx_e8 ?? null) : null;
  useEffect(() => {
    if (!crossCurrency) return;
    const amountSenNow = parseAmountToSen(amount);
    if (amountSenNow === null || amountSenNow <= 0) return;
    const prefill = transferReceivedPrefillSen({
      mode,
      receivedDirty,
      amount_sen: amountSenNow,
      fx_e8: receivedFxE8,
    });
    if (prefill === null) return;
    // Deliberate derived-state sync (TradeSheet's cash prefill shape): fires
    // only while the field is untouched.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReceived(senToInputStr(prefill));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, crossCurrency, receivedFxE8]);

  async function submit(_prev: SubmitState, input: TxInput): Promise<SubmitState> {
    if (mode === "create") {
      const result = await upsertTransaction(input);
      if (!result.ok) return { error: result.error };
      // Q11b: on the `Record now` path a no-op is not a success — the edited
      // amount did not land. The sheet stays open with the notice; the
      // action's revalidation has already re-rendered the page underneath
      // (the row is recorded now), and `RecordNow` keeps this sheet mounted
      // across that flip — see BillsTable.
      const notice = prefill ? recordNowNotice(result, prefill.date) : null;
      if (notice) return { notice };
    } else {
      const result = await updateTransaction(tx!.id, input);
      if (!result.ok) return { error: result.error };
    }
    router.refresh();
    onClose();
    return {};
  }
  const [state, formAction, pending] = useActionState<SubmitState, TxInput>(submit, {});

  const categoryOptions = categories.filter((c) => c.kind === (type === "income" ? "income" : "expense"));
  const selectedCategoryName = categoryOptions.find((c) => c.id === categoryId)?.name;
  const amountSen = parseAmountToSen(amount) ?? 0;
  const expectedBackSen = expectedBack.trim() ? (parseAmountToSen(expectedBack) ?? 0) : 0;
  const shareSen = Math.max(0, amountSen - expectedBackSen);

  // ---- ruling 7's fund picker ------------------------------------------
  const selectedFund = funds.find((f) => f.id === fundId);
  const activeFunds = funds.filter((f) => !f.archived);
  // Active funds for a NEW tag; an existing tag on an archived fund still
  // renders so it can still be cleared (ruling 9a).
  const fundChoices = selectedFund && selectedFund.archived ? [...activeFunds, selectedFund] : activeFunds;
  const showFundPicker = type === "expense" && fromCurrency === "MYR" && fundChoices.length > 0;
  // Retyping a tagged expense is explicit, never silent: the tag is dropped
  // from the payload and the form says what that gives back, before saving.
  // Keyed on the tag itself, not on the resolved option, so a surface without
  // a fund list still discloses it.
  const fundReturned = type !== "expense" && fundId !== "";
  const drawLine = selectedFund
    ? fundDrawLine({
        fund_balance_sen: selectedFund.balance_sen,
        amount_sen: amountSen,
        // The fund's balance already has THIS transaction's old draw out of
        // it, so re-saving the same tag must not subtract it a second time.
        already_drawn_sen: tx && tx.fund_id === selectedFund.id ? tx.amount_sen : 0,
      })
    : null;

  function buildInput(): TxInput {
    const base: TxInput = {
      id: clientId,
      type,
      amount,
      accountId,
      date,
      note,
      // Ruling 14: provenance, carried on every branch below (a recurring
      // rule can be a transfer too). Absent for every other surface, which is
      // what leaves the column alone on an ordinary edit.
      ...(prefill ? { recurringRuleId: prefill.recurring_rule_id } : {}),
    };
    if (type === "transfer") {
      return crossCurrency && received.trim()
        ? { ...base, transferAccountId, received }
        : { ...base, transferAccountId };
    }
    const withCategory: TxInput = categoryId ? { ...base, categoryId } : base;
    if (type !== "expense") return withCategory;
    const withBack: TxInput = expectedBack.trim() ? { ...withCategory, expectedBack } : withCategory;
    const withFund: TxInput = fundId ? { ...withBack, fundId } : withBack;
    const validSplits = splits.filter((s) => s.categoryId && s.amount.trim());
    return validSplits.length > 0
      ? { ...withFund, splits: validSplits.map((s) => ({ categoryId: s.categoryId, amount: s.amount })) }
      : withFund;
  }

  /**
   * Task 6's optimistic edit path: patch the caller's row list and close the
   * sheet immediately (before the network round-trip), then dispatch
   * `updateTransaction` in the background. Success refreshes (replacing the
   * optimistic patch with server-truth); failure reports through
   * `optimistic.settled(false)` — the row-list owner's `useOptimistic`
   * reverts on its own once this transition ends without a baseline change,
   * so no manual rollback code lives here.
   */
  function handleOptimisticSave() {
    if (!tx || !optimistic) return;
    const input = buildInput();
    // `fund_id` is always sent, never conditionally: the overlay row is what a
    // re-edit inside this window reads back, and `buildInput` drops the tag
    // whenever the type is not an expense — so the patch has to say so too.
    const patch: RowPatch = {
      id: tx.id,
      amount_sen: amountSen,
      note,
      category_id: categoryId || null,
      date,
      fund_id: type === "expense" && fundId ? fundId : null,
    };
    optimistic.patch(patch);
    onClose();
    startTransition(async () => {
      const result = await updateTransaction(tx.id, input);
      optimistic.settled(result.ok);
      if (result.ok) router.refresh();
    });
  }

  /** Same immediate-close, dispatch-in-background shape as handleOptimisticSave, but removing rather than patching. */
  function handleDelete() {
    if (!tx) return;
    onClose();
    startTransition(async () => {
      optimistic?.remove(tx.id);
      const result = await deleteTransaction(tx.id);
      optimistic?.settled(result.ok);
      if (result.ok) router.refresh();
    });
  }

  function addSplit() {
    setSplits((prev) => [...prev, { categoryId: categoryOptions[0]?.id ?? "", amount: "" }]);
  }
  function removeSplit(index: number) {
    setSplits((prev) => prev.filter((_, i) => i !== index));
  }
  function updateSplit(index: number, field: "categoryId" | "amount", value: string) {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }

  // Q13: a scheduled transfer records through this same sheet; the copy says
  // which kind of occurrence is being fixed.
  const occurrenceWord = prefill?.type === "transfer" ? "transfer" : "bill";

  function handleTypeChange(next: TxType) {
    setType(next);
    if (next === "transfer") {
      setCategoryId("");
      setExpectedBack("");
      setSplits([]);
    } else if (next === "income") {
      setTransferAccountId("");
      setExpectedBack("");
      setSplits([]);
    } else {
      setTransferAccountId("");
    }
    if (next !== "transfer") {
      setReceived("");
      setReceivedDirty(mode === "edit");
    }
  }

  return (
    <div
      className={`${DIALOG_SHELL_CLASS} md:max-w-lg`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-auto -mt-1 h-1 w-10 flex-shrink-0 rounded-full md:hidden" style={{ background: "var(--baseline)" }} />
      <h3 className="text-base font-semibold" style={{ color: "var(--ink-1)" }}>
        {mode === "create" ? (prefill ? `Record ${occurrenceWord}` : "Add entry") : "Edit entry"}
      </h3>
      {prefill ? (
        <>
          <p className="-mt-2 text-xs" style={{ color: "var(--ink-2)" }}>
            {prefill.rule_name} · {prefill.date}
          </p>
          <Tip className="-mt-1">
            saving marks this occurrence recorded — correct the amount first if the real figure differs
          </Tip>
        </>
      ) : null}

      {mode === "edit" && tx?.needs_review ? (
        <label className="flex items-center gap-2 text-xs" style={{ color: "var(--ink-2)" }}>
          <input type="checkbox" checked readOnly disabled />
          Needs review — saving will clear this
        </label>
      ) : null}

      <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
        {(["expense", "income", "transfer"] as const).map((t) => {
          // Ruling 7: a non-MYR account carries transfers (and reconcile
          // adjustments) only — its sen are not MYR sen.
          const blocked = t !== "transfer" && fromCurrency !== "MYR";
          return (
            <button
              key={t}
              type="button"
              disabled={blocked}
              onClick={() => handleTypeChange(t)}
              className="flex-1 py-2 text-sm capitalize"
              style={{
                background: type === t ? "var(--chip)" : "transparent",
                color: blocked ? "var(--ink-3)" : type === t ? "var(--ink-1)" : "var(--ink-3)",
                fontWeight: type === t ? 650 : 400,
                opacity: blocked ? 0.45 : 1,
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
      {fromCurrency !== "MYR" ? (
        <p className="-mt-1 text-xs" style={{ color: "var(--ink-3)" }}>
          {accountById.get(accountId)?.name} is a {fromCurrency} account — only transfers (and
          reconcile) can touch it here.
        </p>
      ) : null}

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Amount ({fromCurrency === "MYR" ? "RM" : fromCurrency})
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Date{prefill ? ` · fixed to this ${occurrenceWord}` : ""}
          </span>
          {prefill ? (
            /* Ruling 14, F1: on the prefilled `Record now` path the date is
               READ-ONLY. The row's id is uuidv5(`${rule.id}:${date}`) and the
               recorded-match is the exact pair (recurring_rule_id, date), so a
               corrected date would produce a transaction matching NO
               occurrence: the bill would stay listed as due, re-enter the
               projection, and never flip to `recorded` — while the cron's
               later insert of the same uuid still hits 23505 and advances
               next_run, so nothing self-heals. Ruling 14 names the AMOUNT as
               the editable field (a variable bill's real figure), not the
               date. The ordinary form keeps its editable date input below. */
            <output
              className="rounded-lg px-3 py-2 text-sm tabular-nums"
              style={{ ...inputStyle, background: "var(--chip)", color: "var(--ink-2)" }}
            >
              {prefill.date}
            </output>
          ) : (
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          )}
        </label>
      </div>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Account
          </span>
          <select
            required
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={type !== "transfer" && a.currency !== "MYR"}>
                {a.name}
                {a.currency !== "MYR" ? ` (${a.currency})` : ""}
                {a.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
        {type === "transfer" ? (
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              To account
            </span>
            <select
              required
              value={transferAccountId}
              onChange={(e) => setTransferAccountId(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              <option value="">Choose…</option>
              {accounts
                .filter((a) => a.id !== accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.currency !== "MYR" ? ` (${a.currency})` : ""}
                    {a.archived ? " (archived)" : ""}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

      {crossCurrency && toCurrency ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Received ({toCurrency}) — what actually arrived
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            required
            value={received}
            onChange={(e) => {
              setReceived(e.target.value);
              setReceivedDirty(true);
            }}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
          {receivedFxE8 === null ? (
            <span className="text-xs" style={{ color: "var(--warning)" }}>
              No {fromCurrency}→{toCurrency} rate yet — enter the amount your broker credited.
            </span>
          ) : (
            <span className="text-xs" style={{ color: "var(--ink-3)" }}>
              Estimated from the latest rate — edit to the exact amount received.
            </span>
          )}
        </label>
      ) : null}

      {type !== "transfer" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Category
          </span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="">— none / use splits below —</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Note
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>

      {type === "expense" ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              Expected back (RM) — for split bills / reimbursements
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={expectedBack}
              onChange={(e) => setExpectedBack(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </label>
          <p className="text-xs font-medium" style={{ color: "var(--good-text)" }}>
            Your share: {fmt(shareSen)}
          </p>

          <div className="flex flex-col gap-2">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              Split across categories (optional)
            </span>
            {splits.map((s, i) => (
              <div key={i} className="flex gap-2">
                <select
                  value={s.categoryId}
                  onChange={(e) => updateSplit(i, "categoryId", e.target.value)}
                  className="flex-1 rounded-lg px-2 py-1.5 text-sm outline-none"
                  style={inputStyle}
                >
                  <option value="">Choose category…</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={s.amount}
                  onChange={(e) => updateSplit(i, "amount", e.target.value)}
                  className="w-24 rounded-lg px-2 py-1.5 text-sm outline-none"
                  style={inputStyle}
                />
                <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={() => removeSplit(i)}>
                  Remove
                </Button>
              </div>
            ))}
            <Button type="button" variant="secondary" className="self-start px-2 py-1 text-xs" onClick={addSplit}>
              + Add split
            </Button>
          </div>
        </>
      ) : null}

      {/* Ruling 7's `Paid from a fund` (mockup v6 §10 phone 3): expense-only,
          MYR-only (ruling 8), and only once a fund exists. The balance line is
          data and stays with tips off; the teaching line is a Tip. */}
      {showFundPicker ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Paid from a fund
          </span>
          <select
            value={fundId}
            onChange={(e) => setFundId(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="">— none —</option>
            {fundChoices.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
          {drawLine ? (
            <>
              <span
                className="text-xs"
                style={{ color: drawLine.over_drawn ? "var(--critical)" : "var(--ink-3)" }}
              >
                {text(drawLine.text)}
              </span>
              <Tip as="span">
                Money you already set aside — this will not count against{" "}
                {selectedCategoryName ? `your ${selectedCategoryName} limit` : "any category limit"} this
                month.
              </Tip>
            </>
          ) : null}
        </label>
      ) : null}

      {fundReturned ? (
        <p className="text-xs" style={{ color: "var(--warning)" }}>
          Saving as {type} clears the fund: this will return{" "}
          {fmt(tx?.amount_sen ?? amountSen)} to {selectedFund?.name ?? "its fund"}.
        </p>
      ) : null}

      {state.error ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {state.notice.text}{" "}
          <Link href={state.notice.href} style={{ color: "var(--accent)" }}>
            View entry →
          </Link>
        </p>
      ) : null}

      <div className="mt-2 flex gap-3">
        {mode === "edit" && tx ? (
          <Button type="button" variant="ghost" className="px-4" onClick={handleDelete}>
            Delete
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          onClick={() => {
            if (mode === "edit" && tx && optimistic) {
              handleOptimisticSave();
            } else {
              startTransition(() => formAction(buildInput()));
            }
          }}
          disabled={pending}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
