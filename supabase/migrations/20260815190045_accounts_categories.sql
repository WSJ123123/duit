create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  type text not null check (type in ('bank','ewallet','cash','brokerage','epf','other')),
  currency char(3) not null default 'MYR',
  starting_balance_sen bigint not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
create policy accounts_own on public.accounts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  kind text not null check (kind in ('expense','income')),
  parent_id uuid references public.categories(id),
  tag text not null default 'wants' check (tag in ('needs','wants','savings')),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.categories enable row level security;
create policy categories_own on public.categories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create index categories_user_idx on public.categories(user_id);
create index accounts_user_idx on public.accounts(user_id);

-- Explicit grants: this Supabase image does not auto-grant DML on
-- postgres-created tables to API roles (see docs/findings.md). RLS still
-- scopes every row; grants are least-privilege (no DELETE — archive only).
grant select, insert, update on public.accounts to authenticated;
grant select, insert, update on public.categories to authenticated;
grant all on public.accounts, public.categories to service_role;

-- Seed the default Malaysian category tree for the CALLING user (idempotent).
create or replace function public.seed_default_categories()
returns void language plpgsql security invoker as $$
declare
  new_parent_id uuid;
  parent_row record;
begin
  if exists (select 1 from public.categories where user_id = auth.uid()) then
    return;
  end if;
  for parent_row in
    select * from (values
      ('Food','expense','needs', array['Groceries','Eating out','Delivery']),
      ('Transport','expense','needs', array['Petrol','Tolls','Parking','Grab']),
      ('Bills & utilities','expense','needs', array['Rent','Electricity','Water','Internet','Phone']),
      ('Shopping','expense','wants', array[]::text[]),
      ('Entertainment','expense','wants', array['Subscriptions']),
      ('Health','expense','needs', array[]::text[]),
      ('Family','expense','needs', array[]::text[]),
      ('Education','expense','needs', array[]::text[]),
      ('Travel','expense','wants', array[]::text[]),
      ('Zakat & donations','expense','needs', array[]::text[]),
      ('Salary','income','savings', array[]::text[]),
      ('Bonus','income','savings', array[]::text[]),
      ('Freelance','income','savings', array[]::text[]),
      ('Interest','income','savings', array[]::text[]),
      ('Dividends','income','savings', array[]::text[])
    ) as t(name, kind, tag, children)
  loop
    insert into public.categories (name, kind, tag)
      values (parent_row.name, parent_row.kind, parent_row.tag)
      returning id into new_parent_id;
    insert into public.categories (name, kind, tag, parent_id)
      select c, parent_row.kind, parent_row.tag, new_parent_id
      from unnest(parent_row.children) as c;
  end loop;
end $$;

grant execute on function public.seed_default_categories() to authenticated;
