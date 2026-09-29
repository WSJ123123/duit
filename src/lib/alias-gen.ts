// Pure alias generator: turns account/category names into parser aliases so
// the quick-entry parser recognizes them without the user typing them in.
// No I/O — callers load names/existing phrases and persist the result.

export interface NamedEntity {
  id: string;
  name: string;
}

export interface GeneratedAlias {
  phrase: string;
  category_id: string | null;
  account_id: string | null;
}

const normalize = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

interface Entity {
  id: string;
  fullPhrase: string;
  words: string[]; // unique words (>=3 chars), in first-appearance order
  category_id: string | null;
  account_id: string | null;
}

function toEntity(e: NamedEntity, kind: "account" | "category"): Entity {
  const fullPhrase = normalize(e.name);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of fullPhrase.split(" ")) {
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  return {
    id: e.id,
    fullPhrase,
    words,
    category_id: kind === "category" ? e.id : null,
    account_id: kind === "account" ? e.id : null,
  };
}

/**
 * Generates alias candidates from account/category names:
 *  - the full lowercased name, for every account and category, and
 *  - each individual word (>=3 chars) that is unique across the WHOLE pooled
 *    set of names (accounts and categories together) — a word shared by two
 *    different names is ambiguous and skipped.
 * Skips anything already present in `existingPhrases`. A single-word name is
 * only emitted once (the full-name pass covers it; the word pass then skips
 * it as already emitted). Deterministic: accounts first (input order), then
 * categories (input order); within each entity, full name before its words.
 */
export function generateAliasesFromNames(
  accounts: NamedEntity[],
  categories: NamedEntity[],
  existingPhrases: readonly string[],
): GeneratedAlias[] {
  const entities: Entity[] = [
    ...accounts.map((a) => toEntity(a, "account")),
    ...categories.map((c) => toEntity(c, "category")),
  ];

  const emitted = new Set(existingPhrases.map((p) => normalize(p)));
  const result: GeneratedAlias[] = [];

  // Pass 1: full names.
  for (const e of entities) {
    if (emitted.has(e.fullPhrase)) continue;
    emitted.add(e.fullPhrase);
    result.push({ phrase: e.fullPhrase, category_id: e.category_id, account_id: e.account_id });
  }

  // Pass 2: unambiguous words, computed across the whole pool.
  const owners = new Map<string, Set<string>>();
  for (const e of entities) {
    for (const w of e.words) {
      (owners.get(w) ?? owners.set(w, new Set()).get(w)!).add(e.id);
    }
  }
  for (const e of entities) {
    for (const w of e.words) {
      if (emitted.has(w)) continue;
      if (owners.get(w)!.size !== 1) continue;
      emitted.add(w);
      result.push({ phrase: w, category_id: e.category_id, account_id: e.account_id });
    }
  }

  return result;
}
