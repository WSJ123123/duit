-- Plan 7 Task 1: Phase-4 savings state — `funds` (the earmark layer, ruling 1:
-- a labelled slice of money the accounts already hold, never a balance) and
-- `fund_contributions` (the monthly earmark, ruling 4), plus
-- `transactions.fund_id` (the draw-down tag, ruling 7) and the
-- `account_balances` view's ACL intent restatement (ruling 18).
--
-- Grants are explicit because migration-created tables get no automatic
-- API-role DML on this image (docs/findings.md #1). Least-privilege per table:
--   funds               select, insert, update  — archive-only: a fund is
--                       referenced by its contributions and by tagged
--                       transactions, so it archives (rule 18) and its
--                       tags survive archiving (ruling 9a).
--   fund_contributions  select, insert, update, delete — a correction-friendly
--                       earmark row referenced by nothing; deleting one just
--                       un-earmarks that month, stranding no history.
-- service_role gets all on both and is never revoked anywhere in this file.
--
-- ⚠ The two NEW tables deliberately carry NO `revoke ... from public, anon,
-- authenticated` — unlike migration 11's 25. This is Plan-6 standing check 3:
-- these are the first tables created since migration 11's `alter default
-- privileges` pins, and Task 1 Step 6 reads their UNTOUCHED production ACL to
-- prove the pins held (finding #16). A pre-emptive revoke would scrub the
-- evidence and make the check unfalsifiable. If Step 6 shows the pin did NOT
-- hold, the revokes get added then — as a recorded finding, not silently.

-- ============ funds (ruling 2) ============
create table public.funds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null check (kind in ('emergency','sinking','goal')),
  target_sen bigint check (target_sen > 0),               -- absolute target
  target_months int check (target_months between 1 and 60),  -- months of avg expense
  target_date date,                                      -- independent of either target
  monthly_contribution_sen bigint not null default 0 check (monthly_contribution_sen >= 0),
  priority int not null default 0,                       -- waterfall ordering (ruling 10)
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  -- ruling 3: a target has exactly one shape, or none.
  check (target_sen is null or target_months is null),
  -- ruling 3: months-of-expenses only means something for the emergency fund.
  check (target_months is null or kind = 'emergency'),
  -- NO unique (user_id, name), deliberately (ruling 9a): archiving a fund must
  -- strand nothing, so the Plan-6 unique (user_id, symbol) trap-shape — an
  -- archived row blocking re-use of its own name — cannot form here.
  unique (id, user_id)                                   -- composite-FK anchor
);
alter table public.funds enable row level security;
create policy funds_own on public.funds
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ fund_contributions (ruling 4) ============
create table public.fund_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fund_id uuid not null,
  month date not null check (extract(day from month) = 1),  -- the budget_months convention
  amount_sen bigint not null check (amount_sen >= 0),   -- no default: ruling 2, and an
                                                       -- omitted amount must raise, not earmark RM 0
  created_at timestamptz not null default now(),
  foreign key (fund_id, user_id) references public.funds(id, user_id),
  unique (user_id, fund_id, month)                       -- ruling 4's on-conflict target
);
alter table public.fund_contributions enable row level security;
create policy fund_contributions_own on public.fund_contributions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ transactions gain the fund draw-down tag (ruling 7) ============
-- Nullable with no default, so every existing row stays valid. Expense-only:
-- income and transfers are not spending out of an earmark. The composite FK
-- keeps the tag inside the owner's own funds (FK checks bypass RLS).
alter table public.transactions
  add column fund_id uuid,
  add constraint transactions_fund_fk
    foreign key (fund_id, user_id) references public.funds(id, user_id),
  add constraint transactions_fund_expense_only
    check (fund_id is null or type = 'expense');

-- Indexes (session-7 convention: skip any whose unique constraint already
-- covers the leftmost prefix — fund_contributions (user_id, fund_id, month)
-- covers its access path). The fund tag is sparse, so its index is partial.
create index funds_user_idx on public.funds(user_id);
create index transactions_fund_idx on public.transactions(fund_id) where fund_id is not null;

grant select, insert, update on public.funds to authenticated;
grant select, insert, update, delete on public.fund_contributions to authenticated;
grant all on public.funds, public.fund_contributions to service_role;

-- ============ account_balances states its ACL intent (ruling 18; finding #16) ============
-- ACL RESTATEMENT ONLY — the column list and body below are byte-identical to
-- 20260818103051_acl_intent_phase31.sql's. `create or replace view` RETAINS an
-- existing view's ACL (finding #16 residue b), so prod's view still carries a
-- pre-existing hosted `anon` grant. Harmless in effect (security_invoker=true
-- means anon dies with 42501 on the underlying tables, proven by query in
-- session 10) but views were the one class outside Plan-6 ruling 1's 25-TABLE
-- scope, and the grant surface should state intent everywhere.
-- create or replace, SAME columns; security_invoker MUST be restated:
create or replace view public.account_balances
with (security_invoker = true) as
select
  a.id as account_id,
  a.user_id,
  a.starting_balance_sen
  + coalesce((select sum(t.amount_sen) from public.transactions t
      where t.account_id = a.id and t.type = 'income'), 0)
  - coalesce((select sum(t.amount_sen) from public.transactions t
      where t.account_id = a.id and t.type = 'expense'), 0)
  - coalesce((select sum(t.amount_sen) from public.transactions t
      where t.account_id = a.id and t.type = 'transfer'), 0)
  + coalesce((select sum(coalesce(t.received_sen, t.amount_sen)) from public.transactions t
      where t.transfer_account_id = a.id and t.type = 'transfer'), 0)
  + coalesce((select sum(r.amount_sen) from public.reimbursement_payments r
      where r.account_id = a.id), 0)
  - coalesce((select sum(t.cash_delta_sen) from public.trades t
      where t.account_id = a.id and t.side = 'buy'), 0)
  + coalesce((select sum(t.cash_delta_sen) from public.trades t
      where t.account_id = a.id and t.side = 'sell'), 0)
  - coalesce((select sum(e.amount_sen) from public.business_investment_entries e
      where e.account_id = a.id and e.kind = 'contribution'), 0)
  + coalesce((select sum(e.amount_sen) from public.business_investment_entries e
      where e.account_id = a.id and e.kind = 'return'), 0)
  as balance_sen
from public.accounts a;

revoke all on public.account_balances from public, anon, authenticated;
grant select on public.account_balances to authenticated;
grant all on public.account_balances to service_role;
