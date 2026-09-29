import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { getAccountsWithBalances } from "@/db/queries";
import { Money } from "@/components/Money";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { AddAccountForm } from "./AddAccountForm";
import { AllocationBucketControl } from "./AllocationBucketControl";
import { AccountCurrencyControl } from "./AccountCurrencyControl";
import { ArchiveAccountButton } from "./ArchiveAccountButton";
import { renameAccount } from "./actions";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  bank: "Bank",
  ewallet: "eWallet",
  cash: "Cash",
  brokerage: "Brokerage",
  epf: "EPF",
  other: "Other",
};

async function renameAccountAction(id: string, formData: FormData): Promise<void> {
  "use server";
  await renameAccount(id, formData);
}

export default async function AccountsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived } = await searchParams;
  const showArchived = archived === "1";

  const supabase = await createServerSupabase();
  const accounts = await getAccountsWithBalances(supabase);
  const visible = accounts.filter((a) => a.archived === showArchived);

  return (
    <div className="flex flex-col gap-6">
      <nav className="eye-clear flex gap-4 text-sm max-md:flex-wrap" style={{ color: "var(--ink-3)" }}>
        <Link href="/settings">Settings</Link>
        <span style={{ color: "var(--ink-1)", fontWeight: 600 }}>Accounts</span>
        <Link href="/settings/categories">Categories</Link>
        <Link href="/settings/aliases">Aliases</Link>
        <Link href="/settings/shortcut">Shortcut</Link>
        <Link href="/settings/recurring">Recurring</Link>
      </nav>

      <Card title="Accounts" subtitle="Bank, e-wallet, cash, brokerage, EPF and other holdings.">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Tip>
            bank / cash-like / equities / exclude feeds the Investments page&rsquo;s allocation plan only — it never
            changes how this account is used anywhere else
          </Tip>
          <Link
            href={showArchived ? "/settings/accounts" : "/settings/accounts?archived=1"}
            className="flex-shrink-0 text-xs"
            style={{ color: "var(--accent)" }}
          >
            {showArchived ? "Show active" : "Show archived"}
          </Link>
        </div>
        <ul className="flex flex-col">
          {visible.length === 0 ? (
            <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
              No {showArchived ? "archived" : "active"} accounts.
            </li>
          ) : null}
          {visible.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center gap-3 py-2.5"
              style={{ borderBottom: "1px solid var(--grid)" }}
            >
              {account.archived ? (
                <span className="flex-1 text-sm font-medium">{account.name}</span>
              ) : (
                <form action={renameAccountAction.bind(null, account.id)} className="flex flex-1 items-center gap-2">
                  <input
                    type="text"
                    name="name"
                    defaultValue={account.name}
                    maxLength={60}
                    className="w-full rounded-lg px-2.5 py-1.5 text-sm outline-none"
                    style={{ background: "var(--page)", border: "1px solid var(--border)", color: "var(--ink-1)" }}
                  />
                  <button type="submit" className="flex-shrink-0 text-xs" style={{ color: "var(--accent)" }}>
                    Save
                  </button>
                </form>
              )}
              <span
                className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs"
                style={{ background: "var(--chip)", color: "var(--ink-2)" }}
              >
                {ACCOUNT_TYPE_LABELS[account.type] ?? account.type}
              </span>
              {!account.archived && account.type === "brokerage" ? (
                <AccountCurrencyControl accountId={account.id} currency={account.currency} />
              ) : null}
              {!account.archived ? (
                <AllocationBucketControl
                  accountId={account.id}
                  accountType={account.type}
                  bucket={account.allocation_bucket}
                />
              ) : null}
              <span className="flex-shrink-0 text-sm tabular-nums" style={{ color: "var(--ink-2)" }}>
                <Money sen={account.balance_sen} currency={account.currency} />
              </span>
              {!account.archived ? <ArchiveAccountButton accountId={account.id} /> : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add account">
        <AddAccountForm />
      </Card>
    </div>
  );
}
