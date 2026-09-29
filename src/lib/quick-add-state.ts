// Pure helpers for the Quick Add screen (/quick). No clock, network, or
// randomness — everything here is a deterministic function of its inputs so
// it can run identically for the live client-side preview and in tests.
import { formatSen, parseAmountToSen } from "@/lib/money";
import type { ParsedEntry, ParserContext } from "@/lib/parser/parse";

/**
 * The one-line live preview shown under the NL field:
 *  - no amount yet            -> "Type an amount…"
 *  - amount, no category      -> "RM 18.00 · needs review · <account name>"
 *  - amount + category (confident) -> "RM 18.00 · Grab · TnG eWallet"
 */
export function previewLine(parsed: ParsedEntry, ctx: ParserContext): string {
  if (parsed.amount_sen === null) return "Type an amount…";
  const amountStr = formatSen(parsed.amount_sen);
  const accountName = ctx.accounts.find((a) => a.id === parsed.account_id)?.name ?? "no account";

  if (!parsed.confident) {
    return `${amountStr} · needs review · ${accountName}`;
  }
  const categoryName = ctx.categories.find((c) => c.id === parsed.category_id)?.name ?? "—";
  return `${amountStr} · ${categoryName} · ${accountName}`;
}

export interface UsageCategory {
  id: string;
  name: string;
}

export interface UsageTx {
  category_id: string | null;
}

/**
 * Category ids ordered for the recent-category chip row: usage count over
 * `recentTx` descending, tiebreak by name ascending. Categories with zero
 * usage naturally fall out at the bottom of that same ordering, in name
 * order — no separate "unused" pass needed.
 */
export function sortCategoriesByUsage<T extends UsageCategory>(
  categories: T[],
  recentTx: UsageTx[],
): string[] {
  const counts = new Map<string, number>();
  for (const tx of recentTx) {
    if (tx.category_id === null) continue;
    counts.set(tx.category_id, (counts.get(tx.category_id) ?? 0) + 1);
  }
  return [...categories]
    .sort((a, b) => {
      const byCount = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
      return byCount !== 0 ? byCount : a.name.localeCompare(b.name);
    })
    .map((c) => c.id);
}

/**
 * Word chosen for the "Teach: always file '<word>' under <category>?"
 * affordance: the first token of the NL input that is not the parsed amount.
 * A leading "+" (income marker) is stripped first since it toggles type, not
 * a real token. Returns null when nothing is left to teach (e.g. the input
 * was only an amount).
 */
export function teachWord(text: string): string | null {
  let body = text.trim();
  if (body.startsWith("+")) body = body.slice(1).trim();
  const tokens = body === "" ? [] : body.split(/\s+/);

  const amountIndex = tokens.findIndex((t) => parseAmountToSen(t) !== null);
  const rest = tokens.filter((_, i) => i !== amountIndex);
  return rest[0]?.toLowerCase() ?? null;
}
