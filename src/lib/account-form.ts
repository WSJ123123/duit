import { parseAmountToSen } from "@/lib/money";

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ACCOUNT_TYPES = ["bank", "ewallet", "cash", "brokerage", "epf", "other"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** Ruling 7 (owner-scoped decision 2026-08-18): the curated currency list a
 *  brokerage account may pick from. Every other account type is MYR. */
export const ACCOUNT_CURRENCIES = ["MYR", "USD", "SGD", "HKD", "GBP", "EUR", "AUD", "JPY"] as const;
export type AccountCurrency = (typeof ACCOUNT_CURRENCIES)[number];

export function isAccountCurrency(value: unknown): value is AccountCurrency {
  return typeof value === "string" && (ACCOUNT_CURRENCIES as readonly string[]).includes(value);
}

export interface AccountFormValue {
  name: string;
  type: AccountType;
  startingBalanceSen: number;
  currency: AccountCurrency;
}

export function parseAccountForm(input: {
  name?: unknown;
  type?: unknown;
  startingBalance?: unknown;
  currency?: unknown;
}): FormResult<AccountFormValue> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 60) {
    return { ok: false, error: "Name must be 1–60 characters." };
  }
  if (!isAccountType(input.type)) {
    return { ok: false, error: "Choose a valid account type." };
  }
  const currency = input.currency === undefined || input.currency === null ? "MYR" : input.currency;
  if (!isAccountCurrency(currency)) {
    return { ok: false, error: "Choose a currency from the list." };
  }
  if (currency !== "MYR" && input.type !== "brokerage") {
    return { ok: false, error: "Only brokerage accounts can hold a foreign currency." };
  }
  const startingBalanceSen =
    typeof input.startingBalance === "string" ? parseAmountToSen(input.startingBalance) : null;
  if (startingBalanceSen === null) {
    return { ok: false, error: "Enter a valid starting balance, e.g. 1234.56." };
  }
  return { ok: true, value: { name, type: input.type, startingBalanceSen, currency } };
}

export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_TAGS = ["needs", "wants", "savings"] as const;
export type CategoryTag = (typeof CATEGORY_TAGS)[number];
const DEFAULT_CATEGORY_TAG: CategoryTag = "wants";

function isCategoryKind(value: unknown): value is CategoryKind {
  return typeof value === "string" && (CATEGORY_KINDS as readonly string[]).includes(value);
}

function isCategoryTag(value: unknown): value is CategoryTag {
  return typeof value === "string" && (CATEGORY_TAGS as readonly string[]).includes(value);
}

export interface CategoryFormValue {
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  tag: CategoryTag;
}

export function parseCategoryForm(input: {
  name?: unknown;
  kind?: unknown;
  parentId?: unknown;
  tag?: unknown;
}): FormResult<CategoryFormValue> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 40) {
    return { ok: false, error: "Name must be 1–40 characters." };
  }
  if (!isCategoryKind(input.kind)) {
    return { ok: false, error: "Choose a valid category kind." };
  }
  const parentId =
    typeof input.parentId === "string" && input.parentId.length > 0 ? input.parentId : null;
  const tag = isCategoryTag(input.tag) ? input.tag : DEFAULT_CATEGORY_TAG;
  return { ok: true, value: { name, kind: input.kind, parentId, tag } };
}
