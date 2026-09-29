-- Plan 4 Task 9 hardening (owner-approved): Supabase default privileges
-- auto-grant EXECUTE on new public functions to PUBLIC/anon/authenticated.
-- move_budget_allocation is for signed-in users only (security invoker; RLS
-- and table grants already block anon) — align the ACL with intent, matching
-- the bump_rate_limit convention. Plan-1 functions left as-is (architect Q).
revoke execute on function public.move_budget_allocation(date, uuid, uuid, bigint) from public, anon;
