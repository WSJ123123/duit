"use client";

import { useCallback, useEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { senToInputStr } from "@/components/DialogKit";
import { Tip } from "@/components/Tip";
import { TxFormSheet } from "@/components/TxFormSheet";
import type { FundOption } from "@/db/funds";
import {
  dateLabel,
  categoryLabelFor,
  accountLabelFor,
  existingTxFrom,
  type EnrichedTxRow,
} from "@/lib/tx-display";
import { parseAmountToSen } from "@/lib/money";
import { Money, useMoney } from "@/components/Money";
import { parseEntry, type ParserContext } from "@/lib/parser/parse";
import { enqueue, flushQueue, peekAll } from "@/lib/offline-queue";
import { previewLine, sortCategoriesByUsage, teachWord } from "@/lib/quick-add-state";
import { withOptimistic, bumpTodayTotal, type OptimisticEntry } from "@/lib/optimistic-entry";
import { heroStats, meterState, type MeterState } from "@/lib/budget";
import type { TxInput, TxType } from "@/lib/transactions";
import { upsertTransaction } from "@/app/(app)/transactions/actions";
import { saveAlias } from "@/app/(app)/settings/aliases/actions";

interface AccountOption {
  id: string;
  name: string;
  /** Ruling 7: quick entries are income/expense — non-MYR accounts are not
   *  offered here (transfers + reconcile only, via the full form). */
  currency: string;
  archived: boolean;
}

interface CategoryOption {
  id: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
}

interface BudgetGlance {
  allocated_total_sen: number;
  spent_total_sen: number;
}

interface QuickAddProps {
  ctx: ParserContext;
  initialText: string;
  todayStr: string;
  yesterdayStr: string;
  todaySpendSen: number;
  monthSpendSen: number;
  /** Month-vs-budget glance (Task 7); null when the month isn't planned —
   *  the line is hidden entirely, not just tips-gated. */
  budgetGlance: BudgetGlance | null;
  usageTx: Array<{ category_id: string | null }>;
  recentRows: EnrichedTxRow[];
  accounts: AccountOption[];
  categories: CategoryOption[];
  /** fx_rates rows for the recent-row edit sheet's transfer prefill. */
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  /** Ruling 7's fund picker on the recent-row edit sheet. */
  funds?: FundOption[];
}

interface TeachPrompt {
  word: string;
  categoryId: string;
  categoryName: string;
}

function monthLabel(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

/** Full month name for the budget glance line, e.g. "August". */
function monthName(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

/** Same meter-state → color mapping as BudgetTable / BudgetMobile / Dashboard. */
function meterColor(state: MeterState): string {
  if (state === "over") return "var(--critical)";
  if (state === "warn") return "var(--warning)";
  return "var(--accent)";
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5.2" stroke="var(--ink-3)" strokeWidth="1.6" />
      <path d="M11 11l3 3" stroke="var(--ink-3)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function QuickAdd({
  ctx,
  initialText,
  todayStr,
  yesterdayStr,
  todaySpendSen,
  monthSpendSen,
  budgetGlance,
  usageTx,
  recentRows,
  accounts,
  categories,
  fxRates,
  funds,
}: QuickAddProps) {
  const router = useRouter();
  const { fmt, text } = useMoney();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState(() => crypto.randomUUID());

  const [nlText, setNlText] = useState(initialText);
  const [keypadAmount, setKeypadAmount] = useState("");
  const [keypadType, setKeypadType] = useState<TxType>("expense");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [accountOverride, setAccountOverride] = useState<string | null>(null);
  const [teach, setTeach] = useState<TeachPrompt | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  // Optimistic overlay for Save: prepends a pending row to Recent and bumps
  // the today-total, both via the pure src/lib/optimistic-entry.ts reducers.
  // React reconciles automatically when the transition settles — on success
  // router.refresh() has already replaced these baselines with the server's
  // real row (deduped by clientId); on failure the baselines are untouched,
  // so both snap back to their pre-save values with no manual revert code.
  const [optimisticRecents, addOptimisticRecent] = useOptimistic<
    Array<EnrichedTxRow | OptimisticEntry>,
    OptimisticEntry
  >(recentRows, (state, entry) => withOptimistic(state, entry));
  const [optimisticTodaySpendSen, addOptimisticSpend] = useOptimistic<number, OptimisticEntry>(
    todaySpendSen,
    (state, entry) => bumpTodayTotal(state, entry),
  );

  const refreshQueueCount = useCallback(async () => {
    try {
      setQueuedCount((await peekAll()).length);
    } catch {
      // IndexedDB unavailable — badge simply stays hidden.
    }
  }, []);

  const flushQueued = useCallback(async () => {
    try {
      const { sent } = await flushQueue(upsertTransaction);
      if (sent > 0) router.refresh();
    } catch {
      // flushQueue only throws if IndexedDB itself is unavailable.
    }
    await refreshQueueCount();
  }, [router, refreshQueueCount]);

  // Flush queued offline entries on load and whenever connectivity returns.
  useEffect(() => {
    // Sync-with-external-system: any setState happens after async IndexedDB
    // reads settle, never synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void flushQueued();
    const onOnline = () => void flushQueued();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushQueued]);

  const nlActive = nlText.trim().length > 0;
  const parsed = useMemo(() => parseEntry(nlText, ctx), [nlText, ctx]);

  const effectiveType: TxType = nlActive ? parsed.type : keypadType;
  const effectiveAmountSen = nlActive ? parsed.amount_sen : parseAmountToSen(keypadAmount);
  // Quick entries are income/expense: only MYR accounts qualify (ruling 7).
  const effectiveAccountId =
    accountOverride ??
    parsed.account_id ??
    accounts.find((a) => !a.archived && a.currency === "MYR")?.id ??
    null;
  const effectiveCategoryId = selectedCategoryId ?? (nlActive ? parsed.category_id : null);

  const activeAccounts = accounts.filter((a) => !a.archived && a.currency === "MYR");
  const categoryOptions = categories.filter((c) => !c.archived && c.kind === (effectiveType === "income" ? "income" : "expense"));
  const chipOrder = useMemo(() => sortCategoriesByUsage(categoryOptions, usageTx), [categoryOptions, usageTx]);
  const orderedCategories = chipOrder
    .map((id) => categoryOptions.find((c) => c.id === id))
    .filter((c): c is CategoryOption => c !== undefined);

  const preview = previewLine(parsed, ctx);
  const canSave = effectiveAmountSen !== null && effectiveAmountSen > 0 && effectiveAccountId !== null && !pending;

  function resetForm() {
    setNlText("");
    setKeypadAmount("");
    setKeypadType("expense");
    setSelectedCategoryId(null);
    setAccountOverride(null);
    setClientId(crypto.randomUUID());
  }

  function handleTypeToggle(next: TxType) {
    if (nlActive) return; // NL text decides type via a leading "+"
    setKeypadType(next);
  }

  function pressDigit(d: string) {
    setKeypadAmount((prev) => (prev.length >= 9 ? prev : prev + d));
  }
  function pressDot() {
    setKeypadAmount((prev) => (prev.includes(".") ? prev : prev + "."));
  }
  function pressBackspace() {
    setKeypadAmount((prev) => prev.slice(0, -1));
  }

  function buildInput(): TxInput | null {
    if (effectiveAmountSen === null || effectiveAmountSen <= 0 || effectiveAccountId === null) return null;
    return {
      id: clientId,
      type: effectiveType,
      amount: senToInputStr(effectiveAmountSen),
      accountId: effectiveAccountId,
      ...(effectiveCategoryId ? { categoryId: effectiveCategoryId } : {}),
      date: todayStr,
      note: nlActive ? nlText.trim() : "",
      source: nlActive ? "nl" : "manual",
      needsReview: nlActive ? !parsed.confident : effectiveCategoryId === null,
    };
  }

  function handleSave() {
    const input = buildInput();
    if (!input) return;

    // Snapshot the state that decides the teach affordance before resetForm() clears it.
    const wasNlActive = nlActive;
    const parsedCategoryId = parsed.category_id;
    const chosenCategoryId = selectedCategoryId;
    const finalCategoryId = effectiveCategoryId;
    const word = wasNlActive ? teachWord(nlText) : null;
    const categoryName = finalCategoryId ? categories.find((c) => c.id === finalCategoryId)?.name ?? "" : "";

    const optimisticEntry: OptimisticEntry = {
      clientId,
      label: wasNlActive ? nlText.trim() : categoryName || (input.type === "income" ? "Income" : "Expense"),
      amount_sen: parseAmountToSen(input.amount) ?? 0,
      isExpense: input.type === "expense",
      pending: true,
    };

    startTransition(async () => {
      // Optimistic overlay first — pure reducers from src/lib/optimistic-entry.ts.
      // React discards both the moment this transition settles unless the
      // baselines (recentRows / todaySpendSen props) have themselves moved on
      // (via router.refresh() below), so a failure rolls back automatically.
      addOptimisticRecent(optimisticEntry);
      addOptimisticSpend(optimisticEntry);

      // Offline (or a dispatch that dies mid-flight) queues instead of failing.
      // The client UUID is already fixed, so flushing after a half-sent save
      // cannot duplicate — the server dedups on the id.
      const queueEntry = async () => {
        try {
          await enqueue({ id: clientId, input, queuedAt: new Date().toISOString() });
          return true;
        } catch {
          return false; // IndexedDB unavailable — surface an error instead of dropping the entry
        }
      };

      let queued = false;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        queued = await queueEntry();
        if (!queued) {
          setError("Offline and couldn't queue the entry — please retry.");
          return;
        }
      } else {
        try {
          const result = await upsertTransaction(input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
        } catch {
          queued = await queueEntry();
          if (!queued) {
            setError("Network failed and couldn't queue the entry — please retry.");
            return;
          }
        }
      }

      setError(null);
      // Teach needs a network round-trip of its own — only offer it on a live save.
      if (!queued && wasNlActive && word && finalCategoryId) {
        const guessedNothing = parsedCategoryId === null;
        const userChanged = chosenCategoryId !== null && chosenCategoryId !== parsedCategoryId;
        if (guessedNothing || userChanged) {
          setTeach({ word, categoryId: finalCategoryId, categoryName });
        }
      }
      resetForm();
      if (queued) {
        await refreshQueueCount();
      } else {
        router.refresh();
      }
    });
  }

  async function acceptTeach() {
    if (!teach) return;
    const fd = new FormData();
    fd.set("phrase", teach.word);
    fd.set("target", `category:${teach.categoryId}`);
    await saveAlias({}, fd);
    setTeach(null);
  }

  // Month-vs-budget glance (data, not education — hidden entirely when
  // unplanned, but never gated by the tips toggle when it is present).
  // Settles on router.refresh() only; never threaded into the optimistic
  // today-total above.
  const glance = budgetGlance
    ? (() => {
        const { left_sen, over_sen } = heroStats(budgetGlance.allocated_total_sen, budgetGlance.spent_total_sen, todayStr);
        const over = over_sen > 0;
        const fraction =
          budgetGlance.allocated_total_sen > 0
            ? budgetGlance.spent_total_sen / budgetGlance.allocated_total_sen
            : budgetGlance.spent_total_sen > 0
              ? 1
              : 0;
        const color = meterColor(meterState(budgetGlance.spent_total_sen, budgetGlance.allocated_total_sen));
        return { amountSen: over ? over_sen : left_sen, over, fraction, color };
      })()
    : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 pb-6">
      <div
        className="flex items-center justify-between rounded-2xl px-4 py-3 text-sm"
        style={{ border: "1px solid var(--border)", color: "var(--ink-2)" }}
      >
        <span>
          Today <b style={{ color: "var(--ink-1)" }}>{fmt(optimisticTodaySpendSen)}</b>
        </span>
        {queuedCount > 0 ? (
          // Queue state, not education — always visible, never wrapped in Tip.
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
            style={{ background: "var(--chip)", color: "var(--ink-1)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} />
            {queuedCount} queued
          </span>
        ) : null}
        <span>
          {monthLabel(todayStr)} spent <b style={{ color: "var(--ink-1)" }}>{fmt(monthSpendSen)}</b>
        </span>
      </div>

      {glance ? (
        <div
          className="flex items-center gap-3 rounded-2xl px-4 py-2.5 text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--ink-2)" }}
        >
          <span className="flex-shrink-0">
            {monthName(todayStr)} ·{" "}
            <b style={{ color: glance.over ? "var(--critical)" : "var(--ink-1)" }}>{fmt(glance.amountSen)}</b>{" "}
            {glance.over ? "over" : "left"}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--accent-track)" }}>
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(0, Math.min(1, glance.fraction)) * 100}%`,
                background: glance.color,
              }}
            />
          </span>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-col gap-3">
          <div
            className="flex items-center gap-2.5 rounded-2xl px-3.5 py-3"
            style={{ background: "var(--chip)" }}
          >
            <SearchIcon />
            <input
              type="text"
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              placeholder='Type it: "nasi lemak 12.5" · "+5.14 mmf"'
              className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none"
              style={{ color: "var(--ink-1)" }}
            />
          </div>
          {nlText.length > 0 ? (
            <p className="-mt-1 px-1 text-xs" style={{ color: "var(--ink-3)" }}>
              {/* The live parse echo — the figure being typed (ruling 4: never masked). */}
              {text(preview, { shown: true })}
            </p>
          ) : null}

          <div className="flex flex-col items-center gap-1 py-1" style={{ opacity: nlActive ? 0.45 : 1 }}>
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-medium" style={{ color: "var(--ink-3)" }}>
                RM
              </span>
              <span className="text-[44px] font-bold tracking-tight" style={{ color: "var(--ink-1)" }}>
                {/* The echo of the amount being typed — never masked (ruling 4).
                    Owner ruling Q33: no figure until an amount is typed; the
                    no-break space keeps the line's height. */}
                {nlActive ? (
                  parsed.amount_sen !== null ? (
                    <Money sen={parsed.amount_sen} bare shown />
                  ) : (
                    "\u00a0"
                  )
                ) : (
                  keypadAmount || "\u00a0"
                )}
              </span>
            </div>
            <div className="flex overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
              {(["expense", "income"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={nlActive}
                  onClick={() => handleTypeToggle(t)}
                  className="px-3.5 py-1 text-xs capitalize"
                  style={{
                    background: effectiveType === t ? "var(--chip)" : "transparent",
                    color: effectiveType === t ? "var(--ink-1)" : "var(--ink-3)",
                    fontWeight: effectiveType === t ? 650 : 400,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {orderedCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedCategoryId(c.id === effectiveCategoryId ? null : c.id)}
                className="flex-shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-[13.5px]"
                style={{
                  background: c.id === effectiveCategoryId ? "var(--accent)" : "var(--chip)",
                  color: c.id === effectiveCategoryId ? "#fff" : "var(--ink-2)",
                  fontWeight: c.id === effectiveCategoryId ? 600 : 400,
                }}
              >
                {c.name}
              </button>
            ))}
          </div>

          <select
            value={effectiveAccountId ?? ""}
            onChange={(e) => setAccountOverride(e.target.value)}
            className="self-start rounded-full px-3.5 py-2 text-[13.5px]"
            style={{ background: "var(--chip)", color: "var(--ink-2)", border: "none" }}
          >
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-3 gap-2 pt-1" style={{ opacity: nlActive ? 0.45 : 1 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                type="button"
                disabled={nlActive}
                onClick={() => pressDigit(d)}
                className="flex h-14 items-center justify-center rounded-2xl text-xl font-medium"
                style={{ background: "var(--chip)", color: "var(--ink-1)" }}
              >
                {d}
              </button>
            ))}
            <button
              type="button"
              disabled={nlActive}
              onClick={pressDot}
              className="flex h-14 items-center justify-center rounded-2xl text-lg"
              style={{ background: "var(--chip)", color: "var(--ink-3)" }}
            >
              .
            </button>
            <button
              type="button"
              disabled={nlActive}
              onClick={() => pressDigit("0")}
              className="flex h-14 items-center justify-center rounded-2xl text-xl font-medium"
              style={{ background: "var(--chip)", color: "var(--ink-1)" }}
            >
              0
            </button>
            <button
              type="button"
              disabled={nlActive}
              onClick={pressBackspace}
              className="flex h-14 items-center justify-center rounded-2xl text-lg"
              style={{ background: "var(--chip)", color: "var(--ink-3)" }}
              aria-label="Backspace"
            >
              ⌫
            </button>
          </div>

          {error ? (
            <p className="text-sm" style={{ color: "var(--critical)" }}>
              {error}
            </p>
          ) : null}

          <Button type="button" variant="primary" className="py-3.5 text-[15px]" disabled={!canSave} onClick={handleSave}>
            {pending ? "Saving…" : effectiveAmountSen ? `Save — ${fmt(effectiveAmountSen, { shown: true })}` : "Save"}
          </Button>

          {teach ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5"
              style={{ background: "var(--chip)" }}
            >
              <Tip className="flex-1" as="span">
                Teach: always file &ldquo;{teach.word}&rdquo; under {teach.categoryName}?
              </Tip>
              <button type="button" onClick={acceptTeach} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                Yes
              </button>
              <button type="button" onClick={() => setTeach(null)} className="text-xs" style={{ color: "var(--ink-3)" }}>
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Recent">
        <Tip className="mb-2">Tap an entry to edit</Tip>
        {optimisticRecents.length === 0 ? (
          <p className="py-4 text-center text-sm" style={{ color: "var(--ink-3)" }}>
            No entries yet.
          </p>
        ) : (
          <div className="flex flex-col">
            {optimisticRecents.map((row) =>
              "pending" in row ? (
                <PendingRow key={row.clientId} entry={row} />
              ) : (
                <RecentRow key={row.id} row={row} accounts={accounts} categories={categories} fxRates={fxRates} funds={funds} todayStr={todayStr} yesterdayStr={yesterdayStr} />
              ),
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * The optimistic Recent row rendered while a save is in flight — reduced
 * opacity plus a "saving…" chip. The chip is tip-STYLED (ink-3, same as
 * Tip) but is state, not education, same precedent as the queue badge above:
 * it stays outside the Tip component so it never hides with tips off.
 */
export function PendingRow({ entry }: { entry: OptimisticEntry }) {
  // Owner ruling Q37: masks like every Recent row (it is one, in flight).
  // Exported for its masked-state test only.
  const { fmt } = useMoney();
  return (
    <div
      className="flex w-full items-center gap-3 border-b py-2.5 text-left last:border-b-0"
      style={{ borderColor: "var(--grid)", opacity: 0.5 }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14.5px] font-medium" style={{ color: "var(--ink-1)" }}>
            {entry.label || (entry.isExpense ? "Expense" : "Income")}
          </span>
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "var(--chip)", color: "var(--ink-3)" }}
          >
            saving…
          </span>
        </span>
      </span>
      <span
        className="flex-shrink-0 text-[14.5px] font-semibold tabular-nums"
        style={{ color: entry.isExpense ? "var(--ink-1)" : "var(--good-text)" }}
      >
        {entry.isExpense ? fmt(-entry.amount_sen) : `+${fmt(entry.amount_sen)}`}
      </span>
    </div>
  );
}

function RecentRow({
  row,
  accounts,
  categories,
  fxRates,
  funds,
  todayStr,
  yesterdayStr,
}: {
  row: EnrichedTxRow;
  accounts: AccountOption[];
  categories: CategoryOption[];
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  funds?: FundOption[];
  todayStr: string;
  yesterdayStr: string;
}) {
  const categoryLabel = categoryLabelFor(row);
  const accountLabel = accountLabelFor(row);
  const description = row.note || categoryLabel;
  const existingTx = existingTxFrom(row);
  const { fmt } = useMoney();

  return (
    <TxFormSheet
      mode="edit"
      accounts={accounts}
      categories={categories}
      fxRates={fxRates}
      funds={funds}
      tx={existingTx}
      todayStr={todayStr}
      triggerLabel="Edit"
      renderTrigger={(onClick) => (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-3 border-b py-2.5 text-left last:border-b-0"
          style={{ borderColor: "var(--grid)" }}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14.5px] font-medium" style={{ color: "var(--ink-1)" }}>
                {description}
              </span>
              {row.needs_review ? (
                <span
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: "color-mix(in srgb, var(--warning) 30%, var(--surface))", color: "var(--ink-1)" }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} />
                  review
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
              <span className="rounded-full px-2 py-0.5" style={{ background: "var(--chip)" }}>
                {categoryLabel}
              </span>
              {accountLabel} · {dateLabel(row.date, todayStr, yesterdayStr)}
            </span>
          </span>
          <span
            className="flex-shrink-0 text-[14.5px] font-semibold tabular-nums"
            style={{ color: row.type === "income" ? "var(--good-text)" : "var(--ink-1)" }}
          >
            {row.type === "income" ? `+${fmt(row.amount_sen)}` : fmt(-row.amount_sen)}
          </span>
        </button>
      )}
    />
  );
}
