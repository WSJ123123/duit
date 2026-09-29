import { describe, it, expect } from "vitest";
import { parseAccountForm, parseCategoryForm } from "@/lib/account-form";

describe("parseAccountForm", () => {
  it("accepts a valid account and converts the balance to sen", () => {
    const result = parseAccountForm({
      name: "Maybank",
      type: "bank",
      startingBalance: "1,234.56",
    });
    expect(result).toEqual({
      ok: true,
      value: { name: "Maybank", type: "bank", startingBalanceSen: 123_456, currency: "MYR" },
    });
  });

  it("Task 5: a brokerage account may pick a curated currency", () => {
    const result = parseAccountForm({
      name: "IBKR",
      type: "brokerage",
      startingBalance: "0",
      currency: "USD",
    });
    expect(result).toEqual({
      ok: true,
      value: { name: "IBKR", type: "brokerage", startingBalanceSen: 0, currency: "USD" },
    });
  });

  it("Task 5: currency defaults to MYR when omitted", () => {
    const result = parseAccountForm({ name: "IBKR", type: "brokerage", startingBalance: "0" });
    expect(result.ok && result.value.currency).toBe("MYR");
  });

  it("Task 5: non-brokerage types cannot take a foreign currency", () => {
    const result = parseAccountForm({
      name: "Maybank",
      type: "bank",
      startingBalance: "0",
      currency: "USD",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/brokerage/i);
  });

  it("Task 5: only curated codes are accepted", () => {
    const result = parseAccountForm({
      name: "IBKR",
      type: "brokerage",
      startingBalance: "0",
      currency: "ZZZ",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid account type", () => {
    const result = parseAccountForm({
      name: "Wallet",
      type: "crypto",
      startingBalance: "0",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a balance with 3 decimal places", () => {
    const result = parseAccountForm({
      name: "Maybank",
      type: "bank",
      startingBalance: "12.345",
    });
    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it("rejects a name over 60 characters", () => {
    const result = parseAccountForm({
      name: "a".repeat(61),
      type: "bank",
      startingBalance: "0",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(parseAccountForm({ name: "", type: "bank", startingBalance: "0" }).ok).toBe(false);
    expect(parseAccountForm({ name: "   ", type: "bank", startingBalance: "0" }).ok).toBe(false);
  });

  it("rejects a missing or non-numeric starting balance", () => {
    expect(parseAccountForm({ name: "Cash", type: "cash", startingBalance: "abc" }).ok).toBe(
      false,
    );
    expect(parseAccountForm({ name: "Cash", type: "cash" }).ok).toBe(false);
  });
});

describe("parseCategoryForm", () => {
  it("accepts a valid category and defaults the tag to 'wants'", () => {
    const result = parseCategoryForm({ name: "Groceries", kind: "expense" });
    expect(result).toEqual({
      ok: true,
      value: { name: "Groceries", kind: "expense", parentId: null, tag: "wants" },
    });
  });

  it("accepts an explicit tag and parent id", () => {
    const result = parseCategoryForm({
      name: "Eating out",
      kind: "expense",
      parentId: "11111111-1111-1111-1111-111111111111",
      tag: "savings",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Eating out",
        kind: "expense",
        parentId: "11111111-1111-1111-1111-111111111111",
        tag: "savings",
      },
    });
  });

  it("rejects an invalid kind", () => {
    const result = parseCategoryForm({ name: "Groceries", kind: "transfer" });
    expect(result.ok).toBe(false);
  });

  it("rejects a name over 40 characters", () => {
    const result = parseCategoryForm({ name: "a".repeat(41), kind: "expense" });
    expect(result.ok).toBe(false);
  });

  it("falls back to the default tag on an invalid tag value", () => {
    const result = parseCategoryForm({ name: "Groceries", kind: "expense", tag: "bogus" });
    expect(result).toEqual({
      ok: true,
      value: { name: "Groceries", kind: "expense", parentId: null, tag: "wants" },
    });
  });
});
