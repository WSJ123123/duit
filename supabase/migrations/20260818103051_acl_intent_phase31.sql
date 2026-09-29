-- ============ ACL intent restatement (Plan 6 ruling 1; findings #1, #11, #12) ============
-- Hosted default privileges (finding #12) grant FULL DML on every
-- migration-created table to anon/authenticated, so prod's grant layer never
-- stated least-privilege intent. This migration restates it: per-table
-- revoke + verbatim re-grant of each table's original least-privilege set
-- (finding-#1 discipline), then pins future defaults. RLS is and remains the
-- effective gate; locally the revokes are no-ops (finding #1: no grants
-- existed beyond our explicit ones). service_role is never revoked.
--
-- The 25 public tables (compiled from supabase/migrations/*):
--  1. accounts                     select, insert, update
--  2. categories                   select, insert, update
--  3. transactions                 select, insert, update, delete
--  4. transaction_splits           select, insert, update, delete
--  5. reimbursement_payments       select, insert, update, delete
--  6. recurring_rules              select, insert, update
--  7. parser_aliases               select, insert, update, delete
--  8. api_tokens                   select, insert, update
--  9. rate_limits                  (none: service-role only)
-- 10. user_settings                select, insert, update
-- 11. budget_months                select, insert, update
-- 12. budget_allocations           select, insert, update
-- 13. budget_changes               select, insert
-- 14. holdings                     select, insert, update, delete (delete NEW: ruling 5)
-- 15. trades                       select, insert, update, delete
-- 16. manual_assets                select, insert, update
-- 17. manual_asset_values          select, insert, update, delete
-- 18. liabilities                  select, insert, update
-- 19. liability_values             select, insert, update, delete
-- 20. business_investments         select, insert, update
-- 21. business_investment_entries  select, insert, update, delete
-- 22. prices                       select
-- 23. fx_rates                     select
-- 24. net_worth_snapshots          select
-- 25. allocation_presets           select, insert, update

revoke all on public.accounts from public, anon, authenticated;
grant select, insert, update on public.accounts to authenticated;

revoke all on public.categories from public, anon, authenticated;
grant select, insert, update on public.categories to authenticated;

revoke all on public.transactions from public, anon, authenticated;
grant select, insert, update, delete on public.transactions to authenticated;

revoke all on public.transaction_splits from public, anon, authenticated;
grant select, insert, update, delete on public.transaction_splits to authenticated;

revoke all on public.reimbursement_payments from public, anon, authenticated;
grant select, insert, update, delete on public.reimbursement_payments to authenticated;

revoke all on public.recurring_rules from public, anon, authenticated;
grant select, insert, update on public.recurring_rules to authenticated;

revoke all on public.parser_aliases from public, anon, authenticated;
grant select, insert, update, delete on public.parser_aliases to authenticated;

revoke all on public.api_tokens from public, anon, authenticated;
grant select, insert, update on public.api_tokens to authenticated;

revoke all on public.rate_limits from public, anon, authenticated;
-- no re-grant: service-role only (omission is the point)

revoke all on public.user_settings from public, anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;

revoke all on public.budget_months from public, anon, authenticated;
grant select, insert, update on public.budget_months to authenticated;

revoke all on public.budget_allocations from public, anon, authenticated;
grant select, insert, update on public.budget_allocations to authenticated;

revoke all on public.budget_changes from public, anon, authenticated;
grant select, insert on public.budget_changes to authenticated;

-- holdings: DELETE is the plan's ONE intentional grant change (ruling 5:
-- Task 3 ships zero-trade hard-delete). Everything else is verbatim.
revoke all on public.holdings from public, anon, authenticated;
grant select, insert, update, delete on public.holdings to authenticated;

revoke all on public.trades from public, anon, authenticated;
grant select, insert, update, delete on public.trades to authenticated;

revoke all on public.manual_assets from public, anon, authenticated;
grant select, insert, update on public.manual_assets to authenticated;

revoke all on public.manual_asset_values from public, anon, authenticated;
grant select, insert, update, delete on public.manual_asset_values to authenticated;

revoke all on public.liabilities from public, anon, authenticated;
grant select, insert, update on public.liabilities to authenticated;

revoke all on public.liability_values from public, anon, authenticated;
grant select, insert, update, delete on public.liability_values to authenticated;

revoke all on public.business_investments from public, anon, authenticated;
grant select, insert, update on public.business_investments to authenticated;

revoke all on public.business_investment_entries from public, anon, authenticated;
grant select, insert, update, delete on public.business_investment_entries to authenticated;

revoke all on public.prices from public, anon, authenticated;
grant select on public.prices to authenticated;

revoke all on public.fx_rates from public, anon, authenticated;
grant select on public.fx_rates to authenticated;

revoke all on public.net_worth_snapshots from public, anon, authenticated;
grant select on public.net_worth_snapshots to authenticated;

revoke all on public.allocation_presets from public, anon, authenticated;
grant select, insert, update on public.allocation_presets to authenticated;

-- ============ pin future default privileges (role postgres owns migration objects) ============
-- Hosted pg_default_acl for role postgres carries broad r/f/S grants for
-- anon/authenticated (findings #11/#12 evidence, re-verified 2026-08-18).
-- After these pins, new migration-created objects start with no API-role
-- grants — every migration states its own (finding-#1 discipline everywhere).
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- ============ phase-3.1 columns ============
-- Holdings list display currency toggle (Task 5 UI).
alter table public.user_settings add column holdings_display text not null default 'myr'
  check (holdings_display in ('myr','native'));

-- FX transfers (ruling 7): single-row transfer gains an optional destination
-- amount. null = same-currency; the destination receives amount_sen.
alter table public.transactions add column received_sen bigint
  check (received_sen >= 0);

-- ============ balances view: incoming transfers credit coalesce(received_sen, amount_sen) ============
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
