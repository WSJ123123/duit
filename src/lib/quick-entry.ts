import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadParserContext } from "@/db/parser-context";
import { parseEntry } from "@/lib/parser/parse";
import { formatSen } from "@/lib/money";

/**
 * Core of POST /api/quick-entry: parse one shortcut entry and insert exactly
 * one transaction for the token's owner. Runs on the service-role client, so
 * every query here filters by user_id explicitly — that discipline (already
 * enforced inside loadParserContext) is the only tenant guard on this path.
 * Idempotent: retrying with the same clientId never creates a second row.
 */

export type QuickEntryResult =
  | { ok: true; status: 200; message: string; transaction_id: string; needs_review: boolean }
  | { ok: false; status: 422; error: "no_amount" }
  | { ok: false; status: 422; error: "no_account" };

type InsertedShape = {
  id: string;
  amount_sen: number;
  account_id: string;
  category_id: string | null;
  needs_review: boolean;
};

export async function performQuickEntry(
  admin: SupabaseClient,
  args: { userId: string; text: string; clientId?: string; todayIso: string },
): Promise<QuickEntryResult> {
  const ctx = await loadParserContext(admin, args.userId);
  const parsed = parseEntry(args.text, ctx);
  if (parsed.amount_sen === null) return { ok: false, status: 422, error: "no_amount" };

  // Account: parsed match -> default (parseEntry already fell back) -> first
  // unarchived MYR account (oldest created_at, id as tiebreak) -> none = 422.
  // Ruling 7 (Task 5): quick entries are income/expense, so the resolved
  // account must be in the MYR-only parser vocabulary (ctx.accounts). An
  // alias or stale default aimed at a non-MYR account reroutes to the
  // fallback and flags the row for review — never dropped (rule 15), never
  // denominated into a foreign-currency book.
  let accountId = parsed.account_id;
  let foreignReroute = false;
  if (accountId !== null) {
    const cur = await admin
      .from("accounts")
      .select("currency")
      .eq("user_id", args.userId)
      .eq("id", accountId)
      .maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (cur.data && (cur.data.currency as string) !== "MYR") {
      accountId = null;
      foreignReroute = true;
    }
  }
  if (accountId === null) {
    const { data: first, error: firstErr } = await admin
      .from("accounts")
      .select("id")
      .eq("user_id", args.userId)
      .eq("archived", false)
      .eq("currency", "MYR")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstErr) throw new Error(firstErr.message);
    if (!first) return { ok: false, status: 422, error: "no_account" };
    accountId = first.id as string;
  }

  const id = args.clientId ?? randomUUID();
  const row = {
    id,
    user_id: args.userId,
    type: parsed.type,
    amount_sen: parsed.amount_sen,
    account_id: accountId,
    category_id: parsed.category_id,
    date: args.todayIso,
    note: args.text,
    source: "shortcut",
    needs_review: !parsed.confident || foreignReroute,
  };

  const { error } = await admin.from("transactions").insert(row);
  if (error === null) {
    return {
      ok: true,
      status: 200,
      message: await buildMessage(admin, ctx, args.userId, row),
      transaction_id: id,
      needs_review: row.needs_review,
    };
  }
  if (error.code !== "23505") throw new Error(error.message);

  // Idempotent retry: the row already exists — re-read it (user-scoped, so a
  // cross-user id collision reads nothing and throws instead of leaking).
  const { data: existing, error: readErr } = await admin
    .from("transactions")
    .select("id, amount_sen, account_id, category_id, needs_review")
    .eq("id", id)
    .eq("user_id", args.userId)
    .single();
  if (readErr) throw new Error(readErr.message);
  const found = existing as InsertedShape;
  return {
    ok: true,
    status: 200,
    message: await buildMessage(admin, ctx, args.userId, found),
    transaction_id: found.id,
    needs_review: found.needs_review,
  };
}

async function buildMessage(
  admin: SupabaseClient,
  ctx: Awaited<ReturnType<typeof loadParserContext>>,
  userId: string,
  row: Pick<InsertedShape, "amount_sen" | "account_id" | "category_id" | "needs_review">,
): Promise<string> {
  if (row.needs_review || row.category_id === null) {
    return `Saved for review · ${formatSen(row.amount_sen)}`;
  }
  const categoryName =
    ctx.categories.find((c) => c.id === row.category_id)?.name ??
    (await fetchName(admin, "categories", userId, row.category_id));
  const accountName =
    ctx.accounts.find((a) => a.id === row.account_id)?.name ??
    (await fetchName(admin, "accounts", userId, row.account_id));
  return `✓ ${formatSen(row.amount_sen)} · ${categoryName} · ${accountName}`;
}

/** Name lookup for rows no longer in the parser context (e.g. archived since). */
async function fetchName(
  admin: SupabaseClient,
  table: "accounts" | "categories",
  userId: string,
  id: string,
): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .select("name")
    .eq("user_id", userId)
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return (data as { name: string }).name;
}
