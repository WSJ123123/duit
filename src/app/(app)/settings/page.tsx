import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { getSettings } from "@/db/settings";
import { getAccountsWithBalances, getSettingsSummaries, activeTokensLabel } from "@/db/queries";
import { listImportBatches } from "@/db/import/history";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { ImportHistory } from "@/components/ImportHistory";
import { SettingsControls } from "./SettingsControls";

const SECTIONS: Array<{ label: string; href: string; tip: string; summaryKey: string }> = [
  { label: "Accounts", href: "/settings/accounts", tip: "Bank, e-wallet, cash, brokerage, EPF and other holdings.", summaryKey: "accounts" },
  { label: "Categories", href: "/settings/categories", tip: "The expense and income tree used across budgets and entries.", summaryKey: "categories" },
  { label: "Aliases", href: "/settings/aliases", tip: "Shortcuts the quick-entry parser learns, like \"grab\" → Transport.", summaryKey: "aliases" },
  { label: "Shortcut", href: "/settings/shortcut", tip: "The iOS Shortcut and token used for 5-second quick-entry.", summaryKey: "shortcut" },
  { label: "Recurring", href: "/settings/recurring", tip: "Bills and income that post automatically on a schedule.", summaryKey: "recurring" },
];

export default async function SettingsIndexPage() {
  const supabase = await createServerSupabase();
  const [settings, accounts, summaries, imports] = await Promise.all([
    getSettings(supabase),
    getAccountsWithBalances(supabase),
    getSettingsSummaries(supabase),
    listImportBatches(supabase),
  ]);
  const activeAccounts = accounts.filter((a) => !a.archived);

  const summaryValueFor = (key: string): string => {
    switch (key) {
      case "accounts":
        return `${summaries.accounts} active`;
      case "categories":
        return `${summaries.categories} active`;
      case "aliases":
        return `${summaries.aliases} aliases`;
      case "shortcut":
        return activeTokensLabel(summaries.activeTokens);
      case "recurring":
        return `${summaries.recurringRules} active rules`;
      default:
        return "";
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink-1)" }}>
          Settings
        </h1>
        <Tip>Manage accounts, categories and how the app talks to you.</Tip>
      </div>

      <Card title="Sections">
        <ul className="flex flex-col">
          {SECTIONS.map((section) => (
            <li key={section.href} style={{ borderBottom: "1px solid var(--grid)" }}>
              <Link href={section.href} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
                    {section.label}
                  </span>
                  <Tip>{section.tip}</Tip>
                </span>
                <span className="flex flex-shrink-0 items-center gap-3">
                  <span className="text-sm" style={{ color: "var(--ink-2)" }}>
                    {summaryValueFor(section.summaryKey)}
                  </span>
                  <span aria-hidden style={{ color: "var(--ink-3)" }}>
                    →
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Preferences">
        <Tip>Applies everywhere in the app, right away.</Tip>
        <SettingsControls
          initialShowTips={settings.show_tips}
          initialDefaultAccountId={settings.default_account_id}
          accounts={activeAccounts}
        />
      </Card>

      <Card title="Setup">
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
              Run setup again
            </span>
            <Tip>Walks through accounts, categories, recurring, aliases and Shortcut again — never resets existing data.</Tip>
          </span>
          <Link href="/onboarding" className="text-sm" style={{ color: "var(--accent)" }}>
            Start →
          </Link>
        </div>
      </Card>

      <ImportHistory rows={imports} />

      <Card title="Export">
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
              Download all data
            </span>
            <Tip>Everything you&apos;ve logged, as spreadsheets — a second backup that&apos;s always current.</Tip>
          </span>
          <span className="flex flex-shrink-0 items-center gap-3">
            <span className="text-sm" style={{ color: "var(--ink-2)" }}>
              {/* Must track src/app/api/export/route.ts's table list — this
                  label sat at 7 while Plan 7 grew the zip to 9 (funds,
                  fund_contributions); Plan 8 added import_batches. */}
              10 CSV files, zipped
            </span>
            <Link href="/api/export" className="text-sm" style={{ color: "var(--accent)" }}>
              Download →
            </Link>
          </span>
        </div>
      </Card>
    </div>
  );
}
