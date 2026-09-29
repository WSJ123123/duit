create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('expense','income','transfer')),
  amount_sen bigint not null check (amount_sen > 0),
  variable boolean not null default false,
  account_id uuid not null references public.accounts(id),
  transfer_account_id uuid references public.accounts(id),
  category_id uuid references public.categories(id),
  freq text not null check (freq in ('monthly','weekly','yearly')),
  day_of_month int check (day_of_month between 1 and 31),
  weekday int check (weekday between 0 and 6),
  month_of_year int check (month_of_year between 1 and 12),
  next_run date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (freq <> 'monthly' or day_of_month is not null),
  check (freq <> 'weekly' or weekday is not null),
  check (freq <> 'yearly' or (day_of_month is not null and month_of_year is not null))
);
alter table public.recurring_rules enable row level security;
create policy recurring_own on public.recurring_rules
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.transactions
  add constraint transactions_recurring_fk
  foreign key (recurring_rule_id) references public.recurring_rules(id) on delete set null;

create table public.parser_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  phrase text not null,
  category_id uuid references public.categories(id),
  account_id uuid references public.accounts(id),
  unique (user_id, phrase)
);
alter table public.parser_aliases enable row level security;
create policy aliases_own on public.parser_aliases
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'iOS Shortcut',
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);
alter table public.api_tokens enable row level security;
create policy tokens_own on public.api_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Explicit grants required on this Supabase image (docs/findings.md #1):
-- migration-created tables do not auto-grant DML to API roles.
-- Least privilege per table:
--   recurring_rules: soft-delete only (archive) -> no delete grant
--   parser_aliases: not referenced by history -> hard delete OK
--   api_tokens: revoke = update `revoked`, keep audit trail -> no delete grant
grant select, insert, update on public.recurring_rules to authenticated;
grant select, insert, update, delete on public.parser_aliases to authenticated;
grant select, insert, update on public.api_tokens to authenticated;
grant all on public.recurring_rules to service_role;
grant all on public.parser_aliases to service_role;
grant all on public.api_tokens to service_role;
