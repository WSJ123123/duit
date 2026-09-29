import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

let a: SupabaseClient, b: SupabaseClient;
let catFood: string, catTransport: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  catFood = (await a.from("categories")
    .insert({ name: "Food", kind: "expense" }).select().single()).data!.id;
  catTransport = (await a.from("categories")
    .insert({ name: "Transport", kind: "expense" }).select().single()).data!.id;
}, 30_000);

describe("budget schema", () => {
  it("creates and reads own budget month", async () => {
    const { data, error } = await a.from("budget_months")
      .insert({ month: "2026-09-01", expected_income_sen: 500_000 })
      .select().single();
    expect(error).toBeNull();
    expect(data!.expected_income_sen).toBe(500_000);
    expect(data!.savings_planned_sen).toBe(0);
  });

  it("rejects a non-first-of-month date", async () => {
    const { error } = await a.from("budget_months")
      .insert({ month: "2026-09-15" });
    expect(error).not.toBeNull();
    const alloc = await a.from("budget_allocations")
      .insert({ month: "2026-09-15", category_id: catFood });
    expect(alloc.error).not.toBeNull();
  });

  it("rejects a duplicate (user_id, month, category_id) allocation", async () => {
    const first = await a.from("budget_allocations")
      .insert({ month: "2026-09-01", category_id: catFood, planned_sen: 30_000 });
    expect(first.error).toBeNull();
    const dupe = await a.from("budget_allocations")
      .insert({ month: "2026-09-01", category_id: catFood, planned_sen: 40_000 });
    expect(dupe.error).not.toBeNull();
  });

  it("rejects negative sen amounts", async () => {
    const month = await a.from("budget_months")
      .insert({ month: "2026-10-01", expected_income_sen: -1 });
    expect(month.error).not.toBeNull();
    const alloc = await a.from("budget_allocations")
      .insert({ month: "2026-09-01", category_id: catTransport, planned_sen: -1 });
    expect(alloc.error).not.toBeNull();
  });

  it("benchmark_savings_pct is generated: 20 for defaults", async () => {
    const { data, error } = await a.from("user_settings")
      .upsert({ show_tips: true }).select().single();
    expect(error).toBeNull();
    expect(data!.benchmark_needs_pct).toBe(50);
    expect(data!.benchmark_wants_pct).toBe(30);
    expect(data!.benchmark_savings_pct).toBe(20);
  });

  it("rejects benchmark needs=70, wants=40 (sums past 100)", async () => {
    const { error } = await a.from("user_settings")
      .upsert({ benchmark_needs_pct: 70, benchmark_wants_pct: 40 });
    expect(error).not.toBeNull();
  });
});

describe("move_budget_allocation", () => {
  /** Seed a month for user A: budget_months row + two category envelopes. */
  async function seedMonth(month: string, foodSen: number, transportSen: number, savingsSen: number) {
    const bm = await a.from("budget_months")
      .insert({ month, savings_allocated_sen: savingsSen }).select().single();
    if (bm.error) throw bm.error;
    for (const [category_id, allocated_sen] of [[catFood, foodSen], [catTransport, transportSen]] as const) {
      const { error } = await a.from("budget_allocations")
        .insert({ month, category_id, allocated_sen });
      if (error) throw error;
    }
  }
  const alloc = async (month: string, category: string) =>
    (await a.from("budget_allocations").select("allocated_sen")
      .eq("month", month).eq("category_id", category).single()).data!.allocated_sen;
  const savings = async (month: string) =>
    (await a.from("budget_months").select("savings_allocated_sen")
      .eq("month", month).single()).data!.savings_allocated_sen;
  const logs = async (month: string) =>
    (await a.from("budget_changes").select().eq("month", month).order("category_id")).data!;

  it("moves exactly the amount between two category rows, logging both", async () => {
    await seedMonth("2026-11-01", 50_000, 10_000, 0);
    const { error } = await a.rpc("move_budget_allocation", {
      p_month: "2026-11-01", p_from_category: catFood,
      p_to_category: catTransport, p_amount_sen: 20_000,
    });
    expect(error).toBeNull();
    expect(await alloc("2026-11-01", catFood)).toBe(30_000);
    expect(await alloc("2026-11-01", catTransport)).toBe(30_000);
    const rows = await logs("2026-11-01");
    expect(rows).toHaveLength(2);
    const from = rows.find((r) => r.category_id === catFood)!;
    const to = rows.find((r) => r.category_id === catTransport)!;
    expect({ from_sen: from.from_sen, to_sen: from.to_sen }).toEqual({ from_sen: 50_000, to_sen: 30_000 });
    expect({ from_sen: to.from_sen, to_sen: to.to_sen }).toEqual({ from_sen: 10_000, to_sen: 30_000 });
  });

  it("moves category → savings (null category = budget_months)", async () => {
    await seedMonth("2026-12-01", 40_000, 0, 5_000);
    const { error } = await a.rpc("move_budget_allocation", {
      p_month: "2026-12-01", p_from_category: catFood,
      p_to_category: null, p_amount_sen: 15_000,
    });
    expect(error).toBeNull();
    expect(await alloc("2026-12-01", catFood)).toBe(25_000);
    expect(await savings("2026-12-01")).toBe(20_000);
    const rows = await logs("2026-12-01");
    expect(rows).toHaveLength(2);
    const savingsRow = rows.find((r) => r.category_id === null)!;
    expect({ from_sen: savingsRow.from_sen, to_sen: savingsRow.to_sen }).toEqual({ from_sen: 5_000, to_sen: 20_000 });
  });

  it("moves savings → category", async () => {
    await seedMonth("2027-01-01", 0, 0, 30_000);
    const { error } = await a.rpc("move_budget_allocation", {
      p_month: "2027-01-01", p_from_category: null,
      p_to_category: catTransport, p_amount_sen: 30_000,
    });
    expect(error).toBeNull();
    expect(await savings("2027-01-01")).toBe(0);
    expect(await alloc("2027-01-01", catTransport)).toBe(30_000);
    const rows = await logs("2027-01-01");
    expect(rows).toHaveLength(2);
    const savingsRow = rows.find((r) => r.category_id === null)!;
    expect({ from_sen: savingsRow.from_sen, to_sen: savingsRow.to_sen }).toEqual({ from_sen: 30_000, to_sen: 0 });
  });

  it("raises on overdraw and leaves every row unchanged", async () => {
    await seedMonth("2027-02-01", 10_000, 7_000, 0);
    const { error } = await a.rpc("move_budget_allocation", {
      p_month: "2027-02-01", p_from_category: catFood,
      p_to_category: catTransport, p_amount_sen: 20_000,
    });
    expect(error).not.toBeNull();
    expect(await alloc("2027-02-01", catFood)).toBe(10_000);
    expect(await alloc("2027-02-01", catTransport)).toBe(7_000);
    expect(await logs("2027-02-01")).toHaveLength(0);
  });

  it("raises on amount <= 0", async () => {
    for (const bad of [0, -500]) {
      const { error } = await a.rpc("move_budget_allocation", {
        p_month: "2026-11-01", p_from_category: catFood,
        p_to_category: catTransport, p_amount_sen: bad,
      });
      expect(error).not.toBeNull();
    }
  });

  it("raises when the target month is missing (or another user's, under RLS)", async () => {
    const missing = await a.rpc("move_budget_allocation", {
      p_month: "2030-01-01", p_from_category: catFood,
      p_to_category: catTransport, p_amount_sen: 100,
    });
    expect(missing.error).not.toBeNull();

    // B calling against A's seeded month: rows invisible under RLS → raises,
    // and A's balances are untouched.
    const cross = await b.rpc("move_budget_allocation", {
      p_month: "2026-11-01", p_from_category: catFood,
      p_to_category: catTransport, p_amount_sen: 100,
    });
    expect(cross.error).not.toBeNull();
    expect(await alloc("2026-11-01", catFood)).toBe(30_000);
    expect(await alloc("2026-11-01", catTransport)).toBe(30_000);
    expect(await logs("2026-11-01")).toHaveLength(2);
  });
});
