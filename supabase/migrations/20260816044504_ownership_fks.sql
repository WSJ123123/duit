-- Ownership integrity: composite FKs so every cross-user reference column
-- (account_id, transfer_account_id, category_id, transaction_id,
-- recurring_rule_id, parent_id) can only reference rows owned by the same
-- user_id. FK checks bypass RLS, so this is the DB-level guarantee; the
-- existing T4/T5 `with check` policies stay as defense-in-depth.

-- anchors: (id, user_id) must be unique on every referenced table
alter table public.accounts        add constraint accounts_id_user_key        unique (id, user_id);
alter table public.categories      add constraint categories_id_user_key      unique (id, user_id);
alter table public.transactions    add constraint transactions_id_user_key    unique (id, user_id);
alter table public.recurring_rules add constraint recurring_rules_id_user_key unique (id, user_id);

-- transactions → accounts / categories / recurring_rules
alter table public.transactions
  drop constraint transactions_account_id_fkey,
  add  constraint transactions_account_id_fkey
    foreign key (account_id, user_id) references public.accounts(id, user_id),
  drop constraint transactions_transfer_account_id_fkey,
  add  constraint transactions_transfer_account_id_fkey
    foreign key (transfer_account_id, user_id) references public.accounts(id, user_id),
  drop constraint transactions_category_id_fkey,
  add  constraint transactions_category_id_fkey
    foreign key (category_id, user_id) references public.categories(id, user_id),
  drop constraint transactions_recurring_fk,
  add  constraint transactions_recurring_fk
    foreign key (recurring_rule_id, user_id) references public.recurring_rules(id, user_id)
    on delete set null (recurring_rule_id);

-- categories self-reference (parent must be own)
alter table public.categories
  drop constraint categories_parent_id_fkey,
  add  constraint categories_parent_id_fkey
    foreign key (parent_id, user_id) references public.categories(id, user_id);

-- splits → transactions / categories
alter table public.transaction_splits
  drop constraint transaction_splits_transaction_id_fkey,
  add  constraint transaction_splits_transaction_id_fkey
    foreign key (transaction_id, user_id) references public.transactions(id, user_id) on delete cascade,
  drop constraint transaction_splits_category_id_fkey,
  add  constraint transaction_splits_category_id_fkey
    foreign key (category_id, user_id) references public.categories(id, user_id);

-- reimbursement payments → transactions / accounts
alter table public.reimbursement_payments
  drop constraint reimbursement_payments_transaction_id_fkey,
  add  constraint reimbursement_payments_transaction_id_fkey
    foreign key (transaction_id, user_id) references public.transactions(id, user_id) on delete cascade,
  drop constraint reimbursement_payments_account_id_fkey,
  add  constraint reimbursement_payments_account_id_fkey
    foreign key (account_id, user_id) references public.accounts(id, user_id);

-- recurring rules → accounts / categories
alter table public.recurring_rules
  drop constraint recurring_rules_account_id_fkey,
  add  constraint recurring_rules_account_id_fkey
    foreign key (account_id, user_id) references public.accounts(id, user_id),
  drop constraint recurring_rules_transfer_account_id_fkey,
  add  constraint recurring_rules_transfer_account_id_fkey
    foreign key (transfer_account_id, user_id) references public.accounts(id, user_id),
  drop constraint recurring_rules_category_id_fkey,
  add  constraint recurring_rules_category_id_fkey
    foreign key (category_id, user_id) references public.categories(id, user_id);

-- parser aliases → categories / accounts
alter table public.parser_aliases
  drop constraint parser_aliases_category_id_fkey,
  add  constraint parser_aliases_category_id_fkey
    foreign key (category_id, user_id) references public.categories(id, user_id),
  drop constraint parser_aliases_account_id_fkey,
  add  constraint parser_aliases_account_id_fkey
    foreign key (account_id, user_id) references public.accounts(id, user_id);
