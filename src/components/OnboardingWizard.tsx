"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { useMoney } from "@/components/Money";
import { describeCadence } from "@/lib/recurring-form";
import { AddAccountForm } from "@/app/(app)/settings/accounts/AddAccountForm";
import { archiveCategory } from "@/app/(app)/settings/categories/actions";
import {
  RecurringRuleForm,
  type RecurringRuleDefaults,
} from "@/app/(app)/settings/recurring/RecurringRuleForm";
import { GenerateAliasesButton } from "@/app/(app)/settings/aliases/GenerateAliasesButton";
import { GenerateTokenButton } from "@/app/(app)/settings/shortcut/GenerateTokenButton";
import { ShortcutGuide } from "@/app/(app)/settings/shortcut/ShortcutGuide";
import { updateSettings } from "@/app/(app)/settings/actions";
import {
  hasShortcutEntry,
  getLatestShortcutEntry,
  listAliasPreview,
  type AliasPreview,
  type ShortcutEntryPreview,
} from "@/app/(app)/onboarding/actions";

const STEP_LABELS = ["Welcome", "Accounts", "Categories", "Recurring", "Aliases", "Shortcut", "Done"] as const;
const TOTAL_STEPS = STEP_LABELS.length;
const SHORTCUT_POLL_MS = 5000;

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

export interface OnboardingAccount {
  id: string;
  name: string;
  type: string;
}

export interface OnboardingCategory {
  id: string;
  name: string;
  kind: "expense" | "income";
  parent_id: string | null;
  tag: "needs" | "wants" | "savings";
}

export interface OnboardingRecurringRule extends RecurringRuleDefaults {
  next_run: string;
}

interface OnboardingWizardProps {
  accounts: OnboardingAccount[];
  categories: OnboardingCategory[];
  recurringRules: OnboardingRecurringRule[];
  initialAliases: AliasPreview[];
  initialDefaultAccountId: string | null;
  appUrl: string;
}

/**
 * First-run setup: card-per-step, progress dots, "Skip setup" available at
 * every step (spec §5). Skip and "Do this later" both write
 * `onboarded_at` and exit to /quick — completing is always safe, since every
 * step here is additive (nothing is ever reset by re-running setup).
 *
 * No pure `nextStep(state)` helper: the flow is a strict linear index with
 * no branching beyond "Accounts requires >=1 account before Continue" (a
 * one-line disabled check) — introducing a step-state helper here would be
 * YAGNI, so step advancement is a plain `setStep(n)`.
 */
export function OnboardingWizard({
  accounts,
  categories,
  recurringRules,
  initialAliases,
  initialDefaultAccountId,
  appUrl,
}: OnboardingWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [finishing, startFinishing] = useTransition();
  // Only the user's own in-session pick lives in state; the *effective*
  // default (below) falls back to the server value, then the first account,
  // so the select always reflects the right thing without re-syncing state
  // from props in an effect.
  const [chosenDefaultAccountId, setChosenDefaultAccountId] = useState<string | null>(null);
  const [aliases, setAliases] = useState<AliasPreview[]>(initialAliases);
  const [shortcutEntry, setShortcutEntry] = useState<ShortcutEntryPreview | null>(null);
  const autoPickedDefault = useRef(false);

  const defaultAccountId = chosenDefaultAccountId ?? initialDefaultAccountId ?? accounts[0]?.id ?? "";

  // Persist the auto-picked first account once one exists and neither the
  // server nor the user has set one yet — the picker below still lets the
  // user override it. Fires at most once (ref guard), independent of how
  // many more accounts get added afterward.
  useEffect(() => {
    if (autoPickedDefault.current) return;
    if (!initialDefaultAccountId && !chosenDefaultAccountId && accounts[0]) {
      autoPickedDefault.current = true;
      void updateSettings({ defaultAccountId: accounts[0].id });
    }
  }, [accounts, initialDefaultAccountId, chosenDefaultAccountId]);

  // Poll for the first Shortcut entry only while the Shortcut step is showing
  // and none has been found yet; always cleaned up on step change/unmount.
  useEffect(() => {
    if (step !== 6 || shortcutEntry) return;
    let cancelled = false;
    const id = setInterval(() => {
      void hasShortcutEntry().then((found) => {
        if (cancelled || !found) return;
        void getLatestShortcutEntry().then((entry) => {
          if (!cancelled && entry) setShortcutEntry(entry);
        });
      });
    }, SHORTCUT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step, shortcutEntry]);

  function finish() {
    startFinishing(() => {
      void updateSettings({ onboardedAt: new Date().toISOString() }).then(() => {
        router.push("/quick");
      });
    });
  }

  function chooseDefaultAccount(id: string) {
    setChosenDefaultAccountId(id);
    void updateSettings({ defaultAccountId: id || null });
  }

  function toggleArchiveCategory(id: string) {
    startFinishing(() => {
      void archiveCategory(id).then(() => router.refresh());
    });
  }

  function onAliasResult() {
    void listAliasPreview().then(setAliases);
  }

  const activeCategories = categories; // page already filters to unarchived
  const expenseParents = activeCategories.filter((c) => c.kind === "expense" && c.parent_id === null);
  const incomeParents = activeCategories.filter((c) => c.kind === "income" && c.parent_id === null);
  const childrenOf = (parentId: string) => activeCategories.filter((c) => c.parent_id === parentId);

  const recurringAccountOptions = accounts.map((a) => ({ id: a.id, name: a.name }));
  const recurringCategoryOptions = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="eye-clear flex items-center justify-between">
        <span className="text-xs" style={{ color: "var(--ink-3)" }}>
          Step {step} of {TOTAL_STEPS} — {STEP_LABELS[step - 1]}
        </span>
        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={finish}
            disabled={finishing}
            className="text-xs"
            style={{ color: "var(--accent)" }}
          >
            Skip setup
          </button>
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-1.5">
        {STEP_LABELS.map((label, i) => (
          <span
            key={label}
            aria-hidden
            className="h-1.5 rounded-full transition-all"
            style={{
              width: i + 1 === step ? 18 : 6,
              background: i + 1 <= step ? "var(--accent)" : "var(--grid)",
            }}
          />
        ))}
      </div>

      {step === 1 ? (
        <Card title="Welcome to Duit">
          <Tip className="mb-4">
            Set up in 5 steps — accounts, categories, recurring bills, aliases and the iOS
            Shortcut. Skip anything now and finish it later from Settings; nothing here resets
            data, so re-running setup is always safe.
          </Tip>
          <Button variant="primary" onClick={() => setStep(2)}>
            Get started
          </Button>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="Accounts">
          <Tip className="mb-3">
            Add where your money lives — e.g. “Maybank”, “TnG eWallet”, “Cash”. You can add more
            anytime in Settings.
          </Tip>
          <ul className="mb-3 flex flex-col">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between py-2 text-sm"
                style={{ borderBottom: "1px solid var(--grid)" }}
              >
                <span>{a.name}</span>
                <span
                  className="rounded-full px-2 py-0.5 text-xs"
                  style={{ background: "var(--chip)", color: "var(--ink-2)" }}
                >
                  {a.type}
                </span>
              </li>
            ))}
          </ul>
          <AddAccountForm onCreated={() => router.refresh()} />

          {accounts.length > 0 ? (
            <label className="mt-4 flex items-center justify-between gap-3">
              <span className="text-sm" style={{ color: "var(--ink-1)" }}>
                Default account
              </span>
              <select
                value={defaultAccountId}
                onChange={(e) => chooseDefaultAccount(e.target.value)}
                className="rounded-lg px-3 py-1.5 text-sm outline-none"
                style={inputStyle}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="mt-4 flex justify-end">
            <Button variant="primary" disabled={accounts.length === 0} onClick={() => setStep(3)}>
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title="Categories">
          <Tip className="mb-3">
            Your category tree is pre-seeded and ready to use. Archive anything you won&apos;t
            need — you can restore it later in Settings.
          </Tip>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <h4 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
                Expense
              </h4>
              <ul className="flex flex-col">
                {expenseParents.map((parent) => (
                  <CategoryTreeItem
                    key={parent.id}
                    category={parent}
                    subcategories={childrenOf(parent.id)}
                    onArchive={toggleArchiveCategory}
                  />
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
                Income
              </h4>
              <ul className="flex flex-col">
                {incomeParents.map((parent) => (
                  <CategoryTreeItem
                    key={parent.id}
                    category={parent}
                    subcategories={childrenOf(parent.id)}
                    onArchive={toggleArchiveCategory}
                  />
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setStep(4)}>
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card title="Recurring">
          <Tip className="mb-3">
            Optional — add salary, rent or subscriptions now, or skip and add them later from
            Settings.
          </Tip>
          {recurringRules.length > 0 ? (
            <ul className="mb-3 flex flex-col">
              {recurringRules.map((rule) => (
                <OnboardingRuleLine key={rule.id} rule={rule} />
              ))}
            </ul>
          ) : null}
          <RecurringRuleForm
            accounts={recurringAccountOptions}
            categories={recurringCategoryOptions}
            onSaved={() => router.refresh()}
          />
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setStep(5)}>
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 5 ? (
        <Card title="Aliases">
          <Tip className="mb-3">
            Generate aliases from your account and category names so quick-entry recognizes them
            without you spelling everything out.
          </Tip>
          <GenerateAliasesButton onResult={onAliasResult} />
          {aliases.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {aliases.map((alias) => (
                <li
                  key={alias.phrase}
                  className="flex items-center justify-between py-1.5 text-sm"
                  style={{ borderBottom: "1px solid var(--grid)" }}
                >
                  <span>{alias.phrase}</span>
                  <span aria-hidden style={{ color: "var(--ink-3)" }}>
                    →
                  </span>
                  <span style={{ color: "var(--ink-2)" }}>{alias.targetName}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setStep(6)}>
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 6 ? (
        <Card title="Shortcut">
          <Tip className="mb-3">
            Generate a token, then follow the guide below to wire up the iOS Shortcut for
            5-second entries.
          </Tip>
          <GenerateTokenButton label="Generate token" />
          <div className="mt-4">
            <ShortcutGuide appUrl={appUrl} />
          </div>

          <div className="mt-4 rounded-lg p-3" style={{ background: "var(--page)", border: "1px solid var(--border)" }}>
            {shortcutEntry ? (
              <FirstShortcutEntry entry={shortcutEntry} />
            ) : (
              <span className="text-sm" style={{ color: "var(--ink-3)" }}>
                Waiting for your first Shortcut entry…
              </span>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={finish}
              disabled={finishing}
              className="text-xs"
              style={{ color: "var(--accent)" }}
            >
              Do this later
            </button>
            <Button variant="primary" onClick={() => setStep(7)}>
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 7 ? (
        <Card title="All set">
          <Tip className="mb-4">
            You&apos;re ready to go. Run setup again anytime from Settings — it only adds, never
            resets.
          </Tip>
          <Button variant="primary" disabled={finishing} onClick={finish}>
            {finishing ? "Finishing…" : "Go to Quick Entry"}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

/** Step 4's list row — its own component (exported for the Plan 9 masked-state
 *  test: the wizard's step is internal state a static render cannot reach). */
export function OnboardingRuleLine({ rule }: { rule: OnboardingRecurringRule }) {
  const { fmt } = useMoney();
  return (
    <li className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: "1px solid var(--grid)" }}>
      <span>{rule.name}</span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {describeCadence(rule)} · {fmt(rule.amount_sen)}
      </span>
    </li>
  );
}

/** Step 6's confirmation once the first Shortcut entry lands (exported for the
 *  same reason as `OnboardingRuleLine`). */
export function FirstShortcutEntry({ entry }: { entry: ShortcutEntryPreview }) {
  const { fmt } = useMoney();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium" style={{ color: "var(--good-text)" }}>
        ✓ First entry received
      </span>
      <span className="text-sm" style={{ color: "var(--ink-2)" }}>
        {entry.type} · {fmt(entry.amount_sen)} · {entry.categoryName ?? "Uncategorized"}
        {entry.note ? ` · ${entry.note}` : ""}
      </span>
    </div>
  );
}

function CategoryTreeItem({
  category,
  subcategories,
  onArchive,
}: {
  category: OnboardingCategory;
  subcategories: OnboardingCategory[];
  onArchive: (id: string) => void;
}) {
  return (
    <li className="flex flex-col">
      <CategoryRow category={category} indent={false} onArchive={onArchive} />
      {subcategories.map((child) => (
        <CategoryRow key={child.id} category={child} indent onArchive={onArchive} />
      ))}
    </li>
  );
}

function CategoryRow({
  category,
  indent,
  onArchive,
}: {
  category: OnboardingCategory;
  indent: boolean;
  onArchive: (id: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 py-1.5"
      style={{ borderBottom: "1px solid var(--grid)", paddingLeft: indent ? 16 : 0 }}
    >
      <span className="flex-1 text-sm" style={{ fontWeight: indent ? 400 : 600 }}>
        {category.name}
      </span>
      <button
        type="button"
        onClick={() => onArchive(category.id)}
        className="text-xs"
        style={{ color: "var(--critical)" }}
      >
        Archive
      </button>
    </div>
  );
}
