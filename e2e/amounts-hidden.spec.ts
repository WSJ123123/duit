import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { klToday } from "../src/lib/kl-date";
import { formatSen } from "../src/lib/money";
import { getTodayTotal } from "../src/db/stats";
import {
  collectMoneySurfaces,
  describeFindings,
  findMoney,
  isClean,
  surfacesFromMarkup,
  PREFIXED_MONEY_RE,
  type MoneyFindings,
} from "../src/test/no-money";

/**
 * Plan 9 ruling 6 — THE PROOF. Every `(app)` route, at 1280 px and 390 px:
 *   (a) without the cookie, money IS on screen (the positive control — the
 *       walk can fail) and the route's seeded figure is among it;
 *   (b) with `duit_amounts=hidden`, NO money grammar (prefixed or bare)
 *       survives in the visible-tree text or in any attribute, and none of
 *       the seeded values appear — the three rules of `src/test/no-money.ts`;
 *   (c) `/dashboard` with the cookie and JavaScript DISABLED already reads
 *       masked — the no-flash proof at first paint.
 *
 * The route list is DERIVED from `src/app/(app)/** /page.tsx`, its count
 * pinned, its exclusions a reason-stated literal list — a new page cannot
 * escape the walk.
 *
 * Written red first against the unswept tree, then un-skipped green once
 * every route masked.
 */

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.test" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// The same local-stack-only credential quick-entry.spec.ts documents.
const TEST_EMAIL = "e2e@test.local";
const TEST_PASSWORD = "test-password-123!";

const WIDTHS = [
  { name: "1280", viewport: { width: 1280, height: 800 } },
  { name: "390", viewport: { width: 390, height: 844 } },
] as const;

// ---------------------------------------------------------------- routes

const APP_DIR = join(__dirname, "..", "src", "app", "(app)");

function deriveRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") routes.push("/" + relative(APP_DIR, dir).split("\\").join("/"));
    }
  };
  walk(APP_DIR);
  return routes.sort();
}

/** Pinned: every `(app)` page today. A new page changes this and must be placed. */
const ROUTE_COUNT = 17;

/** Excluded from BOTH assertions, with the reason. */
const EXCLUDED_FROM_BOTH: Record<string, string> = {
  "/onboarding":
    "multi-step wizard whose figure-bearing steps need interaction; its two text figures (OnboardingWizard.tsx) are swept in Task 3 and pinned by that component's masked-state test",
};

/** Excluded from the POSITIVE CONTROL only (no figure on them by design); still under the masked assertion. */
const EXCLUDED_FROM_POSITIVE: Record<string, string> = {
  "/transactions/import": "the import wizard's first screen carries no figure",
  "/settings/aliases": "parser aliases carry no figure",
  "/settings/categories": "categories carry no figure",
  "/settings/shortcut": "the Shortcut setup carries no figure",
  // Task 1 red run: the Settings INDEX prints counts, never a figure
  // (settings/page.tsx is not among the census's 32 formatter files).
  "/settings": "the Settings index shows counts, not figures",
};

// ---------------------------------------------------------------- seeds

/** Distinctive figures, and PER ROUTE the row that supplies its figure. */
const SEED = {
  account: { name: "E2E Amounts Bank", startingSen: 123_456, figure: "1,234.56" },
  expense: { note: "e2e amounts-hidden expense", sen: 8_765, figure: "87.65" },
  allocation: { sen: 54_321, figure: "543.21" },
  fund: { name: "E2E Amounts Fund", contributionSen: 21_098, figure: "210.98" },
  liability: { name: "E2E Amounts Loan", balanceSen: 3_840_000, plannedSen: 85_000, figure: "38,400.00", plannedFigure: "850.00" },
  rule: { name: "E2E Amounts Bill", sen: 18_000, figure: "180.00" },
} as const;

const SEEDED_VALUES = [
  SEED.account.figure,
  SEED.expense.figure,
  SEED.allocation.figure,
  SEED.fund.figure,
  SEED.liability.figure,
  SEED.liability.plannedFigure,
  SEED.rule.figure,
];

/** Which seeded row each walked route shows (positive control: at least one of these). */
const ROUTE_FIGURES: Record<string, { from: string; values: readonly string[] }> = {
  "/dashboard": { from: "the KL-today expense (recent rows) / the due bill", values: [SEED.expense.figure, SEED.rule.figure] },
  "/transactions": { from: "the KL-today expense", values: [SEED.expense.figure] },
  "/quick": { from: "the KL-today expense (Today line / recent rows)", values: [SEED.expense.figure] },
  "/budget": { from: "the budget allocation", values: [SEED.allocation.figure] },
  "/goals": { from: "the fund contribution", values: [SEED.fund.figure] },
  "/net-worth": { from: "the account balance / the liability balance and planned payment", values: [SEED.account.figure, SEED.liability.figure, SEED.liability.plannedFigure] },
  "/bills": { from: "the recurring rule due inside the window", values: [SEED.rule.figure] },
  "/settings/recurring": { from: "the recurring rule's amount", values: [SEED.rule.figure] },
  "/settings/accounts": { from: "the account balance", values: [SEED.account.figure] },
  "/more": { from: "the summaries (net worth, goals, bills)", values: [SEED.fund.figure, SEED.rule.figure, SEED.account.figure] },
  "/investments": { from: "the page's own RM 0.00 total — no seed (the plan)", values: ["0.00"] },
};

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function ensureRow(
  client: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>,
): Promise<string> {
  let q = client.from(table).select("id");
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
  const { data: existing, error: findErr } = await q.limit(1).maybeSingle();
  if (findErr) throw findErr;
  if (existing) return (existing as { id: string }).id;
  const { data: created, error: insertErr } = await client.from(table).insert({ ...match, ...insert }).select("id").single();
  if (insertErr) throw insertErr;
  return (created as { id: string }).id;
}

/**
 * Controller decision Q42: `/quick`'s positive control reads its figure off
 * the `Today` line, the SUM of every KL-today expense — other suites
 * (`quick-entry.spec.ts`) add KL-today rows, so after seeding the walk reads
 * that live total the way the page does (`getTodayTotal`, same client) and
 * accepts its formatted value alongside 87.65. The masked assertion's seeded
 * list is unchanged. Returns the figure without its `RM ` prefix.
 */
async function seed(): Promise<string> {
  const admin = adminClient();
  const { error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr && !/already been registered/i.test(createErr.message)) throw createErr;

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: signInErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  if (signInErr) throw signInErr;

  const today = klToday(new Date());
  const month = `${today.slice(0, 7)}-01`;
  const dayOfMonth = Number(today.slice(8, 10));

  const { error: seedErr } = await anon.rpc("seed_default_categories");
  if (seedErr) throw seedErr;
  const { data: food, error: foodErr } = await anon
    .from("categories")
    .select("id")
    .eq("name", "Food")
    .is("parent_id", null)
    .limit(1)
    .single();
  if (foodErr) throw foodErr;
  const foodId = (food as { id: string }).id;

  // A MYR account with a starting balance and NO transactions, so its balance
  // is the seeded figure (/settings/accounts, /net-worth, /more).
  await ensureRow(
    anon,
    "accounts",
    { name: SEED.account.name },
    { type: "bank", currency: "MYR", starting_balance_sen: SEED.account.startingSen },
  );
  // The expense lives on the quick-entry fixture account so the seeded
  // balance above stays intact.
  const maybankId = await ensureRow(anon, "accounts", { name: "Maybank" }, { type: "bank" });

  const { error: settingsErr } = await anon
    .from("user_settings")
    .upsert({ default_account_id: maybankId, onboarded_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (settingsErr) throw settingsErr;

  // One expense dated KL-today (/quick's Today line, /transactions, /dashboard).
  await ensureRow(
    anon,
    "transactions",
    { note: SEED.expense.note, date: today },
    { type: "expense", amount_sen: SEED.expense.sen, account_id: maybankId, category_id: foodId, source: "manual" },
  );

  // One budget allocation this month (/budget).
  const { error: monthErr } = await anon
    .from("budget_months")
    .upsert({ month, expected_income_sen: 500_000 }, { onConflict: "user_id,month" });
  if (monthErr) throw monthErr;
  const { error: allocErr } = await anon
    .from("budget_allocations")
    .upsert(
      { month, category_id: foodId, planned_sen: SEED.allocation.sen, allocated_sen: SEED.allocation.sen },
      { onConflict: "user_id,month,category_id" },
    );
  if (allocErr) throw allocErr;

  // One fund with a contribution this month (/goals).
  const fundId = await ensureRow(
    anon,
    "funds",
    { name: SEED.fund.name },
    { kind: "sinking", target_sen: 1_000_000, monthly_contribution_sen: SEED.fund.contributionSen },
  );
  const { error: contribErr } = await anon
    .from("fund_contributions")
    .upsert({ fund_id: fundId, month, amount_sen: SEED.fund.contributionSen }, { onConflict: "user_id,fund_id,month" });
  if (contribErr) throw contribErr;

  // One liability with a balance and a planned payment (/net-worth debt payoff).
  const liabilityId = await ensureRow(
    anon,
    "liabilities",
    { name: SEED.liability.name },
    { kind: "loan", interest_rate_bp: 500, planned_payment_sen: SEED.liability.plannedSen },
  );
  const { error: valErr } = await anon
    .from("liability_values")
    .upsert(
      { liability_id: liabilityId, balance_sen: SEED.liability.balanceSen, noted_on: today },
      { onConflict: "user_id,liability_id,noted_on" },
    );
  if (valErr) throw valErr;

  // One active recurring rule due today (/bills, /settings/recurring).
  const ruleId = await ensureRow(
    anon,
    "recurring_rules",
    { name: SEED.rule.name },
    {
      type: "expense",
      amount_sen: SEED.rule.sen,
      account_id: maybankId,
      category_id: foodId,
      freq: "monthly",
      day_of_month: dayOfMonth,
      next_run: today,
    },
  );
  const { error: ruleErr } = await anon
    .from("recurring_rules")
    .update({ next_run: today, day_of_month: dayOfMonth, active: true })
    .eq("id", ruleId);
  if (ruleErr) throw ruleErr;

  return formatSen(await getTodayTotal(anon, today)).replace(/^RM /, "");
}

// ---------------------------------------------------------------- the walk

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/transactions/);
}

/** Navigate and wait for the route's Suspense skeleton (loading.tsx) to be swapped out. */
async function open(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "load" });
  await page.waitForFunction(() => !document.querySelector("main .animate-pulse"), null, { timeout: 60_000 });
}

async function surfacesOf(page: Page) {
  const body = await page.locator("body").elementHandle();
  return page.evaluate(collectMoneySurfaces, body!);
}

const HIDDEN_COOKIE = { name: "duit_amounts", value: "hidden", domain: "localhost", path: "/" };

// Un-skipped green in Task 3 Step 6 (Task 3b), after the sweep.
test.describe("amounts hidden — the route walk", () => {
  // One test walks every route at both widths on a dev server: give it room.
  // Not `serial`: a red positive control must not skip the masked walk.
  test.describe.configure({ timeout: 600_000 });

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let routes: string[] = [];
  let quickTodayFigure = "";

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    quickTodayFigure = await seed();
    routes = deriveRoutes();
    context = await browser.newContext();
    page = await context.newPage();
    await signIn(page);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("the route list is derived from src/app/(app), has no dynamic segment, and is fully placed", () => {
    expect(routes.some((r) => r.includes("["))).toBe(false);
    expect(routes.length).toBe(ROUTE_COUNT);
    const placed = new Set([
      ...Object.keys(EXCLUDED_FROM_BOTH),
      ...Object.keys(EXCLUDED_FROM_POSITIVE),
      ...Object.keys(ROUTE_FIGURES),
    ]);
    for (const r of routes) expect(placed.has(r), `route ${r} is neither walked nor excluded`).toBe(true);
    for (const r of placed) expect(routes, `placed route ${r} no longer exists`).toContain(r);
  });

  test("positive control: without the cookie, money is on screen at both widths", async () => {
    await context.clearCookies({ name: HIDDEN_COOKIE.name });
    const failures: string[] = [];
    const walked = routes.filter((r) => !(r in EXCLUDED_FROM_BOTH) && !(r in EXCLUDED_FROM_POSITIVE));
    for (const width of WIDTHS) {
      await page.setViewportSize(width.viewport);
      for (const route of walked) {
        await open(page, route);
        const text = await page.evaluate(() => document.body.innerText);
        const prefixed = text.match(PREFIXED_MONEY_RE) ?? [];
        const base = ROUTE_FIGURES[route]!;
        const expected =
          route === "/quick"
            ? { from: `${base.from} / today's live total ${quickTodayFigure} (Q42)`, values: [...base.values, quickTodayFigure] }
            : base;
        const hasSeed = expected.values.some((v) => text.includes(v));
        console.log(`[positive ${width.name}] ${route}: prefixed=${prefixed.length} seeded=${hasSeed} (${expected.from})`);
        if (prefixed.length === 0) failures.push(`${route}@${width.name}: no prefixed figure`);
        if (!hasSeed) failures.push(`${route}@${width.name}: none of ${expected.values.join(" / ")} (${expected.from})`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("masked: with the cookie, no money grammar survives at both widths", async () => {
    await context.addCookies([HIDDEN_COOKIE]);
    const failures: string[] = [];
    const walked = routes.filter((r) => !(r in EXCLUDED_FROM_BOTH));
    for (const width of WIDTHS) {
      await page.setViewportSize(width.viewport);
      for (const route of walked) {
        await open(page, route);
        const findings: MoneyFindings = findMoney(await surfacesOf(page), SEEDED_VALUES);
        console.log(
          `[masked ${width.name}] ${route}: prefixed=${findings.prefixed.length} bare=${findings.bare.length} attrs=${findings.attrs.length} seeded=${findings.seeded.length}`,
        );
        if (!isClean(findings)) failures.push(`${route}@${width.name}: ${describeFindings(findings)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // Owner ruling Q41 ("Pad the headers"): the phone's fixed eye keeps ruling
  // 5's placement, and no page control may sit under it — EVERY route at
  // 390 px, eye's box vs every visible interactive element. `/onboarding` is
  // walked here too (final review A, I1): its exclusion above is about
  // figures, not layout, and its header only needs a visit, not the steps.
  test("mobile eye: at 390 px it covers no interactive element on any route", async () => {
    await context.clearCookies({ name: HIDDEN_COOKIE.name });
    await page.setViewportSize(WIDTHS[1].viewport);
    const failures: string[] = [];
    for (const route of routes) {
      await open(page, route);
      const hits = await page.evaluate(() => {
        const eye = document.querySelector('button[aria-label="Hide amounts"], button[aria-label="Show amounts"]');
        if (!eye) return ["no eye button"];
        const e = eye.getBoundingClientRect();
        const out: string[] = [];
        for (const el of document.querySelectorAll('button, a, input, select, [role="tab"]')) {
          if (el === eye || eye.contains(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > e.left && r.left < e.right && r.bottom > e.top && r.top < e.bottom) {
            out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        return out;
      });
      console.log(`[eye 390] ${route}: ${hits.length === 0 ? "clear" : hits.join(" | ")}`);
      if (hits.length > 0) failures.push(`${route}: ${hits.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("no-flash: /dashboard with the cookie and JavaScript disabled already reads masked", async () => {
    const state = await context.storageState();
    const noJs = await browser.newContext({
      storageState: state,
      javaScriptEnabled: false,
      viewport: WIDTHS[0].viewport,
    });
    await noJs.addCookies([HIDDEN_COOKIE]);
    const p = await noJs.newPage();
    await p.goto("/dashboard");
    const html = await p.content();
    const findings = findMoney(surfacesFromMarkup(html), SEEDED_VALUES);
    console.log(
      `[no-js 1280] /dashboard: prefixed=${findings.prefixed.length} bare=${findings.bare.length} attrs=${findings.attrs.length} seeded=${findings.seeded.length}`,
    );
    await noJs.close();
    expect(html).toContain("RM ••••");
    expect(isClean(findings), describeFindings(findings)).toBe(true);
  });
});
