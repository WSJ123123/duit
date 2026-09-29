create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  show_tips boolean not null default true,
  default_account_id uuid,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (default_account_id, user_id) references public.accounts(id, user_id)
);
alter table public.user_settings enable row level security;
create policy user_settings_own on public.user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Explicit grants: this Supabase image does not auto-grant DML on
-- postgres-created tables to API roles (see docs/findings.md #1). RLS still
-- scopes every row; grants are least-privilege (no DELETE — one row per user).
grant select, insert, update on public.user_settings to authenticated;
grant all on public.user_settings to service_role;
