create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null check (type in ('expense','income','transfer')),
  amount_sen bigint not null check (amount_sen > 0),
  account_id uuid not null references public.accounts(id),
  transfer_account_id uuid references public.accounts(id),
  category_id uuid references public.categories(id),
  date date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  note text not null default '',
  source text not null default 'manual'
    check (source in ('manual','nl','shortcut','recurring','import','reconcile')),
  needs_review boolean not null default false,
  expected_back_sen bigint not null default 0 check (expected_back_sen >= 0),
  recurring_rule_id uuid, -- FK added in the recurring migration
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'transfer' or transfer_account_id is not null),
  check (type = 'transfer' or transfer_account_id is null),
  check (type = 'expense' or expected_back_sen = 0),
  check (expected_back_sen <= amount_sen)
);
alter table public.transactions enable row level security;
create policy transactions_own on public.transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create index transactions_user_date_idx on public.transactions(user_id, date desc);

create table public.transaction_splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  category_id uuid not null references public.categories(id),
  amount_sen bigint not null check (amount_sen > 0)
);
alter table public.transaction_splits enable row level security;
-- with check also verifies ownership of the referenced transaction: FK checks
-- bypass RLS, so without this a user could attach rows to another user's
-- transaction (plan SQL fixed minimally; see PROGRESS.md note).
create policy splits_own on public.transaction_splits
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.user_id = auth.uid()
    )
  );
create index splits_tx_idx on public.transaction_splits(transaction_id);

create table public.reimbursement_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  account_id uuid not null references public.accounts(id),
  amount_sen bigint not null check (amount_sen > 0),
  date date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  note text not null default ''
);
alter table public.reimbursement_payments enable row level security;
-- same transaction-ownership check as splits_own (FK checks bypass RLS)
create policy reimb_own on public.reimbursement_payments
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.user_id = auth.uid()
    )
  );
create index reimb_tx_idx on public.reimbursement_payments(transaction_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- Explicit grants required on this Supabase image (docs/findings.md #1):
-- migration-created tables do not auto-grant DML to API roles.
-- Hard delete is allowed on these tables, so `delete` is granted.
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.transaction_splits to authenticated;
grant select, insert, update, delete on public.reimbursement_payments to authenticated;
grant all on public.transactions to service_role;
grant all on public.transaction_splits to service_role;
grant all on public.reimbursement_payments to service_role;
