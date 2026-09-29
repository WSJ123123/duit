# Duit — personal finance PWA

Duit is a mobile-first personal-finance app for day-to-day money in Malaysia
(MYR, with multi-currency holdings). Logging a purchase is one line of text,
works offline, and the rest of the app turns those entries into budgets,
goals, bills, net worth and an investment portfolio.

## Try it live

**👉 https://finance-platform-drab.vercel.app**

Sign in with the demo account:

| | |
|---|---|
| Email | `demo@duit-demo.example` |
| Password | `12345678` |

It's loaded with a month of sample data (accounts, spending, a budget, a
savings goal, a loan and an investment), so every screen has something to
show. Feel free to add, edit or delete anything; the demo is reset
regularly. On a phone, "Add to Home Screen" installs it as an app.

## What it does

- **Quick entry** — type `nasi lemak 12.50 tng` and a deterministic parser
  (no LLM, no network) picks the amount, category and account from aliases,
  account names, category names and a Malaysian merchant dictionary. Also
  available from an iOS Shortcut through a token-authenticated API.
- **Transactions** — expenses, income, transfers (including cross-currency),
  splits, reimbursements ("someone owes me back"), reconciliation.
- **Budget** — zero-based monthly plan with needs / wants / savings
  benchmarks, and an audit trail for every reallocation.
- **Goals & funds** — emergency, sinking and goal funds with a contribution
  waterfall.
- **Bills & cashflow** — recurring rules materialised daily by a cron job,
  plus a projected cashflow view.
- **Net worth & investments** — accounts, stock / ETF / crypto holdings with
  daily prices and FX, manual assets, liabilities, a debt-payoff planner and
  daily net-worth snapshots.
- **CSV import** — bank-statement import with column mapping, duplicate
  detection, a review queue and one-click undo.
- **Export** — everything as a zip of CSVs.

## Stack

- **Next.js 16** (App Router, Server Components, Server Actions) + **React 19**
- **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Supabase** — Postgres, Auth, Row Level Security
- **Tailwind CSS 4**
- **Serwist** service worker for the installable, offline-capable PWA
- **Zod** at every server boundary
- **Vitest** (unit + database integration) and **Playwright** (E2E)
- Deployed on **Vercel** with a daily cron

## Architecture highlights

### Money is integer sen, end to end
Every amount is a `bigint` column in minor units (`amount_sen`,
`balance_sen`, …). User input is parsed with string arithmetic, never
`parseFloat`. Quantities and prices for investments are fixed-point × 10⁸
(`quantity_e8`, `price_e8`), and valuation math runs in `BigInt` with
explicit half-up rounding (`src/lib/portfolio.ts`). Balances are never
stored. They come from a `security_invoker` view (`account_balances`) that
sums the ledger.

### Row Level Security on every table
Every user-owned table has RLS enabled and an `own` policy on
`user_id = auth.uid()`. Cross-table references use **composite foreign keys**
on `(id, user_id)`, so a row can't point at another user's account or
category even through the service role. Default privileges are pinned so new
tables start with no `anon` access. `src/db/rls.test.ts` and
`src/db/ownership.test.ts` prove isolation between two real users on a local
Supabase stack. The few service-role paths (the iOS Shortcut endpoint, the
cron) filter by `user_id` explicitly.

### Idempotent entry paths
Every path that creates a transaction can be retried safely:
- Quick entry uses a **client-generated UUID**, so a retry after a flaky
  network re-reads the existing row instead of inserting a second one.
- Recurring rules materialise with **deterministic UUIDv5 ids** (rule +
  date), so the daily cron can run twice without double-posting.
- CSV import uses deterministic ids per statement row, plus a SHA-256 of
  the file to catch re-uploads. Each import is a batch that can be undone.

### Offline-first PWA
The quick-entry screen works with no connection. Entries go into an
IndexedDB FIFO queue (`src/lib/offline-queue.ts`, no runtime deps), render
optimistically, and flush in order when the device comes back online. The
client UUIDs above keep that replay idempotent.

### "Hide amounts" privacy toggle
One tap masks every figure in the app as a fixed-width `RM ••••`. It's
fixed-width because keeping the digit count would leak magnitude. The
setting is a per-device cookie read on the server, so masked pages render
masked at first paint with no flash. A Playwright spec walks **every route**
at desktop and phone widths and fails if any money-shaped text or attribute
survives (`e2e/amounts-hidden.spec.ts`).

### CSV import
A pure, I/O-free import layer (`src/lib/import.ts`) handles column mapping
(remembered per account), debit/credit and signed-amount layouts, date
formats and duplicate matching against existing transactions. It
categorises rows with the same parser as quick entry, and flags
low-confidence rows for review.

## Project layout

```
src/app/            routes — (app)/ is the signed-in shell, api/ the HTTP endpoints
src/components/     client components
src/db/             data access (+ integration tests against local Supabase)
src/lib/            pure domain logic: money, parser, import, budget, portfolio…
supabase/migrations schema, RLS policies, views and functions
e2e/                Playwright specs
scripts/            icon generator, demo-data seeder
```

## Testing

About 1,300 automated tests cover the app:

- **Unit tests (Vitest):** money maths, the quick-entry parser, CSV import,
  budgets, recurring rules and portfolio valuation.
- **Database tests:** run against a real Postgres. They sign in as two
  separate users and prove neither can read or change the other's data
  (`src/db/rls.test.ts`).
- **End-to-end tests (Playwright):** the quick-entry flow, and a walk of
  every page checking that "Hide amounts" leaves no figure on screen.

TypeScript runs in strict mode, and linting is enforced.
