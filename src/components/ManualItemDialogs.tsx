"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { parseAmountToSen } from "@/lib/money";
import { monthLabel, paymentRateSen, projectPayoff, ratePct } from "@/lib/debt";
import { editedAfterPartialNotice } from "@/lib/liability-payment";
import {
  createManualAsset,
  setManualAssetValue,
  archiveManualAsset,
  unarchiveManualAsset,
  createLiability,
  updateLiability,
  setLiabilityBalance,
  recordLiabilityPayment,
  archiveLiability,
  unarchiveLiability,
} from "@/app/(app)/net-worth/actions";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { useMoney } from "@/components/Money";
import {
  inputStyle,
  senToInputStr,
  ActionLink,
  TwoTapAction,
  Field,
  DialogShell,
  ErrorLine,
  DialogButtons,
} from "@/components/DialogKit";

/**
 * Manual-asset and liability dialogs for the Net Worth page (Task 6): the
 * "Add asset" / "Add liability" create forms, the manual-asset "Update
 * value" form, and the liability "Record payment" (+ "Set balance"
 * secondary) form. Business dialogs live in BusinessDialogs.tsx — split out
 * because assets/liabilities and business investments are unrelated
 * domains (see task-6-report.md).
 */

const ASSET_KIND_OPTIONS = [
  { value: "epf", label: "EPF" },
  { value: "fd", label: "Fixed deposit" },
  { value: "property", label: "Property" },
  { value: "vehicle", label: "Vehicle" },
  { value: "other", label: "Other" },
] as const;

const LIABILITY_KIND_OPTIONS = [
  { value: "loan", label: "Loan" },
  { value: "credit_card", label: "Credit card" },
  { value: "ptptn", label: "PTPTN" },
  { value: "other", label: "Other" },
] as const;

interface AccountOption {
  id: string;
  name: string;
}

interface CategoryOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Manual assets
// ---------------------------------------------------------------------------

export function AddAssetButton({ todayStr }: { todayStr: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add asset
      </Button>
      {open ? <AddAssetDialog todayStr={todayStr} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddAssetDialog({ todayStr, onClose }: { todayStr: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof ASSET_KIND_OPTIONS)[number]["value"]>("other");
  const [value, setValue] = useState("");
  const [date, setDate] = useState(todayStr);
  const [error, setError] = useState<string>();

  function submit() {
    if (!name.trim()) return setError("Name is required.");
    const value_sen = value.trim() ? parseAmountToSen(value) : undefined;
    if (value.trim() && value_sen === null) return setError("Enter a valid initial value.");
    startTransition(async () => {
      const result = await createManualAsset({
        name: name.trim(),
        kind,
        ...(value_sen !== undefined && value_sen !== null ? { value_sen, noted_on: date } : {}),
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title="Add asset" onClose={onClose}>
      <Field label="Name">
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
          {ASSET_KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-3">
        <Field label="Initial value (RM) — optional">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>
      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} saveLabel="Add asset" />
    </DialogShell>
  );
}

export function UpdateAssetValueButton({
  assetId,
  name,
  currentValueSen,
  todayStr,
}: {
  assetId: string;
  name: string;
  currentValueSen: number;
  todayStr: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(senToInputStr(currentValueSen));
  const [date, setDate] = useState(todayStr);
  const [error, setError] = useState<string>();

  function submit() {
    const value_sen = parseAmountToSen(value);
    if (value_sen === null) return setError("Enter a valid value.");
    startTransition(async () => {
      const result = await setManualAssetValue(assetId, value_sen, date);
      if (!result.ok) return setError(result.error);
      router.refresh();
      setOpen(false);
    });
  }

  return (
    <>
      <ActionLink onClick={() => setOpen(true)}>Update value</ActionLink>
      {open ? (
        <DialogShell title={`Update value — ${name}`} onClose={() => setOpen(false)}>
          <div className="flex gap-3">
            <Field label="Value (RM)">
              <input
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
          </div>
          <ErrorLine error={error} />
          <DialogButtons onCancel={() => setOpen(false)} onSave={submit} pending={pending} />
        </DialogShell>
      ) : null}
    </>
  );
}

/**
 * Plan 7 ruling 13: the archive affordance the three Net Worth types never
 * had — an inline link with the house two-tap confirm, calling the existing
 * `archiveManualAsset` action. Symmetric with `UnarchiveAssetButton` below;
 * no new server code and no new dialog.
 */
export function ArchiveAssetButton({ assetId }: { assetId: string }) {
  return (
    <TwoTapAction
      label="Archive"
      confirmLabel="Confirm archive"
      pendingLabel="Archiving…"
      run={() => archiveManualAsset(assetId)}
    />
  );
}

/**
 * Ruling 4: archiving is reversible everywhere. Manual assets have no edit
 * dialog to host this in (none exists — see task-3-report.md's visual-gap
 * note), so the minimal consistent choice is this inline ActionLink next to
 * the row's "archived" pill, matching the house link-trigger treatment.
 */
export function UnarchiveAssetButton({ assetId }: { assetId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveManualAsset(assetId);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <>
      <ActionLink onClick={unarchive}>{pending ? "Unarchiving…" : "Unarchive"}</ActionLink>
      {error ? (
        <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Liabilities
// ---------------------------------------------------------------------------

export function AddLiabilityButton({ todayStr }: { todayStr: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add liability
      </Button>
      {open ? <AddLiabilityDialog todayStr={todayStr} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddLiabilityDialog({ todayStr, onClose }: { todayStr: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof LIABILITY_KIND_OPTIONS)[number]["value"]>("other");
  const [rate, setRate] = useState("");
  const [minPayment, setMinPayment] = useState("");
  const [balance, setBalance] = useState("");
  const [date, setDate] = useState(todayStr);
  const [error, setError] = useState<string>();

  function submit() {
    if (!name.trim()) return setError("Name is required.");
    const interest_rate_bp = rate.trim() ? Math.round(Number(rate) * 100) : undefined;
    if (rate.trim() && (interest_rate_bp === undefined || !Number.isFinite(interest_rate_bp))) {
      return setError("Enter a valid interest rate.");
    }
    const minimum_payment_sen = minPayment.trim() ? parseAmountToSen(minPayment) : undefined;
    if (minPayment.trim() && minimum_payment_sen === null) return setError("Enter a valid minimum payment.");
    const balance_sen = balance.trim() ? parseAmountToSen(balance) : undefined;
    if (balance.trim() && balance_sen === null) return setError("Enter a valid balance.");
    startTransition(async () => {
      const result = await createLiability({
        name: name.trim(),
        kind,
        ...(interest_rate_bp !== undefined ? { interest_rate_bp } : {}),
        ...(minimum_payment_sen !== undefined && minimum_payment_sen !== null ? { minimum_payment_sen } : {}),
        ...(balance_sen !== undefined && balance_sen !== null ? { balance_sen, noted_on: date } : {}),
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title="Add liability" onClose={onClose}>
      <Field label="Name">
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
          {LIABILITY_KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-3">
        <Field label="Interest rate (%) — optional">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
        <Field label="Min payment (RM) — optional">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={minPayment}
            onChange={(e) => setMinPayment(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field label="Initial balance (RM) — optional">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>
      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} saveLabel="Add liability" />
    </DialogShell>
  );
}

/** Plan 8 ruling 10: "plan" is the third mode of the SAME dialog — the
 *  planned monthly payment only, previewed live from src/lib/debt.ts. */
type LiabilityMode = "payment" | "balance" | "plan";

const MODE_TITLE: Record<LiabilityMode, string> = {
  payment: "Record payment",
  balance: "Set balance",
  plan: "Plan payment",
};

interface LiabilityDialogProps {
  liabilityId: string;
  liabilityName: string;
  prefillAmountSen: number;
  prefillCategoryId: string | null;
  /** Latest balance-history date (ruling 10) — "" when none yet. */
  latestNotedOn: string;
  /** Plan-mode inputs (Plan 8 ruling 9): the latest balance and rate the
   *  preview projects from, and the planned payment already on file. */
  balanceSen: number;
  interestRateBp: number;
  plannedPaymentSen: number;
  accounts: AccountOption[];
  categories: CategoryOption[];
  todayStr: string;
}

export function LiabilityActionsButton({
  initialMode = "payment",
  ...props
}: LiabilityDialogProps & { initialMode?: LiabilityMode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionLink onClick={() => setOpen(true)}>{MODE_TITLE[initialMode]}</ActionLink>
      {open ? <LiabilityActionsDialog {...props} initialMode={initialMode} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Plan 7 ruling 13 — same shape as ArchiveAssetButton, existing action. */
export function ArchiveLiabilityButton({ liabilityId }: { liabilityId: string }) {
  return (
    <TwoTapAction
      label="Archive"
      confirmLabel="Confirm archive"
      pendingLabel="Archiving…"
      run={() => archiveLiability(liabilityId)}
    />
  );
}

/**
 * Ruling 4: archiving is reversible everywhere. Same reasoning as
 * UnarchiveAssetButton above — liabilities have no edit dialog either.
 */
export function UnarchiveLiabilityButton({ liabilityId }: { liabilityId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveLiability(liabilityId);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <>
      <ActionLink onClick={unarchive}>{pending ? "Unarchiving…" : "Unarchive"}</ActionLink>
      {error ? (
        <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </>
  );
}

// Exported for its masked-state test only (DialogShell portals, so the
// closed-by-default button never renders the sub-lines in a static render).
export function LiabilityActionsDialog({
  liabilityId,
  liabilityName,
  prefillAmountSen,
  prefillCategoryId,
  latestNotedOn,
  balanceSen,
  interestRateBp,
  plannedPaymentSen,
  accounts,
  categories,
  todayStr,
  initialMode,
  onClose,
}: LiabilityDialogProps & { initialMode: LiabilityMode; onClose: () => void }) {
  const router = useRouter();
  const { fmt } = useMoney();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<LiabilityMode>(initialMode);
  const [planned, setPlanned] = useState(plannedPaymentSen > 0 ? senToInputStr(plannedPaymentSen) : "");
  // Plan 8 ruling 1: the uuid is the idempotency key of performRecordLiability-
  // Payment's partial-failure retry, so it must belong to ONE set of figures.
  // Every field change below regenerates it; a retry with the same figures
  // converges, an edited retry is a new entry (pinned in networth.test.ts —
  // the house has no component tests). `accounts` arrives already filtered
  // to non-archived MYR accounts by the Net Worth page.
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID());
  // Final review A I1: once a payment's expense half is saved, an edit makes
  // the next press a second payment — say so instead of the retry promise.
  const [partialSavedSen, setPartialSavedSen] = useState<number | null>(null);
  const freshUuid = () => {
    setClientUuid(crypto.randomUUID());
    if (partialSavedSen !== null) setError(editedAfterPartialNotice(partialSavedSen));
  };
  const [amount, setAmount] = useState(prefillAmountSen > 0 ? senToInputStr(prefillAmountSen) : "");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(prefillCategoryId ?? categories[0]?.id ?? "");
  const [balance, setBalance] = useState("");
  const [date, setDate] = useState(todayStr);
  const [error, setError] = useState<string>();

  function submitPayment() {
    const amount_sen = parseAmountToSen(amount);
    if (amount_sen === null || amount_sen <= 0) return setError("Enter a valid payment amount.");
    if (!accountId) return setError("Choose an account.");
    if (!categoryId) return setError("Choose a category.");
    startTransition(async () => {
      const result = await recordLiabilityPayment({
        liability_id: liabilityId,
        account_id: accountId,
        category_id: categoryId,
        amount_sen,
        date,
        client_uuid: clientUuid,
      });
      if (!result.ok) {
        if (result.partial) setPartialSavedSen(amount_sen);
        return setError(result.error);
      }
      router.refresh();
      onClose();
    });
  }

  function submitBalance() {
    const balance_sen = parseAmountToSen(balance);
    if (balance_sen === null) return setError("Enter a valid balance.");
    startTransition(async () => {
      const result = await setLiabilityBalance(liabilityId, balance_sen, date);
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  // Plan mode: an empty field is 0 (fall back to the minimum, ruling 9).
  const plannedSen = planned.trim() === "" ? 0 : parseAmountToSen(planned);
  const planRate =
    plannedSen === null
      ? null
      : paymentRateSen({ planned_payment_sen: plannedSen, minimum_payment_sen: prefillAmountSen });
  const preview = plannedSen !== null && planRate !== null ? projectPayoff(balanceSen, interestRateBp, planRate, todayStr) : null;
  const previewCritical = preview !== null && (preview.status === "never" || preview.status === "beyond_horizon");

  function submitPlan() {
    if (plannedSen === null) return setError("Enter a valid planned payment.");
    startTransition(async () => {
      const result = await updateLiability(liabilityId, { planned_payment_sen: plannedSen });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  function previewText(): ReactNode {
    if (plannedSen === null) return "Enter a valid amount to preview.";
    if (balanceSen <= 0) return "Nothing left to pay";
    if (preview === null) return "set a planned payment to see a payoff date";
    switch (preview.status) {
      case "paid":
        return "Nothing left to pay";
      // Ruling 9: both no-date states carry the same figure and the month
      // it clears the balance; only the headline differs.
      case "never":
      case "beyond_horizon": {
        const required = preview.required_to_progress_sen!;
        const by = projectPayoff(balanceSen, interestRateBp, required, todayStr).payoff_month!;
        const headline = preview.status === "never" ? "never at this rate" : "more than 50 years at this rate";
        return `${headline} · ${fmt(required)}/mo would clear it by ${monthLabel(by)}`;
      }
      case "on_track":
        return (
          <>
            Pays off <b>{monthLabel(preview.payoff_month!)}</b> · {preview.months} months ·{" "}
            {fmt(preview.total_interest_sen)} interest
          </>
        );
    }
  }

  const planSub = [
    `balance ${fmt(balanceSen)}`,
    ...(interestRateBp > 0 ? [ratePct(interestRateBp)] : []),
    ...(prefillAmountSen > 0 ? [`minimum ${fmt(prefillAmountSen)}/mo`] : []),
  ].join(" · ");

  return (
    <DialogShell title={`${MODE_TITLE[mode]} — ${liabilityName}`} onClose={onClose}>
      {mode === "payment" ? (
        <>
          <div className="flex gap-3">
            <Field label="Amount (RM)">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  freshUuid();
                }}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  freshUuid();
                }}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
          </div>
          {latestNotedOn !== "" && date < latestNotedOn ? (
            // Ruling 10: contextual form text, not a Tip — it explains what
            // this specific choice does right now, not a standing fact.
            <p className="text-xs" style={{ color: "var(--warning)" }}>
              A later balance entry exists — this payment won&apos;t change the current balance.
            </p>
          ) : null}
          <Field label="From account">
            <select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                freshUuid();
              }}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                freshUuid();
              }}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorLine error={error} />
          <DialogButtons onCancel={onClose} onSave={submitPayment} pending={pending} saveLabel="Record payment" />
          <ActionLink onClick={() => setMode("balance")}>Set balance instead</ActionLink>
        </>
      ) : mode === "balance" ? (
        <>
          <div className="flex gap-3">
            <Field label="Balance (RM)">
              <input
                type="text"
                inputMode="decimal"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  freshUuid(); // `date` is shared with payment mode
                }}
                className="rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </Field>
          </div>
          <ErrorLine error={error} />
          <DialogButtons onCancel={onClose} onSave={submitBalance} pending={pending} saveLabel="Set balance" />
          <ActionLink onClick={() => setMode("payment")}>Record payment instead</ActionLink>
        </>
      ) : (
        <>
          {/* v7 §13 sheet. Data lines (balance/rate/minimum, the preview) stay
              tips-off; only the trailing explanation is a Tip. */}
          <p className="-mt-1 text-xs" style={{ color: "var(--ink-3)" }}>
            {planSub}
          </p>
          <Field label="Planned payment per month (RM)">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <p className="text-xs" style={{ color: previewCritical ? "var(--critical)" : "var(--ink-2)" }}>
            {previewText()}
            <Tip as="span"> — set to 0 to fall back to the minimum; nothing here moves money</Tip>
          </p>
          <ErrorLine error={error} />
          <DialogButtons onCancel={onClose} onSave={submitPlan} pending={pending} />
          <ActionLink onClick={() => setMode("payment")}>Record payment instead</ActionLink>
        </>
      )}
    </DialogShell>
  );
}
