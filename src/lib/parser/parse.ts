// Deterministic NL parser for quick entry. Pure: no LLM, network, clock, or
// randomness. All money in integer sen via parseAmountToSen.
//
// Slot-matching rule (the pinned test table in parse.test.ts is the contract):
// The category slot and account slot are INDEPENDENT matchers, each with its
// own token-consumption ledger. "Consumable once" means a token can fill each
// slot at most once — so one token may fill BOTH slots (e.g. "+5.14 mmf":
// "mmf" matches account "Moomoo MMF" AND dictionary phrase "mmf" → Interest).
// Sources run in precedence order (aliases → account names → category names →
// dictionary); within a source, phrases match longest-first (word count, then
// char length). Name matching: full normalized name as contiguous tokens, or a
// single name word (≥2 chars) — but a word appearing in two different accounts
// (or categories) is ambiguous and skipped entirely. Category matches must
// agree with the entry's kind. First match per slot wins; account falls back
// to default_account_id; category never falls back.
import { parseAmountToSen } from "@/lib/money";
import { DICTIONARY } from "./dictionary";

export type ParserContext = {
  aliases: Array<{ phrase: string; category_id: string | null; account_id: string | null }>;
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; kind: "expense" | "income" }>;
  default_account_id: string | null;
};

export type ParsedEntry = {
  type: "expense" | "income";
  amount_sen: number | null;
  category_id: string | null;
  account_id: string | null;
  note: string;
  confident: boolean;
};

const toWords = (s: string): string[] =>
  s.trim().toLowerCase().split(/\s+/).filter(Boolean);

const normalize = (token: string): string =>
  token.toLowerCase().replace(/[.,!?;:]+$/, "");

const byLongestPhrase = (a: string[], b: string[]): number =>
  b.length - a.length || b.join(" ").length - a.join(" ").length;

/** Index where `phrase` occurs contiguously over free tokens, else -1. */
function findPhrase(tokens: string[], phrase: string[], free: (i: number) => boolean): number {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (!free(i + j) || tokens[i + j] !== phrase[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Match named entities: full name first (longest-first), then unambiguous single words. */
function matchByName(
  tokens: string[],
  used: boolean[],
  entities: Array<{ id: string; words: string[] }>,
): string | null {
  for (const e of [...entities].sort((a, b) => byLongestPhrase(a.words, b.words))) {
    const at = findPhrase(tokens, e.words, (i) => !used[i]);
    if (at >= 0) {
      for (let j = 0; j < e.words.length; j++) used[at + j] = true;
      return e.id;
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const e of entities) {
    for (const w of e.words) {
      if (w.length < 2) continue;
      (owners.get(w) ?? owners.set(w, new Set()).get(w)!).add(e.id);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const ids = owners.get(tokens[i]!);
    if (ids && ids.size === 1) {
      used[i] = true;
      return [...ids][0]!;
    }
  }
  return null;
}

export function parseEntry(text: string, ctx: ParserContext): ParsedEntry {
  let body = text.trim();
  let type: "expense" | "income" = "expense";
  if (body.startsWith("+")) {
    type = "income";
    body = body.slice(1).trim();
  }
  const tokens = body === "" ? [] : body.split(/\s+/).map(normalize);

  // Amount: first token parseAmountToSen accepts; that token is consumed.
  let amount_sen: number | null = null;
  let amountAt = -1;
  for (let i = 0; i < tokens.length; i++) {
    const sen = parseAmountToSen(tokens[i]!);
    if (sen !== null) {
      amount_sen = sen;
      amountAt = i;
      break;
    }
  }
  const words = tokens.filter((_, i) => i !== amountAt);
  const usedCat = words.map(() => false);
  const usedAcct = words.map(() => false);
  let category_id: string | null = null;
  let account_id: string | null = null;

  // 1. User aliases (may fill category and/or account).
  const aliases = ctx.aliases
    .map((a) => ({ ...a, words: toWords(a.phrase) }))
    .sort((a, b) => byLongestPhrase(a.words, b.words));
  for (const a of aliases) {
    const fillCat = category_id === null && a.category_id !== null;
    const fillAcct = account_id === null && a.account_id !== null;
    if (!fillCat && !fillAcct) continue;
    const at = findPhrase(words, a.words, (i) => (!fillCat || !usedCat[i]) && (!fillAcct || !usedAcct[i]));
    if (at < 0) continue;
    for (let j = 0; j < a.words.length; j++) {
      if (fillCat) usedCat[at + j] = true;
      if (fillAcct) usedAcct[at + j] = true;
    }
    if (fillCat) category_id = a.category_id;
    if (fillAcct) account_id = a.account_id;
  }

  // 2. Account names.
  if (account_id === null) {
    account_id = matchByName(
      words,
      usedAcct,
      ctx.accounts.map((a) => ({ id: a.id, words: toWords(a.name) })),
    );
  }

  // 3. Category names (kind must agree with entry type).
  if (category_id === null) {
    category_id = matchByName(
      words,
      usedCat,
      ctx.categories.filter((c) => c.kind === type).map((c) => ({ id: c.id, words: toWords(c.name) })),
    );
  }

  // 4. Seeded dictionary (resolved against ctx.categories by name + kind).
  if (category_id === null) {
    const entries = DICTIONARY.filter((d) => d.kind === type)
      .map((d) => ({ ...d, words: toWords(d.phrase) }))
      .sort((a, b) => byLongestPhrase(a.words, b.words));
    for (const d of entries) {
      const cat = ctx.categories.find(
        (c) => c.kind === d.kind && c.name.toLowerCase() === d.category.toLowerCase(),
      );
      if (!cat) continue; // renamed/archived seeded category: entry never matches
      const at = findPhrase(words, d.words, (i) => !usedCat[i]);
      if (at < 0) continue;
      for (let j = 0; j < d.words.length; j++) usedCat[at + j] = true;
      category_id = cat.id;
      break;
    }
  }

  return {
    type,
    amount_sen,
    category_id,
    account_id: account_id ?? ctx.default_account_id,
    note: text,
    confident: amount_sen !== null && category_id !== null,
  };
}
