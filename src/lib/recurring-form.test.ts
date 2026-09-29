import { describe, it, expect } from "vitest";
import { validateRecurringInput, describeCadence, type RecurringFormInput } from "./recurring-form";

const base = (over: Partial<RecurringFormInput> = {}): RecurringFormInput => ({
  name: "Rent",
  type: "expense",
  amount: "1500.00",
  accountId: "acct-1",
  freq: "monthly",
  dayOfMonth: "1",
  ...over,
});

describe("validateRecurringInput", () => {
  it("monthly rule with a valid day of month → ok", () => {
    const result = validateRecurringInput(base());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.freq).toBe("monthly");
      expect(result.value.day_of_month).toBe(1);
      expect(result.value.amount_sen).toBe(150_000);
    }
  });

  it("monthly without day_of_month → error", () => {
    const result = validateRecurringInput(base({ dayOfMonth: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/day of month/i);
  });

  it("weekly with weekday 6 → ok", () => {
    const result = validateRecurringInput(
      base({ freq: "weekly", dayOfMonth: undefined, weekday: "6" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.freq).toBe("weekly");
      expect(result.value.weekday).toBe(6);
      expect(result.value.day_of_month).toBeNull();
    }
  });

  it("weekly without weekday → error", () => {
    const result = validateRecurringInput(base({ freq: "weekly", dayOfMonth: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/weekday/i);
  });

  it("yearly needs both day and month — missing month → error", () => {
    const result = validateRecurringInput(base({ freq: "yearly", dayOfMonth: "15" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/day of month and a month/i);
  });

  it("yearly needs both day and month — missing day → error", () => {
    const result = validateRecurringInput(
      base({ freq: "yearly", dayOfMonth: undefined, monthOfYear: "8" }),
    );
    expect(result.ok).toBe(false);
  });

  it("yearly with both day and month → ok", () => {
    const result = validateRecurringInput(
      base({ freq: "yearly", dayOfMonth: "15", monthOfYear: "8" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.day_of_month).toBe(15);
      expect(result.value.month_of_year).toBe(8);
      expect(result.value.weekday).toBeNull();
    }
  });

  it('amount "12.345" (3 decimals) → error', () => {
    const result = validateRecurringInput(base({ amount: "12.345" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/amount/i);
  });

  it("transfer to the same account as source → error", () => {
    const result = validateRecurringInput(
      base({ type: "transfer", transferAccountId: "acct-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/differ from source/i);
  });

  it("transfer with a distinct destination → ok", () => {
    const result = validateRecurringInput(
      base({ type: "transfer", transferAccountId: "acct-2" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transfer_account_id).toBe("acct-2");
      expect(result.value.category_id).toBeNull();
    }
  });

  it("transfer with a category → error", () => {
    const result = validateRecurringInput(
      base({ type: "transfer", transferAccountId: "acct-2", categoryId: "cat-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot have a category/i);
  });

  it("transfer without a destination account → error", () => {
    const result = validateRecurringInput(base({ type: "transfer" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/destination account/i);
  });

  it("non-transfer with a transferAccountId set → error", () => {
    const result = validateRecurringInput(base({ transferAccountId: "acct-2" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only transfers/i);
  });

  it(
    "variable rule still needs a positive amount (schema: amount_sen not null, > 0 — " +
      "variable only flags materialized entries for review, see materializeDueRules)",
    () => {
      const missing = validateRecurringInput(base({ variable: true, amount: "" }));
      expect(missing.ok).toBe(false);

      const withAmount = validateRecurringInput(base({ variable: true, amount: "150.00" }));
      expect(withAmount.ok).toBe(true);
      if (withAmount.ok) {
        expect(withAmount.value.variable).toBe(true);
        expect(withAmount.value.amount_sen).toBe(15_000);
      }
    },
  );

  it("name must be 1-60 characters", () => {
    const result = validateRecurringInput(base({ name: "" }));
    expect(result.ok).toBe(false);
  });
});

describe("describeCadence", () => {
  it("monthly", () => {
    expect(describeCadence({ freq: "monthly", day_of_month: 28, weekday: null, month_of_year: null })).toBe(
      "monthly · day 28",
    );
  });

  it("weekly", () => {
    expect(describeCadence({ freq: "weekly", day_of_month: null, weekday: 1, month_of_year: null })).toBe(
      "weekly · Mon",
    );
  });

  it("yearly", () => {
    expect(
      describeCadence({ freq: "yearly", day_of_month: 15, weekday: null, month_of_year: 8 }),
    ).toBe("yearly · 15 Aug");
  });
});
