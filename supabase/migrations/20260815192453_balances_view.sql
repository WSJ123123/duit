create view public.account_balances
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
  as balance_sen
from public.accounts a;

grant select on public.account_balances to authenticated, service_role;
