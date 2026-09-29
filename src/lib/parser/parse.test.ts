import { describe, expect, it } from "vitest";
import { parseEntry, type ParserContext } from "./parse";

const ids = {
  maybank: "acct-maybank",
  tng: "acct-tng",
  cash: "acct-cash",
  moomoo: "acct-moomoo",
  eatingOut: "cat-eating-out",
  groceries: "cat-groceries",
  delivery: "cat-delivery",
  grab: "cat-grab",
  petrol: "cat-petrol",
  tolls: "cat-tolls",
  parking: "cat-parking",
  shopping: "cat-shopping",
  subscriptions: "cat-subscriptions",
  salary: "cat-salary",
  interest: "cat-interest",
  dividends: "cat-dividends",
} as const;

const ctx: ParserContext = {
  aliases: [{ phrase: "mamak", category_id: ids.eatingOut, account_id: null }],
  accounts: [
    { id: ids.maybank, name: "Maybank" },
    { id: ids.tng, name: "TnG eWallet" },
    { id: ids.cash, name: "Cash" },
    { id: ids.moomoo, name: "Moomoo MMF" },
  ],
  categories: [
    { id: ids.eatingOut, name: "Eating out", kind: "expense" },
    { id: ids.groceries, name: "Groceries", kind: "expense" },
    { id: ids.delivery, name: "Delivery", kind: "expense" },
    { id: ids.grab, name: "Grab", kind: "expense" },
    { id: ids.petrol, name: "Petrol", kind: "expense" },
    { id: ids.tolls, name: "Tolls", kind: "expense" },
    { id: ids.parking, name: "Parking", kind: "expense" },
    { id: ids.shopping, name: "Shopping", kind: "expense" },
    { id: ids.subscriptions, name: "Subscriptions", kind: "expense" },
    { id: ids.salary, name: "Salary", kind: "income" },
    { id: ids.interest, name: "Interest", kind: "income" },
    { id: ids.dividends, name: "Dividends", kind: "income" },
  ],
  default_account_id: ids.maybank,
};

const parse = (text: string) => parseEntry(text, ctx);

describe("parseEntry", () => {
  it("matches a multi-word dictionary phrase", () => {
    expect(parse("nasi lemak 12.5")).toEqual({
      type: "expense",
      amount_sen: 1250,
      category_id: ids.eatingOut,
      account_id: ids.maybank,
      note: "nasi lemak 12.5",
      confident: true,
    });
  });

  it("matches dictionary category plus account word", () => {
    expect(parse("grab 18 tng")).toMatchObject({
      amount_sen: 1800,
      category_id: ids.grab,
      account_id: ids.tng,
      confident: true,
    });
  });

  it("maps merchant words to categories", () => {
    expect(parse("shell 87")).toMatchObject({
      amount_sen: 8700,
      category_id: ids.petrol,
      confident: true,
    });
  });

  it("user alias beats the dictionary", () => {
    expect(parse("mamak 8")).toMatchObject({
      amount_sen: 800,
      category_id: ids.eatingOut,
      confident: true,
    });
  });

  it("one token can fill both account and category slots (+5.14 mmf)", () => {
    expect(parse("+5.14 mmf")).toMatchObject({
      type: "income",
      amount_sen: 514,
      category_id: ids.interest,
      account_id: ids.moomoo,
      confident: true,
    });
  });

  it("income entries match income categories by name", () => {
    expect(parse("+3500 salary")).toMatchObject({
      type: "income",
      amount_sen: 350000,
      category_id: ids.salary,
      confident: true,
    });
  });

  it("amount only: default account, not confident", () => {
    expect(parse("12.5")).toMatchObject({
      amount_sen: 1250,
      category_id: null,
      account_id: ids.maybank,
      confident: false,
    });
  });

  it("no fuzzy prefixes: 'shop' is not a word of 'Shopping'", () => {
    expect(parse("mystery shop 45")).toMatchObject({
      amount_sen: 4500,
      category_id: null,
      confident: false,
    });
  });

  it("unknown words degrade gracefully", () => {
    expect(parse("blorp 45")).toMatchObject({
      amount_sen: 4500,
      category_id: null,
      account_id: ids.maybank,
      confident: false,
    });
  });

  it("no amount token means amount_sen null and not confident", () => {
    expect(parse("mcd")).toMatchObject({ amount_sen: null, confident: false });
  });

  it("matching is case-insensitive", () => {
    expect(parse("GRAB 18")).toMatchObject({ category_id: ids.grab });
  });

  it("subscription merchants resolve", () => {
    expect(parse("netflix 45.90")).toMatchObject({
      amount_sen: 4590,
      category_id: ids.subscriptions,
    });
  });

  it("the FIRST amount-like token wins", () => {
    expect(parse("grab 18 tng 2")).toMatchObject({ amount_sen: 1800 });
  });

  it("strips trailing punctuation for matching; note stays verbatim", () => {
    expect(parse("makan 12, best")).toMatchObject({
      amount_sen: 1200,
      category_id: ids.eatingOut,
      note: "makan 12, best",
    });
  });

  it("note preserves the raw input verbatim, including the leading +", () => {
    expect(parse("+5.14 mmf").note).toBe("+5.14 mmf");
  });

  it("income entries never match expense categories", () => {
    expect(parse("+50 grab")).toMatchObject({ category_id: null });
  });
});

describe("parseEntry ambiguity", () => {
  const ambiguousCtx: ParserContext = {
    aliases: [],
    accounts: [
      { id: "acct-mb-savings", name: "Maybank Savings" },
      { id: "acct-mb-current", name: "Maybank Current" },
    ],
    categories: [],
    default_account_id: "acct-mb-savings",
  };

  it("a word shared by two accounts is skipped, not guessed", () => {
    expect(parseEntry("maybank 10", ambiguousCtx)).toMatchObject({
      amount_sen: 1000,
      account_id: "acct-mb-savings", // the default, not a guess
    });
  });

  it("an unambiguous word of a multi-word account name still matches", () => {
    expect(parseEntry("current 10", ambiguousCtx)).toMatchObject({
      account_id: "acct-mb-current",
    });
  });
});
