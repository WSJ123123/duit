-- Plan 4 Task 1: hybrid budgeting schema — monthly envelope (budget_months),
-- per-category envelopes (budget_allocations), append-only change log
-- (budget_changes), atomic move function, and 50/30/20 benchmark settings.

create table public.budget_months (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),  -- first-of-month
  expected_income_sen bigint not null default 0 check (expected_income_sen >= 0),
  savings_planned_sen bigint not null default 0 check (savings_planned_sen >= 0),
  savings_allocated_sen bigint not null default 0 check (savings_allocated_sen >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, month)
);
alter table public.budget_months enable row level security;
create policy budget_months_own on public.budget_months
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.budget_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  category_id uuid not null,
  planned_sen bigint not null default 0 check (planned_sen >= 0),
  allocated_sen bigint not null default 0 check (allocated_sen >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, month, category_id),
  foreign key (category_id, user_id) references public.categories(id, user_id)
);
alter table public.budget_allocations enable row level security;
create policy budget_allocations_own on public.budget_allocations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.budget_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  category_id uuid,               -- null = the savings row
  from_sen bigint not null check (from_sen >= 0),
  to_sen bigint not null check (to_sen >= 0),
  changed_at timestamptz not null default now(),
  foreign key (category_id, user_id) references public.categories(id, user_id)
);
alter table public.budget_changes enable row level security;
create policy budget_changes_own on public.budget_changes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Indexes: the unique constraints on budget_months (user_id, month) and
-- budget_allocations (user_id, month, category_id) already index the
-- (user_id, month) access path; only budget_changes needs its own.
create index budget_changes_user_month_idx on public.budget_changes(user_id, month);

-- Explicit grants: this Supabase image does not auto-grant DML on
-- postgres-created tables to API roles (see docs/findings.md #1). RLS still
-- scopes every row; grants are least-privilege: allocations/months are edited
-- but never hard-deleted (no DELETE); budget_changes is an append-only log
-- (no UPDATE/DELETE).
grant select, insert, update on public.budget_months to authenticated;
grant select, insert, update on public.budget_allocations to authenticated;
grant select, insert on public.budget_changes to authenticated;
grant all on public.budget_months, public.budget_allocations, public.budget_changes to service_role;

-- 50/30/20 benchmark split (savings derived so the three always sum to 100).
alter table public.user_settings
  add column benchmark_needs_pct int not null default 50 check (benchmark_needs_pct between 0 and 100),
  add column benchmark_wants_pct int not null default 30 check (benchmark_wants_pct between 0 and 100),
  add column benchmark_savings_pct int generated always as (100 - benchmark_needs_pct - benchmark_wants_pct) stored,
  add constraint benchmark_sums check (benchmark_needs_pct + benchmark_wants_pct <= 100);

-- Atomically move p_amount_sen between two envelopes of the CALLING user's
-- month. NULL category = the savings envelope on budget_months. Writes one
-- budget_changes row per touched envelope (old value -> new value). security
-- invoker so RLS scopes every statement; the >= 0 checks make overdraw raise
-- and roll the whole move back.
create or replace function public.move_budget_allocation(
  p_month date, p_from_category uuid, p_to_category uuid, p_amount_sen bigint
) returns void language plpgsql security invoker as $$
declare
  v_from_old bigint;
  v_to_old bigint;
begin
  if p_amount_sen <= 0 then
    raise exception 'move amount must be positive, got %', p_amount_sen;
  end if;

  if p_from_category is null then
    update public.budget_months
      set savings_allocated_sen = savings_allocated_sen - p_amount_sen
      where user_id = auth.uid() and month = p_month
      returning savings_allocated_sen + p_amount_sen into v_from_old;
  else
    update public.budget_allocations
      set allocated_sen = allocated_sen - p_amount_sen
      where user_id = auth.uid() and month = p_month and category_id = p_from_category
      returning allocated_sen + p_amount_sen into v_from_old;
  end if;
  if v_from_old is null then
    raise exception 'from-side budget row not found for month %', p_month;
  end if;

  if p_to_category is null then
    update public.budget_months
      set savings_allocated_sen = savings_allocated_sen + p_amount_sen
      where user_id = auth.uid() and month = p_month
      returning savings_allocated_sen - p_amount_sen into v_to_old;
  else
    update public.budget_allocations
      set allocated_sen = allocated_sen + p_amount_sen
      where user_id = auth.uid() and month = p_month and category_id = p_to_category
      returning allocated_sen - p_amount_sen into v_to_old;
  end if;
  if v_to_old is null then
    raise exception 'to-side budget row not found for month %', p_month;
  end if;

  insert into public.budget_changes (month, category_id, from_sen, to_sen) values
    (p_month, p_from_category, v_from_old, v_from_old - p_amount_sen),
    (p_month, p_to_category, v_to_old, v_to_old + p_amount_sen);
end $$;

grant execute on function public.move_budget_allocation(date, uuid, uuid, bigint) to authenticated;
