import { revalidatePath } from "next/cache";

/** Transaction writes feed month stats/spend everywhere they're read: the
 *  transactions list itself, the dashboard's totals + recent list, Quick
 *  Add's today/month glance, the budget page's spent-per-category meters, and
 *  — since Plan 7 — `/goals`, because a fund-tagged expense moves that fund's
 *  derived balance (ruling 5) and the month's draw list, and `/bills`,
 *  because recording a bill flips its occurrence to `recorded` and drops it
 *  out of the projection (ruling 14 — this is the path `Record now` uses).
 *
 *  ⚠ THE CANONICAL `account_balances` READER ENUMERATION LIVES HERE. A write
 *  that moves any term of that view (`src/db/queries.ts`'s
 *  `getAccountsWithBalances`) must revalidate ALL of:
 *      /net-worth   the accounts part and its rows
 *      /investments the pot's bank/cash-like buckets + the Cash·MMF row
 *      /dashboard   the net-worth glance
 *      /more        the same glance, as a summary row
 *      /bills       ruling 12's spendable base, which the projection starts from
 *      /goals       ruling 9b's "RM x in MYR accounts" denominator
 *      /settings/accounts  the per-account balance column
 *      /transactions       its own account picker reads the balances too
 *  `/quick` is in the set below but is NOT a reader of this view — it selects
 *  `accounts` directly for names/currency. It is revalidated for that, and for
 *  the parser context; do not cite it as evidence about `account_balances`.
 *  There are SEVEN such writers — this one, reconcile, reimbursements,
 *  liability payments, business cash entries, trades, and the account actions
 *  themselves. Add a balance-reading page ⇒ add it to all seven; add an
 *  eighth writer ⇒ give it this whole list. Every past miss in this repo has
 *  been a page added to the view's readership without the writers being
 *  re-walked (Task 5 for /bills, Task 7 for /goals and /settings/accounts).
 *
 *  Plan 8 Task 7 audit (gaps 1–2): the import history — `/settings` and
 *  `/transactions/import` — reads batch-tagged transactions and their
 *  payments (an edit makes a batch "touched", a delete shrinks its count), so
 *  it belongs to every transaction write, not only to the import's own.
 *
 *  ⚠ A PLAIN MODULE, not "use server" (the settings/revalidate.ts shape): the
 *  ordinary actions and the import actions share this ONE set. */
export function revalidateTxPaths(): void {
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/quick");
  revalidatePath("/budget");
  revalidatePath("/goals");
  revalidatePath("/bills");
  revalidatePath("/net-worth");
  revalidatePath("/investments");
  revalidatePath("/settings/accounts");
  revalidatePath("/more");
  revalidatePath("/settings");
  revalidatePath("/transactions/import");
}
