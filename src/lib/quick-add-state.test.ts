import { describe, it, expect } from "vitest";
import { previewLine, sortCategoriesByUsage, teachWord } from "@/lib/quick-add-state";
import type { ParsedEntry, ParserContext } from "@/lib/parser/parse";

const ctx: ParserContext = {
  aliases: [],
  accounts: [
    { id: "acc-tng", name: "TnG eWallet" },
    { id: "acc-maybank", name: "Maybank" },
  ],
  categories: [
    { id: "cat-grab", name: "Grab", kind: "expense" },
    { id: "cat-eating-out", name: "Eating out", kind: "expense" },
    { id: "cat-groceries", name: "Groceries", kind: "expense" },
  ],
  default_account_id: "acc-tng",
};

function parsed(over: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    type: "expense",
    amount_sen: null,
    category_id: null,
    account_id: null,
    note: "",
    confident: false,
    ...over,
  };
}

describe("previewLine", () => {
  it("confident parse: amount · category · account", () => {
    const p = parsed({
      amount_sen: 1800,
      category_id: "cat-grab",
      account_id: "acc-tng",
      confident: true,
    });
    expect(previewLine(p, ctx)).toBe("RM 18.00 · Grab · TnG eWallet");
  });

  it("amount but no category: needs review with account name", () => {
    const p = parsed({
      amount_sen: 1800,
      category_id: null,
      account_id: "acc-tng",
      confident: false,
    });
    expect(previewLine(p, ctx)).toBe("RM 18.00 · needs review · TnG eWallet");
  });

  it("no amount: prompts to type one", () => {
    const p = parsed({ amount_sen: null });
    expect(previewLine(p, ctx)).toBe("Type an amount…");
  });
});

describe("sortCategoriesByUsage", () => {
  const categories = [
    { id: "cat-grab", name: "Grab" },
    { id: "cat-eating-out", name: "Eating out" },
    { id: "cat-groceries", name: "Groceries" },
  ];

  it("orders by usage count descending", () => {
    const recentTx = [
      { category_id: "cat-groceries" },
      { category_id: "cat-grab" },
      { category_id: "cat-grab" },
      { category_id: "cat-grab" },
      { category_id: "cat-groceries" },
    ];
    expect(sortCategoriesByUsage(categories, recentTx)).toEqual([
      "cat-grab",
      "cat-groceries",
      "cat-eating-out",
    ]);
  });

  it("ties break by name ascending", () => {
    const recentTx = [
      { category_id: "cat-grab" },
      { category_id: "cat-eating-out" },
    ];
    expect(sortCategoriesByUsage(categories, recentTx)).toEqual([
      "cat-eating-out",
      "cat-grab",
      "cat-groceries",
    ]);
  });

  it("unused categories follow, in name order", () => {
    const recentTx = [{ category_id: "cat-grab" }];
    expect(sortCategoriesByUsage(categories, recentTx)).toEqual([
      "cat-grab",
      "cat-eating-out",
      "cat-groceries",
    ]);
  });

  it("ignores null category_id and unknown ids in recentTx", () => {
    const recentTx = [{ category_id: null }, { category_id: "cat-unknown" }];
    expect(sortCategoriesByUsage(categories, recentTx)).toEqual([
      "cat-eating-out",
      "cat-grab",
      "cat-groceries",
    ]);
  });
});

describe("teachWord", () => {
  it("picks the first non-amount token", () => {
    expect(teachWord("grab 18 tng")).toBe("grab");
  });

  it("skips a leading amount token", () => {
    expect(teachWord("18 grab")).toBe("grab");
  });

  it("strips a leading + (income marker) before tokenizing", () => {
    expect(teachWord("+5.14 mmf")).toBe("mmf");
  });

  it("returns null when only an amount was typed", () => {
    expect(teachWord("18")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(teachWord("")).toBeNull();
  });
});
