-- Plan 5 Task 1: Phase-3 net-worth & investments schema — market holdings +
-- trades, manual assets/liabilities with value histories, business
-- investments (ruling 20), global price/FX reference data (ruling 7), net
-- worth snapshots (ruling 8), allocation plan (rulings 12-13), balances view
-- gains trade + business cash-flow terms (rulings 3, 20), and the Plan-1
-- function ACL revokes (finding #11).

-- ============ market holdings & trades ============
create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null check (char_length(symbol) between 1 and 20),
  name text not null default '' check (char_length(name) <= 60),
  kind text not null check (kind in ('stock','etf','crypto')),
  currency char(3) not null default 'MYR',
  price_source text not null default 'auto' check (price_source in ('auto','manual')),
  manual_price_e8 bigint check (manual_price_e8 > 0),
  target_pct int check (target_pct between 0 and 100),   -- equities-split target, ruling 15
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  check (price_source <> 'manual' or manual_price_e8 is not null),
  unique (user_id, symbol),
  unique (id, user_id)                                   -- composite-FK anchor
);
alter table public.holdings enable row level security;
create policy holdings_own on public.holdings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.trades (
  id uuid primary key default gen_random_uuid(),         -- client-generated (rule 14)
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  holding_id uuid not null,
  account_id uuid not null,                              -- linked brokerage cash account
  side text not null check (side in ('buy','sell')),
  date date not null,
  quantity_e8 bigint not null check (quantity_e8 > 0),
  price_e8 bigint not null check (price_e8 >= 0),        -- per unit, HOLDING currency
  fees_cent bigint not null default 0 check (fees_cent >= 0),  -- HOLDING currency minor units
  cash_delta_sen bigint not null check (cash_delta_sen >= 0),  -- ACCOUNT currency (ruling 3)
  note text not null default '',
  created_at timestamptz not null default now(),
  foreign key (holding_id, user_id) references public.holdings(id, user_id),
  foreign key (account_id, user_id) references public.accounts(id, user_id)
);
alter table public.trades enable row level security;
create policy trades_own on public.trades
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ manual assets & liabilities (+ value histories) ============
create table public.manual_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null check (kind in ('epf','fd','property','vehicle','other')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.manual_assets enable row level security;
create policy manual_assets_own on public.manual_assets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.manual_asset_values (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_id uuid not null,
  value_sen bigint not null check (value_sen >= 0),
  noted_on date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  created_at timestamptz not null default now(),
  foreign key (asset_id, user_id) references public.manual_assets(id, user_id),
  unique (user_id, asset_id, noted_on)                   -- one value per day; same-day set = upsert
);
alter table public.manual_asset_values enable row level security;
create policy manual_asset_values_own on public.manual_asset_values
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.liabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null check (kind in ('loan','credit_card','ptptn','other')),
  interest_rate_bp int not null default 0 check (interest_rate_bp between 0 and 10000),
  minimum_payment_sen bigint not null default 0 check (minimum_payment_sen >= 0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.liabilities enable row level security;
create policy liabilities_own on public.liabilities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.liability_values (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  liability_id uuid not null,
  balance_sen bigint not null check (balance_sen >= 0),
  noted_on date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  created_at timestamptz not null default now(),
  foreign key (liability_id, user_id) references public.liabilities(id, user_id),
  unique (user_id, liability_id, noted_on)
);
alter table public.liability_values enable row level security;
create policy liability_values_own on public.liability_values
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ business investments (ruling 20; spec rev 10) ============
create table public.business_investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  note text not null default '',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.business_investments enable row level security;
create policy business_investments_own on public.business_investments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.business_investment_entries (
  id uuid primary key default gen_random_uuid(),         -- client-generated (rule 14)
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  business_id uuid not null,
  kind text not null check (kind in ('contribution','return','valuation')),
  amount_sen bigint not null check (amount_sen >= 0),    -- valuation: the marked value
  account_id uuid,                                       -- required for cash kinds only
  date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  check (kind = 'valuation' or account_id is not null),
  check (kind <> 'valuation' or account_id is null),
  foreign key (business_id, user_id) references public.business_investments(id, user_id),
  foreign key (account_id, user_id) references public.accounts(id, user_id)
);
alter table public.business_investment_entries enable row level security;
create policy business_investment_entries_own on public.business_investment_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ global market reference data (ruling 7) ============
create table public.prices (
  symbol text primary key check (char_length(symbol) between 1 and 20),
  currency char(3) not null,
  price_e8 bigint not null check (price_e8 > 0),
  as_of date not null,
  fetched_at timestamptz not null default now(),
  source text not null
);
alter table public.prices enable row level security;
create policy prices_read on public.prices for select using (true);

create table public.fx_rates (
  pair char(6) primary key,                              -- e.g. 'USDMYR'
  rate_e8 bigint not null check (rate_e8 > 0),
  as_of date not null,
  fetched_at timestamptz not null default now(),
  source text not null
);
alter table public.fx_rates enable row level security;
create policy fx_rates_read on public.fx_rates for select using (true);

-- ============ net worth snapshots (ruling 8) ============
create table public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,  -- written by service role: NO auth.uid() default
  date date not null,
  accounts_sen bigint not null,                          -- may be negative (overdraft)
  holdings_sen bigint not null check (holdings_sen >= 0),
  business_sen bigint not null check (business_sen >= 0),
  manual_assets_sen bigint not null check (manual_assets_sen >= 0),
  liabilities_sen bigint not null check (liabilities_sen >= 0),  -- stored positive
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
alter table public.net_worth_snapshots enable row level security;
create policy net_worth_snapshots_read on public.net_worth_snapshots
  for select using (user_id = auth.uid());

-- ============ allocation plan (rulings 12-13) ============
create table public.allocation_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null check (key in ('balanced','growth','aggressive','barbell')),
  bank_pct int not null check (bank_pct between 0 and 100),
  cashlike_pct int not null check (cashlike_pct between 0 and 100),
  equities_pct int not null check (equities_pct between 0 and 100),
  created_at timestamptz not null default now(),
  check (bank_pct + cashlike_pct + equities_pct = 100),
  unique (user_id, key)
);
alter table public.allocation_presets enable row level security;
create policy allocation_presets_own on public.allocation_presets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.accounts
  add column allocation_bucket text check (allocation_bucket in ('bank','cashlike','equities','exclude'));
alter table public.user_settings
  add column allocation_preset text check (allocation_preset in ('balanced','growth','aggressive','barbell')),
  add column target_etf_pct int not null default 70 check (target_etf_pct between 0 and 100);

-- Indexes (session-7 convention: skip any whose unique constraint already
-- covers the leftmost prefix — holdings (user_id, symbol), manual/liability
-- values (user_id, item, noted_on), allocation_presets (user_id, key),
-- net_worth_snapshots (user_id, date) are all covered).
create index trades_user_date_idx on public.trades(user_id, date);
create index manual_assets_user_idx on public.manual_assets(user_id);
create index liabilities_user_idx on public.liabilities(user_id);
create index business_investments_user_idx on public.business_investments(user_id);
create index business_investment_entries_user_idx on public.business_investment_entries(user_id);

-- Explicit grants: this Supabase image does not auto-grant DML on
-- postgres-created tables to API roles (see docs/findings.md #1). RLS still
-- scopes every row; grants are least-privilege: catalog-style tables are
-- archive-only (no DELETE); trade/value/entry rows are hard-deletable
-- (rulings 4/5/20); snapshots and market reference data are read-only for
-- the API (service-role/cron writes them).
grant select, insert, update on public.holdings to authenticated;
grant select, insert, update on public.manual_assets to authenticated;
grant select, insert, update on public.liabilities to authenticated;
grant select, insert, update on public.business_investments to authenticated;
grant select, insert, update on public.allocation_presets to authenticated;
grant select, insert, update, delete on public.trades to authenticated;
grant select, insert, update, delete on public.manual_asset_values to authenticated;
grant select, insert, update, delete on public.liability_values to authenticated;
grant select, insert, update, delete on public.business_investment_entries to authenticated;
grant select on public.net_worth_snapshots to authenticated;
grant select on public.prices to authenticated;
grant select on public.fx_rates to authenticated;
grant all on public.holdings, public.trades, public.manual_assets,
  public.manual_asset_values, public.liabilities, public.liability_values,
  public.business_investments, public.business_investment_entries,
  public.prices, public.fx_rates, public.net_worth_snapshots,
  public.allocation_presets to service_role;

-- ============ balances view gains trade + business cash flow (rulings 3, 20) ============
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
  + coalesce((select sum(t.amount_sen) from public.transactions t
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

-- ============ finding #11 — Plan-1 function ACLs state their intent (header ruling) ============
-- seed_default_categories: signed-in users call it (onboarding) — keep authenticated.
revoke execute on function public.seed_default_categories() from public, anon;
-- touch_updated_at: trigger-only; nothing calls it via the API. Full revoke is safe:
-- PostgreSQL checks EXECUTE on a trigger function at trigger CREATION time (as the
-- creating/owning role), not at fire time — existing triggers keep firing.
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
