import { describe, it, expect } from "vitest";
import { generateAliasesFromNames } from "@/lib/alias-gen";

const accounts = [
  { id: "acc-tng", name: "TnG eWallet" },
  { id: "acc-mbs", name: "Maybank Savings" },
  { id: "acc-mbc", name: "Maybank Current" },
  { id: "acc-cash", name: "Cash" },
  { id: "acc-pbgo", name: "PB Go" },
];

const categories = [
  { id: "cat-eat", name: "Eating out" },
  { id: "cat-grocery", name: "Groceries" },
];

describe("generateAliasesFromNames", () => {
  it("emits the full lowercased name for every account and category", () => {
    const result = generateAliasesFromNames(accounts, categories, []);
    const phrases = result.map((r) => r.phrase);
    expect(phrases).toContain("tng ewallet");
    expect(phrases).toContain("maybank savings");
    expect(phrases).toContain("maybank current");
    expect(phrases).toContain("cash");
    expect(phrases).toContain("pb go");
    expect(phrases).toContain("eating out");
    expect(phrases).toContain("groceries");
  });

  it("emits unique words (>=3 chars) of multi-word names, pointing at the right entity", () => {
    const result = generateAliasesFromNames(accounts, categories, []);
    const tng = result.find((r) => r.phrase === "tng");
    expect(tng).toEqual({ phrase: "tng", category_id: null, account_id: "acc-tng" });
    const ewallet = result.find((r) => r.phrase === "ewallet");
    expect(ewallet).toEqual({ phrase: "ewallet", category_id: null, account_id: "acc-tng" });

    const eating = result.find((r) => r.phrase === "eating");
    expect(eating).toEqual({ phrase: "eating", category_id: "cat-eat", account_id: null });
    // "out" is exactly 3 chars and unique across the whole pool -> emitted.
    const out = result.find((r) => r.phrase === "out");
    expect(out).toEqual({ phrase: "out", category_id: "cat-eat", account_id: null });
  });

  it("skips a word shared by two different names (ambiguous), even though both full names are emitted", () => {
    const result = generateAliasesFromNames(accounts, categories, []);
    const maybankWord = result.find((r) => r.phrase === "maybank");
    expect(maybankWord).toBeUndefined();
    // But the full names for both accounts are still present.
    expect(result.some((r) => r.phrase === "maybank savings")).toBe(true);
    expect(result.some((r) => r.phrase === "maybank current")).toBe(true);
    // Unambiguous words from those same names are still emitted.
    expect(result.some((r) => r.phrase === "savings")).toBe(true);
    expect(result.some((r) => r.phrase === "current")).toBe(true);
  });

  it("skips words shorter than 3 chars", () => {
    const result = generateAliasesFromNames(accounts, categories, []);
    expect(result.some((r) => r.phrase === "pb")).toBe(false);
    expect(result.some((r) => r.phrase === "go")).toBe(false);
    // The full name is still emitted.
    expect(result.some((r) => r.phrase === "pb go")).toBe(true);
  });

  it("does not duplicate a single-word name as both a full phrase and a word phrase", () => {
    const result = generateAliasesFromNames(accounts, categories, []);
    const cashEntries = result.filter((r) => r.phrase === "cash");
    expect(cashEntries).toHaveLength(1);
    const groceriesEntries = result.filter((r) => r.phrase === "groceries");
    expect(groceriesEntries).toHaveLength(1);
  });

  it("skips phrases already present in existingPhrases", () => {
    const result = generateAliasesFromNames(accounts, categories, ["tng"]);
    expect(result.some((r) => r.phrase === "tng")).toBe(false);
    // Everything else generator would have produced is unaffected.
    expect(result.some((r) => r.phrase === "ewallet")).toBe(true);
  });

  it("skips the full-name phrase too when it is already in existingPhrases", () => {
    const result = generateAliasesFromNames(accounts, categories, ["cash"]);
    expect(result.some((r) => r.phrase === "cash")).toBe(false);
  });

  it("is deterministic across repeated calls", () => {
    const first = generateAliasesFromNames(accounts, categories, []);
    const second = generateAliasesFromNames(accounts, categories, []);
    expect(second).toEqual(first);
  });

  it("returns an empty array when there is nothing to generate from", () => {
    expect(generateAliasesFromNames([], [], [])).toEqual([]);
  });
});
