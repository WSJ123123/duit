create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;
-- service-role only: NO policies and NO grants to anon/authenticated (omission is the point)
grant all on public.rate_limits to service_role;

create or replace function public.bump_rate_limit(p_key text, p_window_start timestamptz)
returns int language sql security invoker as $$
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, p_window_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count;
$$;
revoke execute on function public.bump_rate_limit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, timestamptz) to service_role;
