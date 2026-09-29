import { z } from "zod";
import { parseAmountToSen } from "@/lib/money";

export const RECURRING_TYPES = ["expense", "income", "transfer"] as const;
export type RecurringType = (typeof RECURRING_TYPES)[number];

export const RECURRING_FREQS = ["monthly", "weekly", "yearly"] as const;
export type RecurringFreq = (typeof RECURRING_FREQS)[number];

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Form-shaped input: everything arrives as strings (or absent) from FormData. */
export interface RecurringFormInput {
  name?: string;
  type?: string;
  amount?: string;
  variable?: boolean;
  accountId?: string;
  transferAccountId?: string;
  categoryId?: string;
  freq?: string;
  dayOfMonth?: string;
  weekday?: string;
  monthOfYear?: string;
}

/** Insertable/updatable `recurring_rules` row shape (minus id/user_id/next_run/active). */
export interface RecurringRuleValue {
  name: string;
  type: RecurringType;
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  freq: RecurringFreq;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
}

export type RecurringValidationResult =
  | { ok: true; value: RecurringRuleValue }
  | { ok: false; error: string };

const formSchema = z.object({
  name: z.string(),
  type: z.enum(RECURRING_TYPES),
  amount: z.string(),
  variable: z.boolean().optional(),
  accountId: z.string().min(1),
  transferAccountId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  freq: z.enum(RECURRING_FREQS),
  dayOfMonth: z.string().optional(),
  weekday: z.string().optional(),
  monthOfYear: z.string().optional(),
});

function parseIntField(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < min || n > max) return null;
  return n;
}

/**
 * Pure validation for the recurring-rule form. Mirrors the `recurring_rules`
 * check constraints (20260815191612_recurring_aliases_tokens.sql) and the
 * transfer semantics in `src/lib/transactions.ts`.
 *
 * Schema reality note: `amount_sen` is `not null check (> 0)` — there is no
 * nullable-amount path for variable rules. `variable` only changes what
 * happens at materialization time (the posted entry comes out
 * `needs_review: true` — see `materializeDueRules`); the rule itself always
 * carries a concrete amount, used as the best-guess/last-known figure.
 */
export function validateRecurringInput(input: RecurringFormInput): RecurringValidationResult {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? first.message : "invalid recurring rule input" };
  }
  const v = parsed.data;

  const name = v.name.trim();
  if (name.length < 1 || name.length > 60) {
    return { ok: false, error: "Name must be 1–60 characters." };
  }

  const amountSen = parseAmountToSen(v.amount);
  if (amountSen === null || amountSen <= 0) {
    return { ok: false, error: "amount must be a positive ringgit amount like 12.34" };
  }

  let transferAccountId: string | null = null;
  let categoryId = v.categoryId ?? null;
  if (v.type === "transfer") {
    if (!v.transferAccountId) {
      return { ok: false, error: "transfer requires a destination account" };
    }
    if (v.transferAccountId === v.accountId) {
      return { ok: false, error: "transfer destination must differ from source" };
    }
    // Transfers are never income/expense: no category (mirrors src/lib/transactions.ts).
    if (v.categoryId !== undefined) {
      return { ok: false, error: "transfers cannot have a category" };
    }
    transferAccountId = v.transferAccountId;
    categoryId = null;
  } else if (v.transferAccountId !== undefined) {
    return { ok: false, error: "only transfers can have a destination account" };
  }

  let dayOfMonth: number | null = null;
  let weekday: number | null = null;
  let monthOfYear: number | null = null;

  if (v.freq === "monthly") {
    dayOfMonth = parseIntField(v.dayOfMonth, 1, 31);
    if (dayOfMonth === null) {
      return { ok: false, error: "monthly rules need a day of month (1–31)" };
    }
  } else if (v.freq === "weekly") {
    weekday = parseIntField(v.weekday, 0, 6);
    if (weekday === null) {
      return { ok: false, error: "weekly rules need a weekday (0–6)" };
    }
  } else {
    dayOfMonth = parseIntField(v.dayOfMonth, 1, 31);
    monthOfYear = parseIntField(v.monthOfYear, 1, 12);
    if (dayOfMonth === null || monthOfYear === null) {
      return { ok: false, error: "yearly rules need both a day of month and a month" };
    }
  }

  return {
    ok: true,
    value: {
      name,
      type: v.type,
      amount_sen: amountSen,
      variable: v.variable ?? false,
      account_id: v.accountId,
      transfer_account_id: transferAccountId,
      category_id: categoryId,
      freq: v.freq,
      day_of_month: dayOfMonth,
      weekday,
      month_of_year: monthOfYear,
    },
  };
}

/** Short cadence phrase for list rows, e.g. "monthly · day 28", "yearly · 15 Aug". */
export function describeCadence(rule: {
  freq: RecurringFreq;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
}): string {
  switch (rule.freq) {
    case "monthly":
      return `monthly · day ${rule.day_of_month}`;
    case "weekly":
      return `weekly · ${WEEKDAY_LABELS[rule.weekday ?? 0]}`;
    case "yearly":
      return `yearly · ${rule.day_of_month} ${MONTH_LABELS[(rule.month_of_year ?? 1) - 1]}`;
  }
}
