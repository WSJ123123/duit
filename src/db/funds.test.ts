import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getNetWorth, getAllocation } from "@/db/networth";
import { getBudgetMonth } from "@/db/budget";
import {
  getFunds,
  performCreateFund,
  performUpdateFund,
  performArchiveFund,
  performUnarchiveFund,
  performSetContribution,
  performApplyMonthlyContributions,
  getFundOptions,
  divHalfUp,
} from "@/db/funds";

/**
 * Plan 7 Task 2 — the fund query layer over a fixture that reproduces mockup
 * v6 §7 to the sen: RM 15,550 across four active funds, an RM 3,090 average
 * monthly expense, a 6-month emergency target of RM 18,540, and an RM 1,200
 * savings envelope for the month.
 *
 * 2077 fixture dates (house convention): materializeDueRules is global across
 * users, so past-dated fixtures in other suites must not interact with these.
 */

let a: SupabaseClient;
let b: SupabaseClient;
let bank: string;
let usd: string;
let transport: string;
let emergency: string, car: string, japan: string, gadget: string, oldHoliday: string;
let untaggedAugustTxId: string;

const TODAY = "2077-08-19";
const MONTH = "2077-08";
const PREV = "2077-07";

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());

  const mkAccount = async (
    name: string,
    type: string,
    starting_balance_sen: number,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await a
      .from("accounts")
      .insert({ name, type, starting_balance_sen, ...extra })
      .select()
      .single();
    if (res.error) throw res.error;
    return res.data.id as string;
  };
  bank = await mkAccount("Maybank", "bank", 3_500_000);
  await mkAccount("ASM", "other", 500_000); // ruling 9b: every type counts
  usd = await mkAccount("Moomoo USD", "brokerage", 200_000, { currency: "USD" }); // excluded
  await mkAccount("Closed bank", "bank", 100_000, { archived: true }); // excluded

  const cat = await a
    .from("categories")
    .insert({ name: "Transport", kind: "expense", tag: "needs" })
    .select()
    .single();
  if (cat.error) throw cat.error;
  transport = cat.data.id;

  const mkFund = async (row: Record<string, unknown>) => {
    const res = await a.from("funds").insert(row).select().single();
    if (res.error) throw res.error;
    return res.data.id as string;
  };
  emergency = await mkFund({
    name: "Emergency fund", kind: "emergency", target_months: 6,
    monthly_contribution_sen: 40_000, priority: 0,
  });
  car = await mkFund({
    name: "Car insurance & road tax", kind: "sinking", target_sen: 240_000,
    target_date: "2078-03-14", monthly_contribution_sen: 20_000, priority: 0,
  });
  japan = await mkFund({
    name: "Travel · Japan", kind: "goal", target_sen: 800_000,
    target_date: "2078-03-20", monthly_contribution_sen: 30_000, priority: 0,
  });
  gadget = await mkFund({
    name: "Gadget replacement", kind: "sinking", monthly_contribution_sen: 0, priority: 0,
  });
  oldHoliday = await mkFund({
    name: "Old holiday", kind: "goal", target_sen: 100_000,
    monthly_contribution_sen: 0, priority: 0,
  });

  // Last month's earmarks — amount_sen is ALWAYS explicit (no column default).
  const contribs = await a.from("fund_contributions").insert([
    { fund_id: emergency, month: `${PREV}-01`, amount_sen: 1_130_000 },
    { fund_id: car, month: `${PREV}-01`, amount_sen: 120_000 },
    { fund_id: japan, month: `${PREV}-01`, amount_sen: 215_000 },
    { fund_id: gadget, month: `${PREV}-01`, amount_sen: 99_000 },
    { fund_id: oldHoliday, month: `${PREV}-01`, amount_sen: 50_000 },
  ]);
  if (contribs.error) throw contribs.error;

  // Two full prior months of spending → avgMonthlyExpenseSen = RM 3,090.
  const tx = await a.from("transactions").insert([
    // A bulk insert must carry the same keys on every row (a missing key
    // arrives as null, and `note` is NOT NULL).
    { type: "expense", amount_sen: 300_000, account_id: bank, category_id: transport, date: "2077-06-05", note: "June transport", fund_id: null },
    { type: "expense", amount_sen: 318_000, account_id: bank, category_id: transport, date: "2077-07-05", note: "July transport", fund_id: null },
    // This month: one fund draw on an ACTIVE fund (v6's "Road tax · 12 Aug"),
    // one on the fund that gets archived (ruling 9a), one untagged.
    { type: "expense", amount_sen: 9_000, account_id: bank, category_id: transport, date: "2077-08-12", note: "Road tax", fund_id: car },
    { type: "expense", amount_sen: 4_000, account_id: bank, category_id: null, date: "2077-08-14", note: "Holiday snacks", fund_id: oldHoliday },
    { type: "expense", amount_sen: 5_000, account_id: bank, category_id: transport, date: "2077-08-16", note: "Petrol", fund_id: null },
    // Session-12 Minor 5: a fund-tagged row on the USD account. Ruling 8
    // makes it unreachable through the form, but the table check is
    // currency-blind, so every fund-balance read must ignore it itself: its
    // amount_sen are US cents, not MYR sen. Every balance asserted below is
    // computed WITHOUT it.
    { type: "expense", amount_sen: 45_000, account_id: usd, category_id: transport, date: "2077-08-13", note: "USD tagged — must be excluded", fund_id: car },
  ]).select("id, note");
  if (tx.error) throw tx.error;
  untaggedAugustTxId = tx.data.find((t) => t.note === "Petrol")!.id;

  // Archiving never untags (ruling 9a) — the snack draw stays tagged.
  const arch = await a.from("funds").update({ archived: true }).eq("id", oldHoliday);
  if (arch.error) throw arch.error;

  const bm = await a.from("budget_months").insert({
    month: `${MONTH}-01`, expected_income_sen: 600_000,
    savings_planned_sen: 120_000, savings_allocated_sen: 120_000,
  });
  if (bm.error) throw bm.error;
}, 30_000);

describe("getFunds — one composed read (v6 §7 reproduced to the sen)", () => {
  it("returns the month, the envelope and the shared expense average", async () => {
    const data = await getFunds(a, TODAY);
    expect(data.month).toBe(MONTH);
    expect(data.month_planned).toBe(true);
    expect(data.envelope_sen).toBe(120_000); // RM 1,200
    expect(data.avg_monthly_expense_sen).toBe(309_000); // RM 3,090
  });

  it("derives every active fund's balance, target, progress and status", async () => {
    const data = await getFunds(a, TODAY);
    // Waterfall order: emergency, then dated, then open-ended.
    expect(data.funds.map((f) => f.name)).toEqual([
      "Emergency fund",
      "Car insurance & road tax",
      "Travel · Japan",
      "Gadget replacement",
    ]);

    const emg = data.funds[0]!;
    expect(emg.balance_sen).toBe(1_130_000);
    expect(emg.resolved_target_sen).toBe(1_854_000); // 6 × RM 3,090
    expect(emg.progress_pct).toBe(61);
    expect(emg.required_monthly_sen).toBeNull(); // no target_date
    expect(emg.status).toBe("on_track");
    expect(emg.contribution_sen).toBe(40_000); // fallback: not applied yet
    expect(emg.contribution_applied).toBe(false);

    const carRow = data.funds[1]!;
    expect(carRow.balance_sen).toBe(111_000); // 120_000 − 9_000 road tax
    expect(carRow.progress_pct).toBe(46);
    expect(carRow.required_monthly_sen).toBe(18_429);
    expect(carRow.status).toBe("on_track");

    const jpn = data.funds[2]!;
    expect(jpn.balance_sen).toBe(215_000);
    expect(jpn.progress_pct).toBe(27);
    expect(jpn.required_monthly_sen).toBe(83_571);
    expect(jpn.status).toBe("behind");
    expect(jpn.behind_by_sen).toBe(53_571);

    const gdg = data.funds[3]!;
    expect(gdg.balance_sen).toBe(99_000);
    expect(gdg.resolved_target_sen).toBeNull();
    expect(gdg.progress_pct).toBeNull();
    expect(gdg.status).toBe("paused");
  });

  it("discloses archived funds WITH their balances and keeps them out of the total (ruling 9a)", async () => {
    const data = await getFunds(a, TODAY);
    expect(data.archived_count).toBe(1);
    expect(data.archived_funds.map((f) => f.name)).toEqual(["Old holiday"]);
    expect(data.archived_funds[0]!.balance_sen).toBe(46_000); // 50_000 − 4_000
    // Active only — and the UI says so.
    expect(data.total_saved_sen).toBe(1_555_000); // RM 15,550
  });

  it("sums every non-archived MYR account, all types (ruling 9b)", async () => {
    const data = await getFunds(a, TODAY);
    // Maybank 3_500_000 − 636_000 spent = 2_864_000, plus ASM 500_000.
    // The USD brokerage and the archived bank are both excluded.
    expect(data.myr_accounts_total_sen).toBe(3_364_000);
  });

  it("hero drawn term is ACTIVE-only; the Budget page's Paid from funds keeps ruling 9a's all-funds reading (Plan 8 ruling 4)", async () => {
    const [data, budget] = await Promise.all([getFunds(a, TODAY), getBudgetMonth(a, MONTH)]);
    // The hero delta's drawn term: Road tax (active Car fund) only — the
    // archived Old holiday's RM 40 snack draw is out, matching the
    // active-only `applied_total_sen` it is subtracted from.
    expect(data.drawn_this_month_sen).toBe(9_000);
    // The Budget page's `Paid from funds`: archiving never untags, so the
    // RM 40 stays off the category limits and stays counted here.
    expect(budget.totals.fund_spend_sen).toBe(13_000);
    // The disclosure list totals the same all-funds figure — the Goals
    // "Budget effect" line sums it, so it can never say the active-only RM 90.
    expect(data.drawn_this_month.reduce((sum, d) => sum + d.amount_sen, 0)).toBe(13_000);
    // The disclosure list itself still shows the archived fund's draw.
    expect(data.drawn_this_month.map((d) => d.note)).toEqual(["Road tax", "Holiday snacks"]);
    const roadTax = data.drawn_this_month[0]!;
    expect(roadTax.date).toBe("2077-08-12");
    expect(roadTax.amount_sen).toBe(9_000);
    expect(roadTax.fund_name).toBe("Car insurance & road tax");
    expect(roadTax.category_name).toBe("Transport");
    expect(data.drawn_this_month[1]!.fund_name).toBe("Old holiday");
    expect(data.drawn_this_month[1]!.category_name).toBeNull();
  });

  it("reports the month's applied and planned contributions", async () => {
    const data = await getFunds(a, TODAY);
    expect(data.applied_count).toBe(0);
    expect(data.applied_total_sen).toBe(0);
    expect(data.planned_total_sen).toBe(90_000); // RM 900 across 4 funds
  });

  it("carries the waterfall (ruling 10) — RM 300 left to invest", async () => {
    const { waterfall } = await getFunds(a, TODAY);
    expect(waterfall.steps.map((s) => s.planned_sen)).toEqual([40_000, 50_000, 0, 30_000]);
    expect(waterfall.steps.map((s) => s.funded_sen)).toEqual([40_000, 50_000, 0, 30_000]);
    expect(waterfall.steps[1]!.funds.map((f) => f.name)).toEqual([
      "Car insurance & road tax",
      "Travel · Japan",
    ]);
    expect(waterfall.leftover_sen).toBe(30_000);
    // Archived funds never enter the waterfall.
    expect(waterfall.steps.flatMap((s) => s.funds).map((f) => f.name)).not.toContain("Old holiday");
  });
});

describe("Session-12 Minor 5 — a fund-tagged row on a non-MYR account is invisible to every fund balance", () => {
  // The fixture's "USD tagged — must be excluded" row (45_000 US cents on the
  // Car fund). getFunds and getFundOptions are the two reads asserted here;
  // the third, avgMonthlyFundPaidExpenseSen, is pinned on user E below
  // (R2-1) — its window excludes the current month, so it cannot see this row.
  it("getFunds: the Car fund's balance and this month's draws ignore it", async () => {
    const data = await getFunds(a, TODAY);
    const carRow = data.funds.find((f) => f.id === car)!;
    expect(carRow.balance_sen).toBe(111_000); // 120_000 − 9_000, never − 45_000
    expect(data.drawn_this_month.map((d) => d.note)).not.toContain("USD tagged — must be excluded");
  });

  it("getFundOptions: the picker's balance ignores it too", async () => {
    const options = await getFundOptions(a);
    expect(options.find((o) => o.id === car)!.balance_sen).toBe(111_000);
  });
});

describe("getFundOptions — the transaction form's picker (Task 4)", () => {
  it("carries every fund, archived included, with the SAME balances getFunds derives", async () => {
    const [options, full] = await Promise.all([getFundOptions(a), getFunds(a, TODAY)]);
    const balanceByName = new Map(options.map((o) => [o.name, o.balance_sen]));

    // Ruling 9a: an existing tag on an archived fund must still render and
    // still be clearable, so the picker's source cannot filter them out.
    expect(options.map((o) => o.name)).toContain("Old holiday");
    expect(options.find((o) => o.name === "Old holiday")!.archived).toBe(true);

    for (const fund of [...full.funds, ...full.archived_funds]) {
      expect(balanceByName.get(fund.name)).toBe(fund.balance_sen);
    }
  });

  it("RLS: user B's picker is empty", async () => {
    expect(await getFundOptions(b)).toEqual([]);
  });
});

describe("performApplyMonthlyContributions — ruling 4's idempotence", () => {
  it("inserts one row per ACTIVE fund at its monthly amount", async () => {
    const result = await performApplyMonthlyContributions(a, MONTH);
    expect(result).toEqual({ ok: true, inserted: 4 });

    const data = await getFunds(a, TODAY);
    expect(data.applied_count).toBe(4);
    expect(data.applied_total_sen).toBe(90_000);
    expect(data.funds.every((f) => f.contribution_applied)).toBe(true);
    // The earmark landed: balances moved by the contribution, nothing else.
    expect(data.funds[0]!.balance_sen).toBe(1_170_000);
    // The archived fund was skipped.
    expect(data.archived_funds[0]!.contribution_applied).toBe(false);
  });

  it("a second press inserts nothing (double-fire is a no-op)", async () => {
    const result = await performApplyMonthlyContributions(a, MONTH);
    expect(result).toEqual({ ok: true, inserted: 0 });
    const rows = await a
      .from("fund_contributions")
      .select("id", { count: "exact", head: true })
      .eq("month", `${MONTH}-01`);
    expect(rows.count).toBe(4);
  });

  it("rejects a malformed month", async () => {
    const result = await performApplyMonthlyContributions(a, "2077-8");
    expect(result.ok).toBe(false);
  });
});

describe("performSetContribution", () => {
  it("upserts exactly one row per (fund, month)", async () => {
    expect(await performSetContribution(a, emergency, MONTH, 25_000)).toEqual({ ok: true });
    expect(await performSetContribution(a, emergency, MONTH, 30_000)).toEqual({ ok: true });
    const rows = await a
      .from("fund_contributions")
      .select("amount_sen")
      .eq("fund_id", emergency)
      .eq("month", `${MONTH}-01`);
    expect(rows.data).toEqual([{ amount_sen: 30_000 }]);
  });

  it("the stored row wins over monthly_contribution_sen everywhere", async () => {
    const data = await getFunds(a, TODAY);
    expect(data.funds[0]!.contribution_sen).toBe(30_000);
    expect(data.planned_total_sen).toBe(80_000);
    expect(data.waterfall.steps[0]!.planned_sen).toBe(30_000);
    expect(data.waterfall.leftover_sen).toBe(40_000);
  });

  it("Apply never overwrites a hand-edited row", async () => {
    expect(await performApplyMonthlyContributions(a, MONTH)).toEqual({ ok: true, inserted: 0 });
    const rows = await a
      .from("fund_contributions")
      .select("amount_sen")
      .eq("fund_id", emergency)
      .eq("month", `${MONTH}-01`);
    expect(rows.data).toEqual([{ amount_sen: 30_000 }]);
  });

  it("rejects a negative amount and a malformed month", async () => {
    expect((await performSetContribution(a, emergency, MONTH, -1)).ok).toBe(false);
    expect((await performSetContribution(a, emergency, "2077-13", 100)).ok).toBe(false);
  });
});

describe("performCreateFund / performUpdateFund — zod at the boundary", () => {
  const base = {
    name: "Roof repair",
    kind: "sinking" as const,
    target_sen: 500_000,
    target_months: null,
    target_date: "2078-06-30",
    monthly_contribution_sen: 10_000,
    priority: 2,
  };

  it("creates a fund", async () => {
    expect(await performCreateFund(a, base)).toEqual({ ok: true });
    const row = await a.from("funds").select("*").eq("name", "Roof repair").single();
    expect(row.data!.target_sen).toBe(500_000);
    expect(row.data!.priority).toBe(2);
    expect(row.data!.archived).toBe(false);
  });

  it("rejects both target shapes at once", async () => {
    const result = await performCreateFund(a, {
      ...base, name: "Two targets", kind: "emergency", target_months: 6,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects target_months on a non-emergency kind", async () => {
    const result = await performCreateFund(a, {
      ...base, name: "Months on sinking", target_sen: null, target_months: 6,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty name, an over-long name and a negative contribution", async () => {
    expect((await performCreateFund(a, { ...base, name: "" })).ok).toBe(false);
    expect((await performCreateFund(a, { ...base, name: "x".repeat(61) })).ok).toBe(false);
    expect((await performCreateFund(a, { ...base, monthly_contribution_sen: -1 })).ok).toBe(false);
  });

  it("updates a fund and re-validates the same rules", async () => {
    const id = (await a.from("funds").select("id").eq("name", "Roof repair").single()).data!.id;
    expect(await performUpdateFund(a, id, { ...base, monthly_contribution_sen: 15_000 })).toEqual({
      ok: true,
    });
    const row = await a.from("funds").select("monthly_contribution_sen").eq("id", id).single();
    expect(row.data!.monthly_contribution_sen).toBe(15_000);
    expect((await performUpdateFund(a, id, { ...base, target_months: 6 })).ok).toBe(false);
  });
});

describe("performArchiveFund / performUnarchiveFund — ruling 9a round trip", () => {
  it("archives with the current-month tagged count, keeps the tag, then restores", async () => {
    const archived = await performArchiveFund(a, car, MONTH);
    // 2: Road tax plus the fixture's USD-account row — that row really IS
    // tagged, so a COUNT of tagged rows sees it; only the sen SUMS exclude it
    // (Minor 5 is about sums of amount_sen, never about whether a tag exists).
    expect(archived).toEqual({ ok: true, tagged_this_month: 2 });

    const after = await getFunds(a, TODAY);
    expect(after.funds.map((f) => f.id)).not.toContain(car);
    const row = after.archived_funds.find((f) => f.id === car)!;
    expect(row.balance_sen).toBe(131_000); // 120_000 + 20_000 applied − 9_000
    // The tag survived: the draw is still disclosed this month.
    expect(after.drawn_this_month.map((d) => d.note)).toContain("Road tax");
    const stillTagged = await a
      .from("transactions")
      .select("fund_id")
      .eq("note", "Road tax")
      .single();
    expect(stillTagged.data!.fund_id).toBe(car);

    expect(await performUnarchiveFund(a, car)).toEqual({ ok: true });
    const restored = await getFunds(a, TODAY);
    expect(restored.funds.map((f) => f.id)).toContain(car);
    expect(restored.archived_funds.map((f) => f.id)).not.toContain(car);
  });
});

describe("ruling 1(b) — no fund operation ever creates, edits or deletes a transaction", () => {
  it("leaves every transactions row untouched across the whole write surface", async () => {
    const snapshot = async () => {
      const res = await a.from("transactions").select("*").order("id");
      if (res.error) throw res.error;
      return res.data;
    };
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);

    const input = {
      name: "Ruling one b probe",
      kind: "goal" as const,
      target_sen: 50_000,
      target_months: null,
      target_date: null,
      monthly_contribution_sen: 1_000,
      priority: 8,
    };
    expect(await performCreateFund(a, input)).toEqual({ ok: true });
    const probe = (await a.from("funds").select("id").eq("name", input.name).single()).data!.id;
    expect(await performUpdateFund(a, probe, { ...input, monthly_contribution_sen: 2_000 })).toEqual(
      { ok: true },
    );
    expect(await performSetContribution(a, probe, MONTH, 1_500)).toEqual({ ok: true });
    expect((await performApplyMonthlyContributions(a, MONTH)).ok).toBe(true);
    expect((await performArchiveFund(a, probe, MONTH)).ok).toBe(true);
    expect(await performUnarchiveFund(a, probe)).toEqual({ ok: true });

    expect(await snapshot()).toEqual(before);
  });
});

describe("ruling 1 — a fund is an earmark, never a balance", () => {
  it("net worth's five parts AND the allocation pot are byte-identical before and after funding a fund", async () => {
    const before = (await getNetWorth(a, TODAY)).parts;
    // Ruling 20's reserve row puts fund balances ON the allocation card, so
    // the pot is pinned here too. ⚠ Read this for what it is: a FORWARD
    // TRIPWIRE, not proof. It cannot fail today, because `getAllocation`
    // reads no fund table at all — the reserve row is composed in the page
    // from a separate `getFunds` call and `AllocationData` never carries it.
    // That is exactly the design ruling 20 asked for, and this assertion is
    // what fails the day someone "simplifies" it by folding fund balances
    // into `getAllocation` and moves the pot by a sen.
    const bucketsBefore = (await getAllocation(a, TODAY)).buckets;

    expect(await performCreateFund(a, {
      name: "Ruling one probe",
      kind: "goal",
      target_sen: 100_000,
      target_months: null,
      target_date: null,
      monthly_contribution_sen: 7_000,
      priority: 9,
    })).toEqual({ ok: true });
    const probe = (await a.from("funds").select("id").eq("name", "Ruling one probe").single())
      .data!.id;
    expect(await performSetContribution(a, probe, MONTH, 7_000)).toEqual({ ok: true });
    // Tag an EXISTING expense — no transaction is created, edited or deleted.
    const tag = await a.from("transactions").update({ fund_id: probe }).eq("id", untaggedAugustTxId);
    expect(tag.error).toBeNull();

    const after = (await getNetWorth(a, TODAY)).parts;
    expect(after).toEqual(before);
    expect((await getAllocation(a, TODAY)).buckets).toEqual(bucketsBefore);
  });
});

describe("getFunds pages its unbounded reads", () => {
  // PostgREST truncates an unbounded select at 1000 rows with HTTP 200 and no
  // error. Ruling 5's identity needs ALL history, so both reads that feed it
  // are paged; this pins that. It runs after every test that asserts the
  // fixture's own numbers — it deliberately pushes the row counts past the cap.
  it("sums every contribution and lists every draw past the 1000-row cap", async () => {
    const probeRes = await a
      .from("funds")
      .insert({ name: "Paging probe", kind: "goal", monthly_contribution_sen: 0, priority: 7 })
      .select()
      .single();
    if (probeRes.error) throw probeRes.error;
    const probe = probeRes.data.id as string;

    // 1001 earmarks — one per month, since (user_id, fund_id, month) is unique.
    const contributions: Array<{ fund_id: string; month: string; amount_sen: number }> = [];
    let year = 2100;
    let monthNum = 1;
    for (let i = 0; i < 1001; i++) {
      contributions.push({
        fund_id: probe,
        month: `${year}-${String(monthNum).padStart(2, "0")}-01`,
        amount_sen: 7,
      });
      monthNum += 1;
      if (monthNum === 13) {
        monthNum = 1;
        year += 1;
      }
    }
    const cRes = await a.from("fund_contributions").insert(contributions);
    if (cRes.error) throw cRes.error;

    // 1001 draws this month, a different amount so no truncation can land on
    // the right balance by coincidence.
    const draws = Array.from({ length: 1001 }, () => ({
      type: "expense",
      amount_sen: 1,
      account_id: bank,
      category_id: null,
      date: "2077-08-20",
      note: "Paging draw",
      fund_id: probe,
    }));
    const tRes = await a.from("transactions").insert(draws);
    if (tRes.error) throw tRes.error;

    const data = await getFunds(a, TODAY);
    const row = data.funds.find((f) => f.id === probe)!;
    // Truncating EITHER read moves this number: 1001 × 7 − 1001 × 1.
    expect(row.balance_sen).toBe(6_006);
    expect(data.drawn_this_month.filter((d) => d.fund_id === probe)).toHaveLength(1001);
  }, 60_000);

  it("stays correct when the requested page size EXCEEDS the server's cap", async () => {
    // The requested size is only a hint: a hosted project whose `Max rows` is
    // set below it caps every page, and a loop that reads "short page" as
    // "last page" would stop at the first one and under-read — green locally,
    // silently wrong in production. 1500 against the server's 1000 is that
    // case, and the answer must not move by one sen.
    const probe = (await a.from("funds").select("id").eq("name", "Paging probe").single()).data!.id;
    const data = await getFunds(a, TODAY, 1500);
    expect(data.funds.find((f) => f.id === probe)!.balance_sen).toBe(6_006);
    expect(data.drawn_this_month.filter((d) => d.fund_id === probe)).toHaveLength(1001);
  }, 60_000);
});

describe("RLS isolation", () => {
  it("user B sees no funds, no accounts total and an unplanned month", async () => {
    const data = await getFunds(b, TODAY);
    expect(data.funds).toHaveLength(0);
    expect(data.archived_funds).toHaveLength(0);
    expect(data.archived_count).toBe(0);
    expect(data.total_saved_sen).toBe(0);
    expect(data.myr_accounts_total_sen).toBe(0);
    expect(data.month_planned).toBe(false);
    expect(data.envelope_sen).toBe(0);
    expect(data.avg_monthly_expense_sen).toBe(0);
    expect(data.avg_monthly_fund_paid_expense_sen).toBe(0);
    expect(data.drawn_this_month).toHaveLength(0);
    expect(data.waterfall.steps.map((s) => s.planned_sen)).toEqual([0, 0, 0, 0]);
  });
});

describe("avgMonthlyFundPaidExpenseSen — ruling 3's coupling disclosure (F3, Task 3 review)", () => {
  // Own isolated fixture (fresh makeTestUsers(), not the fixture above) —
  // this is testing a window/divisor identity against avgMonthlyExpenseSen,
  // so it needs full control over exactly what falls inside the trailing
  // 6-full-calendar-month window ending the month BEFORE `today`.
  let c: SupabaseClient;
  let d: SupabaseClient;
  let e: SupabaseClient;
  const TODAY2 = "2077-11-19";

  beforeAll(async () => {
    ({ a: c, b: d } = await makeTestUsers());
    ({ a: e } = await makeTestUsers());

    const mkAccount = async (client: SupabaseClient, name: string) => {
      const res = await client.from("accounts").insert({ name, type: "bank", starting_balance_sen: 1_000_000 }).select().single();
      if (res.error) throw res.error;
      return res.data.id as string;
    };
    const mkFund = async (client: SupabaseClient, name: string) => {
      const res = await client
        .from("funds")
        .insert({ name, kind: "sinking", monthly_contribution_sen: 0, priority: 0 })
        .select()
        .single();
      if (res.error) throw res.error;
      return res.data.id as string;
    };

    // User C: a nonzero fund-paid share, PLUS a fund-tagged expense in the
    // current (in-progress) month — proving the window excludes it, since
    // including it (99_900 sen) would move the answer far from 3_500.
    const bankC = await mkAccount(c, "Bank C");
    const fundC = await mkFund(c, "Probe fund C");
    const txC = await c.from("transactions").insert([
      { type: "expense", amount_sen: 10_000, account_id: bankC, category_id: null, date: "2077-09-05", note: "Sep untagged", fund_id: null },
      { type: "expense", amount_sen: 5_000, account_id: bankC, category_id: null, date: "2077-09-10", note: "Sep tagged", fund_id: fundC },
      { type: "expense", amount_sen: 8_000, account_id: bankC, category_id: null, date: "2077-10-05", note: "Oct untagged", fund_id: null },
      { type: "expense", amount_sen: 2_000, account_id: bankC, category_id: null, date: "2077-10-10", note: "Oct tagged", fund_id: fundC },
      { type: "expense", amount_sen: 99_900, account_id: bankC, category_id: null, date: "2077-11-05", note: "Nov tagged — current month, must be excluded", fund_id: fundC },
    ]);
    if (txC.error) throw txC.error;

    // User D: a nonzero average with a genuinely ZERO fund-paid share —
    // some spending exists in the window, none of it fund-tagged.
    const bankD = await mkAccount(d, "Bank D");
    const txD = await d.from("transactions").insert([
      { type: "expense", amount_sen: 10_000, account_id: bankD, category_id: null, date: "2077-09-05", note: "Sep untagged", fund_id: null },
      { type: "expense", amount_sen: 8_000, account_id: bankD, category_id: null, date: "2077-10-05", note: "Oct untagged", fund_id: null },
    ]);
    if (txD.error) throw txD.error;

    // User E (R2-1, Task 3 review round 2): a non-MYR fund-tagged expense
    // must be excluded from the numerator exactly like getIncomeVsExpense
    // already excludes it from the denominator — ruling 8 is meant to keep
    // this combination from ever existing via the app, but this DB read has
    // no visibility into that guard, so the fixture inserts it directly
    // (bypassing the app layer on purpose) to prove the read itself is safe
    // regardless. One MYR untagged expense defines a real average; one much
    // larger USD fund-tagged expense, wrongly summed at face value, would
    // read as a share nine times its own average (the review's own
    // reproduction) — RM 450.00 of "that" out of an RM 50.00 average.
    const bankE = await mkAccount(e, "Bank E");
    const cardE = await e.from("accounts").insert({ name: "Card E", type: "bank", currency: "USD", starting_balance_sen: 1_000_000 }).select().single();
    if (cardE.error) throw cardE.error;
    const fundE = await mkFund(e, "Probe fund E");
    const txE = await e.from("transactions").insert([
      { type: "expense", amount_sen: 5_000, account_id: bankE, category_id: null, date: "2077-09-05", note: "MYR untagged", fund_id: null },
      { type: "expense", amount_sen: 45_000, account_id: cardE.data.id, category_id: null, date: "2077-09-10", note: "USD tagged — must be excluded", fund_id: fundE },
    ]);
    if (txE.error) throw txE.error;
  }, 30_000);

  it("sums only the fund-tagged share, over the SAME window and divisor as avgMonthlyExpenseSen — the current month excluded", async () => {
    const data = await getFunds(c, TODAY2);
    // Window: May–Oct (6 full months ending Oct, Nov excluded as in-progress).
    // Divisor: 2 (only Sep and Oct are at/after the earliest transaction's
    // month) — the SAME divisor both figures below share.
    expect(data.avg_monthly_expense_sen).toBe(12_500); // (10_000+5_000+8_000+2_000) / 2
    expect(data.avg_monthly_fund_paid_expense_sen).toBe(3_500); // (5_000+2_000) / 2 — Nov's 99_900 excluded
  });

  it("is exactly 0 when the window's spending has nothing fund-tagged (a real average, a zero share)", async () => {
    const data = await getFunds(d, TODAY2);
    expect(data.avg_monthly_expense_sen).toBe(9_000); // (10_000+8_000) / 2 — a real, nonzero average
    expect(data.avg_monthly_fund_paid_expense_sen).toBe(0);
  });

  it("excludes a non-MYR fund-tagged expense from the numerator (R2-1) — the SAME filter the denominator already applies", async () => {
    const data = await getFunds(e, TODAY2);
    // Divisor 2 (Sep and Oct — same window/divisor rule the C/D cases above
    // pin; earliest transaction is Sep 5, so both Sep and Oct count even
    // though Oct itself has no spending).
    expect(data.avg_monthly_expense_sen).toBe(2_500); // 5_000 MYR / 2 — the USD row is invisible here too
    // Without the fix this would be 22_500 (the 45_000 USD row summed at
    // face value, divided by the same divisor) — a share nine times its own
    // average, US cents divided into a ringgit figure.
    expect(data.avg_monthly_fund_paid_expense_sen).toBe(0);
  });
});

/**
 * Session-12 Minor 4: this module's private divHalfUp copy claimed
 * byte-identity with src/db/networth.ts's while lacking the negative-half
 * correction (half toward +∞ instead of half away from zero). The same
 * negative-half pin the other copies carry (src/lib/portfolio.test.ts's
 * centToSen: 1.5 → 2, −1.5 → −2), duplicated here.
 */
describe("divHalfUp — half up, half away from zero (Minor 4)", () => {
  it("rounds a positive half up", () => {
    expect(divHalfUp(3, 2)).toBe(2); // 1.5 → 2
    expect(divHalfUp(9, 2)).toBe(5); // 4.5 → 5
    expect(divHalfUp(7, 3)).toBe(2); // 2.33 → 2
  });

  it("rounds a negative half AWAY from zero — symmetric with the positive rule", () => {
    expect(divHalfUp(-3, 2)).toBe(-2); // −1.5 → −2
    expect(divHalfUp(-9, 2)).toBe(-5); // −4.5 → −5
    expect(divHalfUp(-7, 3)).toBe(-2); // −2.33 → −2
    expect(divHalfUp(-1, 2)).toBe(-1); // −0.5 → −1
  });
});
