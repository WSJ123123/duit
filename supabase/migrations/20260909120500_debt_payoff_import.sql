-- Plan 8 Task 1: the whole of this plan's persistent state (ruling 19) —
-- `liabilities.planned_payment_sen` (the payoff plan's per-debt payment),
-- `import_batches` (one row per statement import, the unit undo acts on —
-- rulings 11 and 17), `transactions.import_batch_id` (the batch tag) and
-- `user_settings.import_mappings` (the saved column mappings, ruling 16;
-- the table's first jsonb column — zod validates its shape on read and
-- write, so no shape check lives in SQL).
--
-- Grants are explicit because migration-created tables get no automatic
-- API-role DML on this image (docs/findings.md #1). Least-privilege:
--   import_batches  select, insert, update — a batch is never deleted:
--                   `undone_at` is its archive (ruling 17), and its
--                   transactions reference it, so the history row stays.
-- service_role gets all and is never revoked anywhere in this file.
--
-- No `revoke ... from public, anon, authenticated` for the new table, and
-- none is needed: it was verified against the hosted database that
-- migration 11's `alter default privileges` pins HELD — the funds tables
-- arrived with exactly the grants their migration wrote and no `anon` entry
-- at all. The explicit grants below are therefore sufficient and
-- authoritative on hosted as well as local; a revoke would be harmless but
-- no longer states anything the grants do not.

-- ============ liabilities gain the planned payment ============
-- Defaulted, so every existing row stays valid.
alter table public.liabilities
  add column planned_payment_sen bigint not null default 0
    check (planned_payment_sen >= 0);

-- ============ import_batches (rulings 11, 17, 19) ============
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null,
  filename text not null check (char_length(filename) between 1 and 200),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  row_count int not null check (row_count >= 0),          -- no default: beginImport supplies it
  -- The three counters are written by the final chunk's summary (ruling 11).
  -- `imported_count` is deliberately NOT a column: it is derived on read as
  -- count(*) of the batch's transactions, never trusted from a stored value
  -- a dead request could leave stale.
  skipped_count int not null default 0 check (skipped_count >= 0),
  needs_review_count int not null default 0 check (needs_review_count >= 0),
  unparseable_count int not null default 0 check (unparseable_count >= 0),
  undone_at timestamptz,                                  -- set once by undo (ruling 17)
  created_at timestamptz not null default now(),
  foreign key (account_id, user_id) references public.accounts(id, user_id),
  unique (id, user_id)                                   -- composite-FK anchor
);
alter table public.import_batches enable row level security;
create policy import_batches_own on public.import_batches
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ transactions gain the batch tag (ruling 19) ============
-- Nullable with no default, so every existing row stays valid. The composite
-- FK keeps the tag inside the owner's own batches (FK checks bypass RLS).
alter table public.transactions
  add column import_batch_id uuid,
  add constraint transactions_import_batch_fk
    foreign key (import_batch_id, user_id) references public.import_batches(id, user_id);

-- ============ user_settings gain the saved mappings (ruling 16) ============
alter table public.user_settings
  add column import_mappings jsonb not null default '{}'::jsonb;

-- Indexes (session-7 convention: skip any whose unique constraint already
-- covers the leftmost prefix). Ruling 12(c)'s duplicate-file lookup index
-- also covers the plain per-user path by its leftmost prefix, so no separate
-- import_batches_user_idx is created. The batch tag is sparse, so its index
-- is partial.
create index import_batches_user_hash_idx
  on public.import_batches(user_id, account_id, content_sha256);
create index transactions_import_batch_idx
  on public.transactions(import_batch_id) where import_batch_id is not null;

grant select, insert, update on public.import_batches to authenticated;
grant all on public.import_batches to service_role;
