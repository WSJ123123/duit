"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { parseAmountToSen } from "@/lib/money";
import { useMoney } from "@/components/Money";
import {
  createBusiness,
  saveBusinessEntry,
  deleteBusinessEntry,
  archiveBusiness,
  unarchiveBusiness,
} from "@/app/(app)/net-worth/actions";
import { Button } from "@/components/Button";
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
 * Business-investment dialogs and row interactivity for the Net Worth page
 * (Task 6 + its data-layer follow-up): "Add business", "Record entry"
 * (create) / "Edit entry" (same dialog, prefilled, saved under the SAME
 * client UUID so saveBusinessEntry updates in place), and the row's
 * expand-to-entries section with per-entry edit/delete (ruling 20 — entries
 * are hard-deletable ledger corrections).
 */

const ENTRY_KIND_OPTIONS = [
  { value: "contribution", label: "Contribution" },
  { value: "return", label: "Return" },
  { value: "valuation", label: "Valuation" },
] as const;

type EntryKind = (typeof ENTRY_KIND_OPTIONS)[number]["value"];

/** One projected business_investment_entries row (getNetWorth's shape). */
export interface BusinessEntryItem {
  id: string;
  kind: EntryKind;
  amount_sen: number;
  account_id: string | null;
  account_name: string | null;
  date: string;
  note: string;
}

interface AccountOption {
  id: string;
  name: string;
}

/** Same "17 Aug" treatment as the page's metas (local copy — the page's
 *  helper lives in a server component). */
function dayMonthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function AddBusinessButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();

  function submit() {
    if (!name.trim()) return setError("Name is required.");
    startTransition(async () => {
      const result = await createBusiness({ name: name.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      if (!result.ok) return setError(result.error);
      router.refresh();
      setOpen(false);
      setName("");
      setNote("");
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add business
      </Button>
      {open ? (
        <DialogShell title="Add business" onClose={() => setOpen(false)}>
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <Field label="Note — optional">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <ErrorLine error={error} />
          <DialogButtons onCancel={() => setOpen(false)} onSave={submit} pending={pending} saveLabel="Add business" />
        </DialogShell>
      ) : null}
    </>
  );
}

/** Plan 7 ruling 13 — the third of the three types, existing action. */
export function ArchiveBusinessButton({ businessId }: { businessId: string }) {
  return (
    <TwoTapAction
      label="Archive"
      confirmLabel="Confirm archive"
      pendingLabel="Archiving…"
      run={() => archiveBusiness(businessId)}
    />
  );
}

/**
 * Ruling 4: archiving is reversible everywhere. Same reasoning as
 * ManualItemDialogs.tsx's UnarchiveAssetButton — businesses have no edit
 * dialog either, so this is the same minimal inline ActionLink.
 */
export function UnarchiveBusinessButton({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveBusiness(businessId);
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

export function BusinessEntryButton({
  businessId,
  businessName,
  accounts,
  todayStr,
}: {
  businessId: string;
  businessName: string;
  accounts: AccountOption[];
  todayStr: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionLink onClick={() => setOpen(true)}>Record entry</ActionLink>
      {open ? (
        <BusinessEntryDialog
          businessId={businessId}
          businessName={businessName}
          accounts={accounts}
          todayStr={todayStr}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function BusinessEntryDialog({
  businessId,
  businessName,
  accounts,
  todayStr,
  existing,
  onClose,
}: {
  businessId: string;
  businessName: string;
  accounts: AccountOption[];
  todayStr: string;
  /** Prefills the form and saves under the SAME entry id (edit mode). */
  existing?: BusinessEntryItem;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [entryId] = useState(() => existing?.id ?? crypto.randomUUID());
  const [kind, setKind] = useState<EntryKind>(existing?.kind ?? "contribution");
  const [amount, setAmount] = useState(existing ? senToInputStr(existing.amount_sen) : "");
  const [accountId, setAccountId] = useState(() =>
    existing?.account_id && accounts.some((a) => a.id === existing.account_id)
      ? existing.account_id
      : (accounts[0]?.id ?? ""),
  );
  const [date, setDate] = useState(existing?.date ?? todayStr);
  const [note, setNote] = useState(existing?.note ?? "");
  const [error, setError] = useState<string>();

  function submit() {
    const amount_sen = parseAmountToSen(amount);
    if (amount_sen === null) return setError("Enter a valid amount.");
    if (kind !== "valuation" && !accountId) return setError("Choose the account the cash moved through.");
    startTransition(async () => {
      const result = await saveBusinessEntry({
        id: entryId,
        business_id: businessId,
        kind,
        amount_sen,
        account_id: kind === "valuation" ? null : accountId,
        date,
        note: note.trim(),
      });
      if (!result.ok) return setError(result.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title={`${existing ? "Edit entry" : "Record entry"} — ${businessName}`} onClose={onClose}>
      <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
        {ENTRY_KIND_OPTIONS.map((k) => (
          <button
            key={k.value}
            type="button"
            onClick={() => setKind(k.value)}
            className="flex-1 py-2 text-sm"
            style={{
              background: kind === k.value ? "var(--chip)" : "transparent",
              color: kind === k.value ? "var(--ink-1)" : "var(--ink-3)",
              fontWeight: kind === k.value ? 650 : 400,
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex gap-3">
        <Field label="Amount (RM)">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
      {kind !== "valuation" ? (
        <Field label="Account">
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
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
      ) : null}
      <Field label="Note — optional">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>
      <ErrorLine error={error} />
      <DialogButtons
        onCancel={onClose}
        onSave={submit}
        pending={pending}
        saveLabel={existing ? "Save" : "Record entry"}
      />
    </DialogShell>
  );
}

/**
 * The row's expand affordance + entries list. Rendered as the LAST child of
 * the flex-wrap business row: the toggle sits inline with the other
 * affordances and the expanded list wraps onto its own full-width line
 * (`basis-full`). No house progressive-disclosure pattern existed to reuse —
 * this ActionLink toggle is the minimal consistent choice (reported).
 */
export function BusinessEntriesSection({
  businessId,
  businessName,
  entries,
  accounts,
  todayStr,
}: {
  businessId: string;
  businessName: string;
  entries: BusinessEntryItem[];
  accounts: AccountOption[];
  todayStr: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ActionLink onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide entries" : `Entries (${entries.length})`}
      </ActionLink>
      {expanded ? (
        <div className="basis-full">
          {entries.length === 0 ? (
            <p className="py-1.5 pl-3 text-xs" style={{ color: "var(--ink-3)" }}>
              No entries yet.
            </p>
          ) : (
            entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                businessId={businessId}
                businessName={businessName}
                accounts={accounts}
                todayStr={todayStr}
              />
            ))
          )}
        </div>
      ) : null}
    </>
  );
}

// Exported for its masked-state test only (it renders behind the
// section's closed-by-default `Entries (n)` toggle).
export function EntryRow({
  entry,
  businessId,
  businessName,
  accounts,
  todayStr,
}: {
  entry: BusinessEntryItem;
  businessId: string;
  businessName: string;
  accounts: AccountOption[];
  todayStr: string;
}) {
  const router = useRouter();
  const { fmt } = useMoney();
  const [pending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const kindLabel = ENTRY_KIND_OPTIONS.find((k) => k.value === entry.kind)?.label ?? entry.kind;

  /** Two-tap confirm (no house confirm-dialog pattern exists — reported):
   *  first tap arms the critical "Confirm delete", second hard-deletes. */
  function handleDelete() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const result = await deleteBusinessEntry(entry.id);
      if (!result.ok) {
        setConfirming(false);
        return setError(result.error);
      }
      router.refresh();
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2.5 py-2 pl-3 text-sm"
      style={{ borderTop: "1px solid var(--grid)" }}
    >
      <span className="flex-1">
        <span className="font-medium" style={{ color: "var(--ink-1)" }}>
          {kindLabel}
        </span>
        {entry.note ? (
          <span className="ml-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
            {entry.note}
          </span>
        ) : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {dayMonthLabel(entry.date)}
        {entry.account_name ? ` · ${entry.account_name}` : ""}
      </span>
      <span className="tabular-nums font-semibold" style={{ color: "var(--ink-2)" }}>
        {fmt(entry.amount_sen)}
      </span>
      <ActionLink onClick={() => setEditOpen(true)}>Edit</ActionLink>
      <button
        type="button"
        onClick={handleDelete}
        disabled={pending}
        className="flex-shrink-0 whitespace-nowrap text-xs font-medium"
        style={{ color: confirming || pending ? "var(--critical)" : "var(--accent)" }}
      >
        {pending ? "Deleting…" : confirming ? "Confirm delete" : "Delete"}
      </button>
      {error ? (
        // Rule 15: a failed delete never fails silently — always visible.
        <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
      {editOpen ? (
        <BusinessEntryDialog
          businessId={businessId}
          businessName={businessName}
          accounts={accounts}
          todayStr={todayStr}
          existing={entry}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
    </div>
  );
}
