"use client";

import { startTransition, useState } from "react";
import { Button } from "@/components/Button";
import { useMoney } from "@/components/Money";
import { describeCadence, type RecurringType } from "@/lib/recurring-form";
import { archiveRecurringRule, unarchiveRecurringRule } from "./actions";
import { RecurringRuleForm, type RecurringRuleDefaults } from "./RecurringRuleForm";

interface Option {
  id: string;
  name: string;
}

interface CategoryOption extends Option {
  kind: "expense" | "income";
}

const TYPE_LABELS: Record<RecurringType, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
};

interface RecurringRuleRowProps {
  rule: RecurringRuleDefaults;
  active: boolean;
  accountName: string;
  nextRun: string;
  accounts: Option[];
  categories: CategoryOption[];
}

/** One list row: view mode with Edit/Archive/Restore, or an inline edit form. */
export function RecurringRuleRow({
  rule,
  active,
  accountName,
  nextRun,
  accounts,
  categories,
}: RecurringRuleRowProps) {
  const { fmt } = useMoney();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="py-3" style={{ borderBottom: "1px solid var(--grid)" }}>
        <RecurringRuleForm
          accounts={accounts}
          categories={categories}
          rule={rule}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      className="flex flex-wrap items-center gap-3 py-2.5"
      style={{ opacity: active ? 1 : 0.6, borderBottom: "1px solid var(--grid)" }}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
          {rule.name}
        </span>
        <span className="text-xs" style={{ color: "var(--ink-3)" }}>
          {TYPE_LABELS[rule.type]} · {describeCadence(rule)} · {accountName}
        </span>
      </span>
      <span className="flex-shrink-0 text-sm tabular-nums" style={{ color: "var(--ink-2)" }}>
        {rule.variable ? "variable" : fmt(rule.amount_sen)}
      </span>
      <span className="flex-shrink-0 text-xs" style={{ color: "var(--ink-3)" }}>
        Next {nextRun}
      </span>
      <span
        className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs"
        style={{ background: "var(--chip)", color: "var(--ink-2)" }}
      >
        {active ? "Active" : "Archived"}
      </span>
      {active ? (
        <Button type="button" variant="secondary" className="px-2 py-1" onClick={() => setEditing(true)}>
          Edit
        </Button>
      ) : null}
      <ArchiveToggle ruleId={rule.id} active={active} />
    </li>
  );
}

/** Plan 9 Q26: `Restore` can be REFUSED (the rule's account is archived),
 *  and the refusal names the account to re-point — data the owner acts on,
 *  so it is shown on the row (the house's error line, as
 *  AccountCurrencyControl draws it), never dropped. */
function ArchiveToggle({ ruleId, active }: { ruleId: string; active: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function run() {
    setPending(true);
    setError(undefined);
    startTransition(() => {
      const action = active ? archiveRecurringRule : unarchiveRecurringRule;
      void action(ruleId)
        .then((result) => setError(result.error))
        // Rule 15: a rejected action (network, a thrown server error) says so
        // on the row too, never a silent console rejection (final review B, q1).
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "The request did not complete"))
        .finally(() => setPending(false));
    });
  }

  return (
    <>
      <Button type="button" variant="ghost" className="px-2 py-1" disabled={pending} onClick={run}>
        {pending ? "…" : active ? "Archive" : "Restore"}
      </Button>
      {error ? (
        <span className="basis-full text-[11px]" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </>
  );
}
