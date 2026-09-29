import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DebtPayoffCard } from "@/components/DebtPayoffCard";
import { TipsProvider } from "@/components/Tip";
import { projectPayoff, requiredToProgressSen, monthLabel } from "@/lib/debt";
import { formatSen } from "@/lib/money";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";
import type { LiabilityListRow } from "@/db/networth";

/**
 * Plan 8 ruling 9/10 renderings — markup-level, the house's Sidebar shape
 * (no DOM environment): the two no-date states carry their DISTINCT copy in
 * the critical colour, a rate-less liability asks for a planned payment, and
 * tips-off keeps every figure (ruling 23 carried). The what-if input's
 * arithmetic is the lib's (debt.test.ts); its presence is pinned here.
 */
const TODAY = "2077-06-15";

function row(over: Partial<LiabilityListRow> & { name: string }): LiabilityListRow {
  const base: LiabilityListRow = {
    id: `id-${over.name}`,
    name: over.name,
    kind: "loan",
    archived: false,
    interest_rate_bp: 0,
    minimum_payment_sen: 0,
    planned_payment_sen: 0,
    balance_sen: 0,
    noted_on: "2077-06-01",
    last_payment_category_id: null,
    first_recorded: null,
    payment_rate_sen: null,
    projection: null,
  };
  return { ...base, ...over };
}

// On track: RM 1,000 at 1200 bp, RM 345/mo → 3 months (debt.test.ts's hand run).
const loan = row({
  name: "T4 Loan",
  interest_rate_bp: 1_200,
  minimum_payment_sen: 30_000,
  planned_payment_sen: 34_500,
  balance_sen: 100_000,
  first_recorded: { balance_sen: 160_000, noted_on: "2077-02-10" },
  payment_rate_sen: 34_500,
  projection: projectPayoff(100_000, 1_200, 34_500, TODAY),
});
// Never: the payment equals the first month's interest.
const card = row({
  name: "T4 Card",
  interest_rate_bp: 1_200,
  minimum_payment_sen: 1_000,
  balance_sen: 100_000,
  first_recorded: { balance_sen: 100_000, noted_on: "2077-05-01" },
  payment_rate_sen: 1_000,
  projection: projectPayoff(100_000, 1_200, 1_000, TODAY),
});
// Beyond the horizon: interest + 1 sen.
const slow = row({
  name: "T4 Slow",
  interest_rate_bp: 1_200,
  planned_payment_sen: 1_001,
  balance_sen: 100_000,
  first_recorded: { balance_sen: 100_000, noted_on: "2077-05-01" },
  payment_rate_sen: 1_001,
  projection: projectPayoff(100_000, 1_200, 1_001, TODAY),
});
// No payment rate at all.
const bare = row({
  name: "T4 Bare",
  interest_rate_bp: 350,
  balance_sen: 12_300,
  first_recorded: { balance_sen: 20_000, noted_on: "2077-01-01" },
});

const rows = [loan, card, slow, bare];
const html = renderToStaticMarkup(createElement(DebtPayoffCard, { rows, todayIso: TODAY }));
const required = requiredToProgressSen(100_000, 1_200);
// Ruling 9: both no-date states print the SAME figure with the SAME label —
// the smallest payment that clears the balance inside the cap, and its month.
const by = monthLabel(projectPayoff(100_000, 1_200, required, TODAY).payoff_month!);
const CRIT = 'style="color:var(--critical)"';

describe("DebtPayoffCard — the four row states", () => {
  it("on track: payoff month, months, interest to go, progress against the first recorded balance", () => {
    expect(html).toContain("Sep 2077");
    expect(html).toContain("3 months");
    expect(html).toContain(formatSen(1_992)); // total interest
    expect(html).toContain("RM 345.00/mo");
    // 1 − 100_000 / 160_000 = 37.5% → 38 (half up)
    expect(html).toContain(`38% · of ${formatSen(160_000)} when tracking began (Feb 2077)`);
    expect(html).toContain('width:38%');
  });

  it("never: distinct copy in the critical colour, with the payment that clears it and its month", () => {
    expect(html).toContain(`${CRIT}>never at this rate<`);
    // Desktop + mobile, for the never row AND the beyond row: four times.
    expect(html.split(`${formatSen(required)}/mo would clear it by ${by}`)).toHaveLength(5);
    expect(html).not.toContain("would start reducing it");
  });

  it("beyond the horizon: distinct copy in the critical colour, with the payment that clears it and its month", () => {
    expect(html).toContain(`${CRIT}>more than 50 years at this rate<`);
    expect(html).toContain(`${formatSen(required)}/mo would clear it by ${by}`);
  });

  it("no rate: asks for a planned payment; keeps balance and progress; never says `never`", () => {
    expect(html).toContain("set a planned payment to see a payoff date");
    expect(html).toContain(formatSen(12_300));
    // 1 − 12_300 / 20_000 = 38.5% → 39
    expect(html).toContain(`39% · of ${formatSen(20_000)} when tracking began (Jan 2077)`);
    // Desktop says "never at this rate" (§11), mobile "never at RM x/mo" (§13) — the card row only.
    expect(html.match(/never at this rate/g)).toHaveLength(1);
    expect(html).toContain("never at RM 10.00/mo · ");
    expect(html).toContain("more than 50 years at RM 10.01/mo · ");
  });

  it("cleared with no payment rate: reads as paid off, never asked for a planned payment", () => {
    const cleared = row({ name: "T4 Cleared", balance_sen: 0, first_recorded: { balance_sen: 50_000, noted_on: "2077-01-01" } });
    const out = renderToStaticMarkup(createElement(DebtPayoffCard, { rows: [cleared], todayIso: TODAY }));
    expect(out).toContain("paid off");
    expect(out).not.toContain("set a planned payment to see a payoff date");
  });

  it("carries the extra-per-month what-if input and the mockup's column heads", () => {
    expect(html).toContain("Extra per month");
    for (const head of ["Liability", "Payoff", "Interest to go", "Progress"]) expect(html).toContain(`>${head}<`);
  });
});

describe("DebtPayoffCard — tips off keeps every figure (ruling 23 carried)", () => {
  // createElement's typing wants `children` inside props for a component
  // that declares them required; the lint rule wants them as an argument.
  const off = renderToStaticMarkup(
    createElement(
      TipsProvider,
      { showTips: false } as Parameters<typeof TipsProvider>[0],
      createElement(DebtPayoffCard, { rows, todayIso: TODAY }),
    ),
  );

  it("balance, payoff month, months, interest, progress and both no-date states stay; the explanations go", () => {
    expect(off).toContain(formatSen(100_000));
    expect(off).toContain("Sep 2077");
    expect(off).toContain("3 months");
    expect(off).toContain(formatSen(1_992));
    expect(off).toContain(`38% · of ${formatSen(160_000)} when tracking began (Feb 2077)`);
    expect(off).toContain("never at this rate");
    expect(off).toContain("more than 50 years at this rate");
    expect(off).toContain("set a planned payment to see a payoff date");
    expect(off).not.toContain("nothing here moves your net worth");
    expect(off).not.toContain("nothing is saved");
    expect(html).toContain("nothing here moves your net worth");
    expect(html).toContain("nothing is saved");
  });
});

describe("DebtPayoffCard — amounts hidden (Plan 9 Task 3a)", () => {
  const masked = renderMasked(createElement(DebtPayoffCard, { rows, todayIso: TODAY }));
  const bare = (sen: number) => formatSen(sen).replace("RM ", "");
  // Balances, payments, interest (to go and this month), the first recorded
  // balances and the no-date states' required payment.
  const SEEDED = [100_000, 1_992, 34_500, 160_000, 1_000, 1_001, 12_300, 20_000, required].map(bare);

  it("every figure masks; months, %, the state copy and the extra-per-month input stay", () => {
    expect(masked).toContain("Sep 2077");
    expect(masked).toContain("3 months");
    expect(masked).toContain(`38% · of ${MASKED_MYR} when tracking began (Feb 2077)`);
    expect(masked).toContain(`${MASKED_MYR}/mo would clear it by ${by}`);
    expect(masked).toContain(`never at ${MASKED_MYR}/mo · `);
    expect(masked).toContain(`${CRIT}>never at this rate<`);
    expect(masked).toContain('aria-label="Extra per month (RM)"');
    assertNoMoney(masked, SEEDED);
  });
});
