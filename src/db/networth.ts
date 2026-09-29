import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  businessStats,
  latestValues,
  netWorthTotal,
  deltaVsPrevMonth,
  accountsTotalMyrSen,
  type NetWorthParts,
} from "@/lib/networth";
import {
  PRESET_DEFAULTS,
  defaultBucket,
  potBuckets,
  type Bucket,
  type PresetKey,
} from "@/lib/allocation";
import { priceIsStale } from "@/lib/portfolio";
import { loadPortfolioValuation, isListedHolding } from "@/db/portfolio";
import { getAccountsWithBalances } from "@/db/queries";
import { getIncomeVsExpense } from "@/db/stats";
import { formatSen } from "@/lib/money";
import { paymentRateSen, projectPayoff, type PayoffProjection } from "@/lib/debt";

/**
 * Net worth + allocation query layer and write helpers (Plan 5 Task 5).
 * Everything runs under the caller's RLS session client and composes the
 * SAME pure libs as the snapshot cron (src/db/snapshots.ts) under the same
 * rules — parts sum ALL accounts archived included (ruling 9), non-archived
 * holdings/items only, missing price/FX contributes 0, liabilities positive
 * — so pages and cron can never disagree.
 *
 * Local conventions (documented decisions):
 * - Lists are split per group into non-archived rows plus a SEPARATE archived
 *   list, and the page renders the archived one behind an `Archived (n)`
 *   disclosure (Plan 7 ruling 14). The old value-conditioned visibility filter
 *   (`!archived || value !== 0`) is gone: it made a zero-valued archived item
 *   unreachable forever — the exact trap Plan 6 had to close for holdings.
 *   Parts never count archived items (matching the cron).
 * - An item with no value history yet lists value 0 and noted_on "".
 * - price_staleness covers the fetched prices and FX rows actually used by
 *   open, non-archived positions (manual prices are never stale, ruling 11).
 * - Ruling-6 prefill: recordLiabilityPayment stamps the expense note
 *   "<liability name> payment"; last_payment_category_id is the category of
 *   the newest expense carrying that note (renaming the liability simply
 *   resets the prefill to null — no schema link exists by design).
 * - The allocation pot reads non-archived accounts only, and its equities
 *   holdings total is the Investments page's listed-rows total, so the two
 *   views agree by construction (ruling 19).
 */

export interface AccountListRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  archived: boolean;
  balance_sen: number;
}

export interface ManualAssetListRow {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
  value_sen: number;
  noted_on: string;
}

export interface LiabilityListRow {
  id: string;
  name: string;
  kind: string;
  archived: boolean;
  interest_rate_bp: number;
  minimum_payment_sen: number;
  /** Plan 8 ruling 9: the payoff plan's per-debt payment; 0 = none set. */
  planned_payment_sen: number;
  balance_sen: number;
  noted_on: string;
  last_payment_category_id: string | null;
  /** The EARLIEST liability_values row — payoff progress is measured against
   *  it ("of RM x when tracking began") because no original principal was
   *  ever stored; null before any balance is recorded. */
  first_recorded: { balance_sen: number; noted_on: string } | null;
  /** Ruling 9 precedence: planned > minimum > null (never a fabricated rate). */
  payment_rate_sen: number | null;
  /** projectPayoff(latest balance, rate, payment rate, todayIso) — the Debt
   *  payoff card's initial render; null with no payment rate, no balance
   *  yet, or archived (nothing renders it). Derived only: nothing is stored
   *  and no part moves (ruling 9). */
  projection: PayoffProjection | null;
}

export interface BusinessListRow {
  id: string;
  name: string;
  note: string;
  archived: boolean;
  invested_sen: number;
  returned_sen: number;
  value_sen: number;
  /** Date of the latest valuation entry (businessStats's tie-break: max
   *  date, created_at breaks ties) — null when value_sen is at cost. */
  valued_on: string | null;
  entries: Array<{
    id: string;
    kind: "contribution" | "return" | "valuation";
    amount_sen: number;
    account_id: string | null;
    account_name: string | null;
    date: string;
    note: string;
  }>;
}

export interface NetWorthData {
  parts: NetWorthParts;
  delta_vs_prev_month_sen: number | null;
  snapshots: Array<{ date: string; total_sen: number }>;
  /** balance_sen is native minor units of `currency` (Task 5) — rows render
   *  the native amount with its code; parts.accounts_sen is the MYR sum.
   *  NON-ARCHIVED only; archived ones are in `archived_accounts` (ruling 14). */
  accounts: AccountListRow[];
  /** Account currencies with NO fx_rates row yet (never fetched — possible
   *  only between account creation and the next cron): those balances are
   *  EXCLUDED from parts.accounts_sen; the page shows a warn line until the
   *  rate lands (ruled: honest gap beats a fabricated rate). */
  fx_missing: string[];
  manual_assets: ManualAssetListRow[];
  liabilities: LiabilityListRow[];
  businesses: BusinessListRow[];
  /**
   * Ruling 14: every archived row of each group, whatever its value — the
   * page renders each behind its own collapsed `Archived (n)` disclosure.
   * None of these ever enters `parts` (the cron excludes archived items, and
   * the two compositions must not diverge — see networth-parity.test.ts).
   */
  archived_accounts: AccountListRow[];
  archived_manual_assets: ManualAssetListRow[];
  archived_liabilities: LiabilityListRow[];
  archived_businesses: BusinessListRow[];
  price_staleness: { any_stale: boolean; oldest_as_of: string | null };
}

interface HistoryRow {
  item_id: string;
  value_sen: number;
  noted_on: string;
  created_at: string;
}

/** Latest ROW per item for display noted_on — same ordering rule as the
 *  lib's latestValues (max noted_on, created_at tie-break, first-seen wins),
 *  which remains the source for the part sums. */
function latestRowByItem(rows: HistoryRow[]): Map<string, HistoryRow> {
  const best = new Map<string, HistoryRow>();
  for (const r of rows) {
    const cur = best.get(r.item_id);
    if (
      !cur ||
      r.noted_on > cur.noted_on ||
      (r.noted_on === cur.noted_on && r.created_at > cur.created_at)
    ) {
      best.set(r.item_id, r);
    }
  }
  return best;
}

/** Earliest ROW per item — latestRowByItem's mirror (min noted_on,
 *  created_at breaks ties) — the payoff card's "when tracking began". */
function firstRowByItem(rows: HistoryRow[]): Map<string, HistoryRow> {
  const best = new Map<string, HistoryRow>();
  for (const r of rows) {
    const cur = best.get(r.item_id);
    if (
      !cur ||
      r.noted_on < cur.noted_on ||
      (r.noted_on === cur.noted_on && r.created_at < cur.created_at)
    ) {
      best.set(r.item_id, r);
    }
  }
  return best;
}

/** Latest valuation's DATE — the same tie-break businessStats uses to pick
 *  value_sen (max date, created_at breaks ties, first-seen wins on a full
 *  tie), so valued_on always dates the winning valuation. Null = at cost. */
function latestValuationOn(
  entries: Array<{ kind: string; date: string; created_at: string }>,
): string | null {
  let latest: { date: string; created_at: string } | null = null;
  for (const e of entries) {
    if (e.kind !== "valuation") continue;
    if (
      !latest ||
      e.date > latest.date ||
      (e.date === latest.date && e.created_at > latest.created_at)
    ) {
      latest = e;
    }
  }
  return latest ? latest.date : null;
}

/** Task 5: "<CUR>MYR" → rate_e8 covering holding AND account currencies.
 *  The valuation load already fetched the holding pairs; any account-only
 *  pairs are fetched here and merged (usually a no-op — all accounts MYR). */
async function ratesWithAccountPairs(
  supabase: SupabaseClient,
  valuationFx: Map<string, { rate_e8: number; as_of: string }>,
  accountCurrencies: string[],
): Promise<Map<string, number>> {
  const byPair = new Map<string, number>();
  for (const [pair, r] of valuationFx) byPair.set(pair, r.rate_e8);
  const missing = [
    ...new Set(accountCurrencies.filter((c) => c !== "MYR").map((c) => `${c}MYR`)),
  ].filter((p) => !byPair.has(p));
  if (missing.length > 0) {
    const res = await supabase.from("fx_rates").select("pair, rate_e8").in("pair", missing);
    if (res.error) throw res.error;
    for (const r of res.data as Array<{ pair: string; rate_e8: number }>) {
      byPair.set(r.pair, r.rate_e8);
    }
  }
  return byPair;
}

interface SnapshotRow {
  date: string;
  accounts_sen: number;
  holdings_sen: number;
  business_sen: number;
  manual_assets_sen: number;
  liabilities_sen: number;
}

export async function getNetWorth(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<NetWorthData> {
  const [
    accounts,
    valuation,
    assetsRes,
    assetValuesRes,
    liabsRes,
    liabValuesRes,
    businessesRes,
    entriesRes,
    snapshotsRes,
  ] = await Promise.all([
    getAccountsWithBalances(supabase),
    loadPortfolioValuation(supabase, todayIso),
    supabase.from("manual_assets").select("id, name, kind, archived").order("created_at"),
    supabase.from("manual_asset_values").select("asset_id, value_sen, noted_on, created_at"),
    supabase
      .from("liabilities")
      .select("id, name, kind, archived, interest_rate_bp, minimum_payment_sen, planned_payment_sen")
      .order("created_at"),
    supabase.from("liability_values").select("liability_id, balance_sen, noted_on, created_at"),
    supabase.from("business_investments").select("id, name, note, archived").order("created_at"),
    supabase
      .from("business_investment_entries")
      .select("id, business_id, kind, amount_sen, account_id, date, note, created_at"),
    supabase
      .from("net_worth_snapshots")
      .select("date, accounts_sen, holdings_sen, business_sen, manual_assets_sen, liabilities_sen")
      .order("date"),
  ]);
  for (const res of [assetsRes, assetValuesRes, liabsRes, liabValuesRes, businessesRes, entriesRes, snapshotsRes]) {
    if (res.error) throw res.error;
  }

  // ---- parts (same composition rules as src/db/snapshots.ts) ----
  // ALL accounts, ruling 9; non-MYR balances convert via accountsTotalMyrSen
  // (ruling 7) — a never-fetched account currency is EXCLUDED and named in
  // fx_missing for the page's warn line.
  const accountRates = await ratesWithAccountPairs(
    supabase,
    valuation.fx,
    accounts.map((a) => a.currency),
  );
  const accountsPart = accountsTotalMyrSen(accounts, accountRates);
  const accounts_sen = accountsPart.total_sen;
  const holdings_sen = valuation.holdings
    .filter((h) => !h.archived)
    .reduce((sum, h) => sum + h.value_sen, 0);

  const assets = assetsRes.data as Array<{ id: string; name: string; kind: string; archived: boolean }>;
  const assetHistory: HistoryRow[] = (
    assetValuesRes.data as Array<{ asset_id: string; value_sen: number; noted_on: string; created_at: string }>
  ).map((v) => ({ item_id: v.asset_id, value_sen: v.value_sen, noted_on: v.noted_on, created_at: v.created_at }));
  const assetLatest = latestValues(assetHistory);
  const manual_assets_sen = assets
    .filter((a) => !a.archived)
    .reduce((sum, a) => sum + (assetLatest.get(a.id) ?? 0), 0);

  const liabs = liabsRes.data as Array<{
    id: string;
    name: string;
    kind: string;
    archived: boolean;
    interest_rate_bp: number;
    minimum_payment_sen: number;
    planned_payment_sen: number;
  }>;
  const liabHistory: HistoryRow[] = (
    liabValuesRes.data as Array<{ liability_id: string; balance_sen: number; noted_on: string; created_at: string }>
  ).map((v) => ({ item_id: v.liability_id, value_sen: v.balance_sen, noted_on: v.noted_on, created_at: v.created_at }));
  const liabLatest = latestValues(liabHistory);
  const liabilities_sen = liabs
    .filter((l) => !l.archived)
    .reduce((sum, l) => sum + (liabLatest.get(l.id) ?? 0), 0);

  const businesses = businessesRes.data as Array<{ id: string; name: string; note: string; archived: boolean }>;
  const entries = entriesRes.data as Array<{
    id: string;
    business_id: string;
    kind: "contribution" | "return" | "valuation";
    amount_sen: number;
    account_id: string | null;
    date: string;
    note: string;
    created_at: string;
  }>;
  const entriesByBusiness = new Map(businesses.map((b) => [b.id, [] as typeof entries]));
  for (const e of entries) entriesByBusiness.get(e.business_id)?.push(e);
  const statsByBusiness = new Map(
    businesses.map((b) => [b.id, businessStats(entriesByBusiness.get(b.id)!)]),
  );
  const business_sen = businesses
    .filter((b) => !b.archived)
    .reduce((sum, b) => sum + statsByBusiness.get(b.id)!.value_sen, 0);

  const parts = netWorthTotal({
    accounts_sen,
    holdings_sen,
    business_sen,
    manual_assets_sen,
    liabilities_sen,
  });

  // ---- snapshot series + delta ----
  const snapshots = (snapshotsRes.data as SnapshotRow[]).map((s) => ({
    date: s.date,
    total_sen: netWorthTotal(s).total_sen,
  }));
  const delta_vs_prev_month_sen = deltaVsPrevMonth(snapshots, parts.total_sen, todayIso);

  // ---- ruling-6 prefill: newest payment-note expense per liability ----
  const assetRows = latestRowByItem(assetHistory);
  const liabRows = latestRowByItem(liabHistory);
  const catByNote = new Map<string, string | null>();
  if (liabs.length > 0) {
    const payRes = await supabase
      .from("transactions")
      .select("note, category_id, date, created_at")
      .eq("type", "expense")
      .in("note", liabs.map((l) => `${l.name} payment`))
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });
    if (payRes.error) throw payRes.error;
    for (const row of payRes.data as Array<{ note: string; category_id: string | null }>) {
      if (!catByNote.has(row.note)) catByNote.set(row.note, row.category_id);
    }
  }

  // ---- price staleness over rows actually used by open positions ----
  let any_stale = false;
  let oldest_as_of: string | null = null;
  for (const h of valuation.holdings) {
    if (h.archived || h.position.quantity_e8 === 0) continue;
    const dates: string[] = [];
    if (h.price && !h.price.manual) dates.push(h.price.as_of);
    if (h.fx) dates.push(h.fx.as_of);
    for (const d of dates) {
      if (priceIsStale(d, todayIso)) any_stale = true;
      if (oldest_as_of === null || d < oldest_as_of) oldest_as_of = d;
    }
  }

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  // ---- list rows (ruling 14) ----
  // Every row of every group is mapped ONCE, then split on `archived` alone.
  // There is deliberately no value condition anywhere below: a zero-valued
  // archived item must stay reachable through its disclosure, or it can never
  // be unarchived again.
  const accountRows: AccountListRow[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    archived: a.archived,
    balance_sen: a.balance_sen,
  }));
  const assetListRows: ManualAssetListRow[] = assets.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    archived: a.archived,
    value_sen: assetLatest.get(a.id) ?? 0,
    noted_on: assetRows.get(a.id)?.noted_on ?? "",
  }));
  // Ruling 9: the projection is derived here from rows already loaded — the
  // latest balance that feeds liabilities_sen, the earliest history row for
  // progress — and touches neither the parts nor any table.
  const liabFirst = firstRowByItem(liabHistory);
  const liabilityListRows: LiabilityListRow[] = liabs.map((l) => {
    const balance_sen = liabLatest.get(l.id) ?? 0;
    const first = liabFirst.get(l.id);
    const payment_rate_sen = paymentRateSen(l);
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      archived: l.archived,
      interest_rate_bp: l.interest_rate_bp,
      minimum_payment_sen: l.minimum_payment_sen,
      planned_payment_sen: l.planned_payment_sen,
      balance_sen,
      noted_on: liabRows.get(l.id)?.noted_on ?? "",
      last_payment_category_id: catByNote.get(`${l.name} payment`) ?? null,
      first_recorded: first ? { balance_sen: first.value_sen, noted_on: first.noted_on } : null,
      payment_rate_sen,
      projection:
        !l.archived && first && payment_rate_sen !== null
          ? projectPayoff(balance_sen, l.interest_rate_bp, payment_rate_sen, todayIso)
          : null,
    };
  });
  const businessListRows: BusinessListRow[] = businesses.map((b) => {
    const bizEntries = entriesByBusiness.get(b.id)!;
    return {
      id: b.id,
      name: b.name,
      note: b.note,
      archived: b.archived,
      ...statsByBusiness.get(b.id)!,
      valued_on: latestValuationOn(bizEntries),
      entries: [...bizEntries]
        .sort((x, y) =>
          x.date === y.date
            ? y.created_at.localeCompare(x.created_at)
            : y.date.localeCompare(x.date),
        )
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          amount_sen: e.amount_sen,
          account_id: e.account_id,
          account_name: e.account_id === null ? null : (accountNameById.get(e.account_id) ?? null),
          date: e.date,
          note: e.note,
        })),
    };
  });
  const live = <T extends { archived: boolean }>(rows: T[]): T[] => rows.filter((r) => !r.archived);
  const gone = <T extends { archived: boolean }>(rows: T[]): T[] => rows.filter((r) => r.archived);

  return {
    parts,
    delta_vs_prev_month_sen,
    snapshots,
    accounts: live(accountRows),
    fx_missing: accountsPart.missing_currencies,
    manual_assets: live(assetListRows),
    liabilities: live(liabilityListRows),
    businesses: live(businessListRows),
    archived_accounts: gone(accountRows),
    archived_manual_assets: gone(assetListRows),
    archived_liabilities: gone(liabilityListRows),
    archived_businesses: gone(businessListRows),
    price_staleness: { any_stale, oldest_as_of },
  };
}

/** Dashboard card + /more rows (Task 9). Null only for a user with no data
 *  at all; `todayIso` comes from the caller (only route boundaries read the
 *  clock — house convention). */
export async function getNetWorthGlance(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<{
  total_sen: number;
  delta_sen: number | null;
  spark: number[];
  /** Ruling 19: the account currencies with no fx row yet, whose balances are
   *  therefore NOT inside `total_sen`. A total that silently omits money is a
   *  disclosure defect wherever it is shown, so the glance carries the same
   *  honest gap `/net-worth` already renders. */
  fx_missing: string[];
  /** Plan 8 ruling 10: the /more row's "· debts RM x" — lifted from the parts
   *  getNetWorth already computed, a type change rather than a new query. */
  liabilities_sen: number;
} | null> {
  const nw = await getNetWorth(supabase, todayIso);
  if (
    nw.accounts.length === 0 &&
    nw.archived_accounts.length === 0 &&
    nw.snapshots.length === 0 &&
    nw.parts.total_sen === 0
  ) {
    return null;
  }
  return {
    total_sen: nw.parts.total_sen,
    delta_sen: nw.delta_vs_prev_month_sen,
    spark: nw.snapshots.slice(-30).map((s) => s.total_sen),
    fx_missing: nw.fx_missing,
    liabilities_sen: nw.parts.liabilities_sen,
  };
}

// ---------------------------------------------------------------------------
// getAllocation (rulings 12–15)
// ---------------------------------------------------------------------------

export interface AllocationData {
  buckets: { bank_sen: number; cashlike_sen: number; equities_sen: number; pot_sen: number };
  presets: Record<PresetKey, { bank_pct: number; cashlike_pct: number; equities_pct: number }>;
  selected: PresetKey | null;
  target_etf_pct: number;
  equities_rows: Array<{
    id: string;
    symbol: string;
    kind: string;
    value_sen: number;
    target_pct: number | null;
  }>;
  /** Trailing 6 FULL calendar months (fewer while history is younger —
   *  ruling 14); 0 when there is no transaction history. */
  avg_monthly_expense_sen: number;
}

/** Half-up integer division, d > 0 — half AWAY from zero for negative n
 *  (the negative half is pinned on the sibling copies: debt.test.ts,
 *  db/funds.test.ts). */
function divHalfUp(n: number, d: number): number {
  const neg = n < 0;
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  const r = abs - q * d;
  const rounded = 2 * r >= d ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/** First day of the month before todayIso's month. */
function prevMonthFirstIso(todayIso: string): string {
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-01`;
}

/** Exported for the fund layer (Plan 7 ruling 3): a months-of-expenses target
 *  resolves against THIS average — there is no second one. */
export async function avgMonthlyExpenseSen(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<number> {
  const months = await getIncomeVsExpense(supabase, 6, prevMonthFirstIso(todayIso));
  const firstTxRes = await supabase
    .from("transactions")
    .select("date")
    .order("date")
    .limit(1)
    .maybeSingle();
  if (firstTxRes.error) throw firstTxRes.error;
  if (!firstTxRes.data) return 0;
  const earliestMonth = (firstTxRes.data.date as string).slice(0, 7);
  const divisor = months.filter((m) => m.month >= earliestMonth).length;
  if (divisor === 0) return 0;
  const sum = months.reduce((s, m) => s + m.expense_sen, 0);
  return divHalfUp(sum, divisor);
}

export async function getAllocation(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<AllocationData> {
  const [valuation, accountsRes, balancesRes, presetsRes, settingsRes, avg] = await Promise.all([
    loadPortfolioValuation(supabase, todayIso),
    supabase
      .from("accounts")
      .select("id, type, currency, allocation_bucket")
      .eq("archived", false),
    supabase.from("account_balances").select("account_id, balance_sen"),
    supabase.from("allocation_presets").select("key, bank_pct, cashlike_pct, equities_pct"),
    supabase
      .from("user_settings")
      .select("allocation_preset, target_etf_pct")
      .maybeSingle(),
    avgMonthlyExpenseSen(supabase, todayIso),
  ]);
  for (const res of [accountsRes, balancesRes, presetsRes, settingsRes]) {
    if (res.error) throw res.error;
  }

  const balanceById = new Map(
    (balancesRes.data as Array<{ account_id: string; balance_sen: number | string }>).map((b) => [
      b.account_id,
      Number(b.balance_sen),
    ]),
  );
  const allocAccounts = accountsRes.data as Array<{
    id: string;
    type: string;
    currency: string;
    allocation_bucket: Bucket | null;
  }>;
  const bucketed = allocAccounts.map((a) => ({
    balance_sen: balanceById.get(a.id) ?? 0,
    currency: a.currency,
    bucket: a.allocation_bucket ?? defaultBucket(a.type), // ruling 12
  }));

  const listed = valuation.holdings.filter(isListedHolding);
  const holdingsTotal = listed.reduce((sum, h) => sum + h.value_sen, 0);
  // Ruling 7: non-MYR account balances convert into the pot at their
  // <CUR>MYR rate; a never-fetched rate leaves that account out (honest gap).
  const allocRates = await ratesWithAccountPairs(
    supabase,
    valuation.fx,
    allocAccounts.map((a) => a.currency),
  );
  const buckets = potBuckets(bucketed, holdingsTotal, allocRates);

  const presets = {
    balanced: { ...PRESET_DEFAULTS.balanced },
    growth: { ...PRESET_DEFAULTS.growth },
    aggressive: { ...PRESET_DEFAULTS.aggressive },
    barbell: { ...PRESET_DEFAULTS.barbell },
  };
  for (const row of presetsRes.data as Array<{
    key: PresetKey;
    bank_pct: number;
    cashlike_pct: number;
    equities_pct: number;
  }>) {
    presets[row.key] = {
      bank_pct: row.bank_pct,
      cashlike_pct: row.cashlike_pct,
      equities_pct: row.equities_pct,
    };
  }

  const settings = settingsRes.data as {
    allocation_preset: PresetKey | null;
    target_etf_pct: number;
  } | null;

  return {
    buckets,
    presets,
    selected: settings?.allocation_preset ?? null,
    target_etf_pct: settings?.target_etf_pct ?? 70,
    equities_rows: listed.map((h) => ({
      id: h.id,
      symbol: h.symbol,
      kind: h.kind,
      value_sen: h.value_sen,
      target_pct: h.target_pct,
    })),
    avg_monthly_expense_sen: avg,
  };
}

// ---------------------------------------------------------------------------
// Write helpers ("perform*" — plain functions so DB tests can exercise them;
// the "use server" actions wrap these).
// ---------------------------------------------------------------------------

export type NetWorthWriteResult = { ok: true } | { ok: false; error: string };

function zodError(error: z.ZodError): { ok: false; error: string } {
  const first = error.issues[0];
  return { ok: false, error: first ? first.message : "invalid input" };
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const nameSchema = z.string().trim().min(1).max(60);
const senSchema = z.number().int().min(0);

// ---- manual assets (ruling 5) ----

const assetKindSchema = z.enum(["epf", "fd", "property", "vehicle", "other"]);

const assetCreateSchema = z.object({
  name: nameSchema,
  kind: assetKindSchema,
  value_sen: senSchema.optional(),
  noted_on: dateSchema.optional(),
});

export type ManualAssetCreateInput = z.infer<typeof assetCreateSchema>;

export async function performCreateManualAsset(
  supabase: SupabaseClient,
  input: ManualAssetCreateInput,
): Promise<NetWorthWriteResult> {
  const parsed = assetCreateSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;
  const { data, error } = await supabase
    .from("manual_assets")
    .insert({ name: v.name, kind: v.kind })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  if (v.value_sen !== undefined) {
    const valueRes = await supabase.from("manual_asset_values").insert({
      asset_id: data.id as string,
      value_sen: v.value_sen,
      ...(v.noted_on !== undefined ? { noted_on: v.noted_on } : {}),
    });
    if (valueRes.error) {
      return {
        ok: false,
        error: `The asset was created, but its initial value failed to save: ${valueRes.error.message}. Use "Update value" to set it.`,
      };
    }
  }
  return { ok: true };
}

const assetPatchSchema = z.object({
  name: nameSchema.optional(),
  kind: assetKindSchema.optional(),
});

export type ManualAssetPatchInput = z.infer<typeof assetPatchSchema>;

async function patchItem(
  supabase: SupabaseClient,
  table: string,
  id: string,
  fields: Record<string, unknown>,
  label: string,
): Promise<NetWorthWriteResult> {
  if (Object.keys(fields).length === 0) return { ok: true };
  const { data, error } = await supabase.from(table).update(fields).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: `${label} not found` };
  return { ok: true };
}

export async function performUpdateManualAsset(
  supabase: SupabaseClient,
  id: string,
  patch: ManualAssetPatchInput,
): Promise<NetWorthWriteResult> {
  const parsed = assetPatchSchema.safeParse(patch);
  if (!parsed.success) return zodError(parsed.error);
  return patchItem(supabase, "manual_assets", id, { ...parsed.data }, "asset");
}

export async function performArchiveManualAsset(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "manual_assets", id, { archived: true }, "asset");
}

/** Task 3, ruling 4: archiving is reversible everywhere. */
export async function performUnarchiveManualAsset(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "manual_assets", id, { archived: false }, "asset");
}

/** Upsert on (user, asset, noted_on) — same-day set replaces (ruling 5). */
export async function performSetManualAssetValue(
  supabase: SupabaseClient,
  asset_id: string,
  value_sen: number,
  noted_on: string,
): Promise<NetWorthWriteResult> {
  const senParsed = senSchema.safeParse(value_sen);
  if (!senParsed.success) return zodError(senParsed.error);
  const dateParsed = dateSchema.safeParse(noted_on);
  if (!dateParsed.success) return zodError(dateParsed.error);
  const { error } = await supabase
    .from("manual_asset_values")
    .upsert(
      { asset_id, value_sen: senParsed.data, noted_on: dateParsed.data },
      { onConflict: "user_id,asset_id,noted_on" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---- liabilities (rulings 5–6) ----

const liabilityKindSchema = z.enum(["loan", "credit_card", "ptptn", "other"]);

const liabilityCreateSchema = z.object({
  name: nameSchema,
  kind: liabilityKindSchema,
  interest_rate_bp: z.number().int().min(0).max(10_000).optional(),
  minimum_payment_sen: senSchema.optional(),
  balance_sen: senSchema.optional(),
  noted_on: dateSchema.optional(),
});

export type LiabilityCreateInput = z.infer<typeof liabilityCreateSchema>;

export async function performCreateLiability(
  supabase: SupabaseClient,
  input: LiabilityCreateInput,
): Promise<NetWorthWriteResult> {
  const parsed = liabilityCreateSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;
  const { data, error } = await supabase
    .from("liabilities")
    .insert({
      name: v.name,
      kind: v.kind,
      interest_rate_bp: v.interest_rate_bp ?? 0,
      minimum_payment_sen: v.minimum_payment_sen ?? 0,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  if (v.balance_sen !== undefined) {
    const valueRes = await supabase.from("liability_values").insert({
      liability_id: data.id as string,
      balance_sen: v.balance_sen,
      ...(v.noted_on !== undefined ? { noted_on: v.noted_on } : {}),
    });
    if (valueRes.error) {
      return {
        ok: false,
        error: `The liability was created, but its balance failed to save: ${valueRes.error.message}. Use "Set balance" to record it.`,
      };
    }
  }
  return { ok: true };
}

const liabilityPatchSchema = z.object({
  name: nameSchema.optional(),
  kind: liabilityKindSchema.optional(),
  interest_rate_bp: z.number().int().min(0).max(10_000).optional(),
  minimum_payment_sen: senSchema.optional(),
  /** Plan 8 ruling 9 — the Plan payment dialog mode; 0 falls back to the minimum. */
  planned_payment_sen: senSchema.optional(),
});

export type LiabilityPatchInput = z.infer<typeof liabilityPatchSchema>;

export async function performUpdateLiability(
  supabase: SupabaseClient,
  id: string,
  patch: LiabilityPatchInput,
): Promise<NetWorthWriteResult> {
  const parsed = liabilityPatchSchema.safeParse(patch);
  if (!parsed.success) return zodError(parsed.error);
  return patchItem(supabase, "liabilities", id, { ...parsed.data }, "liability");
}

export async function performArchiveLiability(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "liabilities", id, { archived: true }, "liability");
}

/** Task 3, ruling 4: archiving is reversible everywhere. */
export async function performUnarchiveLiability(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "liabilities", id, { archived: false }, "liability");
}

/** Direct balance set ("Set balance") — upsert on (user, liability, day). */
export async function performSetLiabilityBalance(
  supabase: SupabaseClient,
  liability_id: string,
  balance_sen: number,
  noted_on: string,
): Promise<NetWorthWriteResult> {
  const senParsed = senSchema.safeParse(balance_sen);
  if (!senParsed.success) return zodError(senParsed.error);
  const dateParsed = dateSchema.safeParse(noted_on);
  if (!dateParsed.success) return zodError(dateParsed.error);
  const { error } = await supabase
    .from("liability_values")
    .upsert(
      { liability_id, balance_sen: senParsed.data, noted_on: dateParsed.data },
      { onConflict: "user_id,liability_id,noted_on" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const paymentSchema = z.object({
  liability_id: z.uuid(),
  account_id: z.uuid(),
  category_id: z.uuid(),
  amount_sen: z.number().int().positive(),
  date: dateSchema,
  client_uuid: z.uuid(),
});

export type LiabilityPaymentInput = z.infer<typeof paymentSchema>;

/** partial: the expense half landed but the balance half did not — the
 *  action layer still revalidates so no page shows stale money. */
export type LiabilityPaymentResult =
  | { ok: true }
  | { ok: false; error: string; partial?: boolean };

async function currentLiabilityBalance(
  supabase: SupabaseClient,
  liability_id: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("liability_values")
    .select("liability_id, balance_sen, noted_on, created_at")
    .eq("liability_id", liability_id);
  if (error) throw error;
  const latest = latestValues(
    (data as Array<{ liability_id: string; balance_sen: number; noted_on: string; created_at: string }>).map(
      (v) => ({
        item_id: v.liability_id,
        value_sen: v.balance_sen,
        noted_on: v.noted_on,
        created_at: v.created_at,
      }),
    ),
  );
  return latest.get(liability_id) ?? 0;
}

/**
 * Ruling 6: two sequential writes — the ordinary expense transaction FIRST
 * (client UUID, budgets see it), THEN a liability_values upsert at
 * current balance − amount for that date. Not atomic: a partial failure
 * returns a visible error naming what saved; both halves are idempotent so
 * a retry with the same client UUID converges (the retry detects the
 * already-saved transaction and only finishes the missing balance row —
 * never subtracting twice). A payment above the tracked balance is rejected
 * before any write ("Set balance" first — interest accrual is recorded
 * there, not inferred here).
 *
 * Plan 8 ruling 1: the payment account must be MYR — a liability balance is
 * MYR sen and a foreign account's amount_sen are not — checked inside this
 * RLS session before the retry branch, so neither half is ever written for a
 * foreign account. The dialog regenerates the uuid whenever the amount,
 * account, category or date changes, so an EDITED retry from the dialog is a
 * new entry; Plan 9 ruling 9 closes the same shape SERVER side, where the
 * uuid is the caller's word: the retry branch compares the stored expense
 * with the request and refuses any difference, so a retry can only ever
 * finish the SAME payment from any caller (both pinned in networth.test.ts).
 */
export async function performRecordLiabilityPayment(
  supabase: SupabaseClient,
  input: LiabilityPaymentInput,
): Promise<LiabilityPaymentResult> {
  const parsed = paymentSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;

  const liabRes = await supabase
    .from("liabilities")
    .select("id, name")
    .eq("id", v.liability_id)
    .maybeSingle();
  if (liabRes.error) return { ok: false, error: liabRes.error.message };
  if (!liabRes.data) return { ok: false, error: "liability not found" };
  const name = liabRes.data.name as string;

  const acctRes = await supabase
    .from("accounts")
    .select("currency")
    .eq("id", v.account_id)
    .maybeSingle();
  if (acctRes.error) return { ok: false, error: acctRes.error.message };
  if (!acctRes.data) return { ok: false, error: "account not found" };
  const currency = acctRes.data.currency as string;
  if (currency !== "MYR") {
    return { ok: false, error: `Liability payments are MYR-only — this account is in ${currency}` };
  }

  const txRes = await supabase
    .from("transactions")
    .select("id, amount_sen, account_id, date, note")
    .eq("id", v.client_uuid)
    .maybeSingle();
  if (txRes.error) return { ok: false, error: txRes.error.message };
  const stored = txRes.data as { amount_sen: number; account_id: string; date: string; note: string } | null;

  if (stored !== null) {
    // Retry (Plan 9 ruling 9): the expense landed earlier, so this call can
    // only ever COMPLETE that payment. Anything unequal is an edited retry —
    // refused, nothing written; the RM 500-expense-vs-RM 300-step shape is
    // unreachable from any caller.
    // RULE (Q46, owner: "Also match the note"): the transaction row has no
    // liability column, so amount, account and date cannot bind the retry
    // to the LIABILITY — the note the fresh path writes below,
    // `<liability name> payment`, is that bond, compared byte for byte. A
    // liability renamed between the lost attempt and the retry therefore
    // false-refuses; that case is recoverable through the message's own
    // "delete that entry first".
    if (
      stored.amount_sen !== v.amount_sen ||
      stored.account_id !== v.account_id ||
      stored.date !== v.date ||
      stored.note !== `${name} payment`
    ) {
      const acct = await supabase.from("accounts").select("name").eq("id", stored.account_id).single();
      if (acct.error) return { ok: false, error: acct.error.message };
      return {
        ok: false,
        error: `${formatSen(stored.amount_sen)} is already saved as this payment's expense from ${acct.data.name as string} — retry with the same figures, or delete that entry first`,
      };
    }
    // RULE (ruling 9): "the step exists" means a liability_values row on
    // this date — there is no column keying a step to its transaction. The
    // accepted single-user exposure: a second, DIFFERENT payment on the same
    // day would make a lost-response retry of the first read as complete
    // (the house precedent for a documented, unbuilt race is Session-12
    // Minor 3 in src/db/accounts.ts; no schema change in Plan 9).
    const valueRes = await supabase
      .from("liability_values")
      .select("id")
      .eq("liability_id", v.liability_id)
      .eq("noted_on", v.date)
      .maybeSingle();
    if (valueRes.error) return { ok: false, error: valueRes.error.message };
    // Both halves landed: idempotent success. The balance guard must NOT run
    // here — after an exact payoff the balance is 0, and the guard would
    // refuse the retry forever on "retry with the same figures".
    if (valueRes.data) return { ok: true };
    // Half done: only the step is missing, so "latest" is still the
    // pre-payment base — guard against it, then write the step.
    const balance = await currentLiabilityBalance(supabase, v.liability_id);
    if (v.amount_sen > balance) {
      return {
        ok: false,
        error: `Payment (${formatSen(v.amount_sen)}) exceeds the tracked balance (${formatSen(balance)}) — set the balance first. Nothing was saved.`,
      };
    }
    const upsert = await supabase.from("liability_values").upsert(
      { liability_id: v.liability_id, balance_sen: balance - v.amount_sen, noted_on: v.date },
      { onConflict: "user_id,liability_id,noted_on" },
    );
    if (upsert.error) {
      return {
        ok: false,
        partial: true,
        error: `The payment transaction is saved, but the balance update failed again: ${upsert.error.message}. Retry to finish.`,
      };
    }
    return { ok: true };
  }

  // Fresh path: the balance refusal, the expense, then the step.
  const balance = await currentLiabilityBalance(supabase, v.liability_id);
  if (v.amount_sen > balance) {
    return {
      ok: false,
      error: `Payment (${formatSen(v.amount_sen)}) exceeds the tracked balance (${formatSen(balance)}) — set the balance first. Nothing was saved.`,
    };
  }

  const insert = await supabase.from("transactions").insert({
    id: v.client_uuid,
    type: "expense",
    amount_sen: v.amount_sen,
    account_id: v.account_id,
    category_id: v.category_id,
    date: v.date,
    note: `${name} payment`, // the ruling-6 prefill anchor (see header)
  });
  if (insert.error && insert.error.code !== "23505") {
    // 23505 = a concurrent retry already saved it — carry on to the value row.
    return { ok: false, error: `The payment was not saved: ${insert.error.message}` };
  }

  const upsert = await supabase.from("liability_values").upsert(
    { liability_id: v.liability_id, balance_sen: balance - v.amount_sen, noted_on: v.date },
    { onConflict: "user_id,liability_id,noted_on" },
  );
  if (upsert.error) {
    return {
      ok: false,
      partial: true,
      error: `The payment transaction was saved, but the balance update failed: ${upsert.error.message}. Retry with the same figures — it will finish safely without double-charging.`,
    };
  }
  return { ok: true };
}

// ---- business investments (ruling 20) ----

const businessCreateSchema = z.object({
  name: nameSchema,
  note: z.string().max(200).optional(),
});

export type BusinessCreateInput = z.infer<typeof businessCreateSchema>;

export async function performCreateBusiness(
  supabase: SupabaseClient,
  input: BusinessCreateInput,
): Promise<NetWorthWriteResult> {
  const parsed = businessCreateSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("business_investments")
    .insert({ name: parsed.data.name, note: parsed.data.note ?? "" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const businessPatchSchema = z.object({
  name: nameSchema.optional(),
  note: z.string().max(200).optional(),
});

export type BusinessPatchInput = z.infer<typeof businessPatchSchema>;

export async function performUpdateBusiness(
  supabase: SupabaseClient,
  id: string,
  patch: BusinessPatchInput,
): Promise<NetWorthWriteResult> {
  const parsed = businessPatchSchema.safeParse(patch);
  if (!parsed.success) return zodError(parsed.error);
  return patchItem(supabase, "business_investments", id, { ...parsed.data }, "business");
}

export async function performArchiveBusiness(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "business_investments", id, { archived: true }, "business");
}

/** Task 3, ruling 4: archiving is reversible everywhere. */
export async function performUnarchiveBusiness(
  supabase: SupabaseClient,
  id: string,
): Promise<NetWorthWriteResult> {
  return patchItem(supabase, "business_investments", id, { archived: false }, "business");
}

const CASH_KINDS = ["contribution", "return"] as const;

const businessEntrySchema = z
  .object({
    id: z.uuid(), // client-generated (rule 14) — create-or-update key
    business_id: z.uuid(),
    kind: z.enum(["contribution", "return", "valuation"]),
    amount_sen: senSchema,
    account_id: z.uuid().nullable().optional(),
    date: dateSchema,
    note: z.string().max(200).default(""),
  })
  .superRefine((v, ctx) => {
    const hasAccount = v.account_id !== undefined && v.account_id !== null;
    if (v.kind === "valuation" && hasAccount) {
      ctx.addIssue({ code: "custom", message: "a valuation never moves cash — no account" });
    }
    if (v.kind !== "valuation" && !hasAccount) {
      ctx.addIssue({ code: "custom", message: `a ${v.kind} needs the account the cash moved through` });
    }
  });

export type BusinessEntryInput = z.input<typeof businessEntrySchema>;

/** cash: whether account balances moved (old or new kind was a cash kind) —
 *  the action layer widens revalidation to the balance-showing pages. */
export type BusinessEntryResult = { ok: true; cash: boolean } | { ok: false; error: string };

export async function performSaveBusinessEntry(
  supabase: SupabaseClient,
  input: BusinessEntryInput,
): Promise<BusinessEntryResult> {
  const parsed = businessEntrySchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;

  const existingRes = await supabase
    .from("business_investment_entries")
    .select("kind")
    .eq("id", v.id)
    .maybeSingle();
  if (existingRes.error) return { ok: false, error: existingRes.error.message };
  const oldKind = existingRes.data?.kind as string | undefined;

  const { error } = await supabase.from("business_investment_entries").upsert({
    id: v.id,
    business_id: v.business_id,
    kind: v.kind,
    amount_sen: v.amount_sen,
    account_id: v.kind === "valuation" ? null : v.account_id,
    date: v.date,
    note: v.note,
  });
  if (error) return { ok: false, error: error.message };
  const isCash = (k: string | undefined): boolean =>
    k !== undefined && (CASH_KINDS as readonly string[]).includes(k);
  return { ok: true, cash: isCash(v.kind) || isCash(oldKind) };
}

/** Hard delete (ruling 20 — ledger corrections; nothing references entries). */
export async function performDeleteBusinessEntry(
  supabase: SupabaseClient,
  id: string,
): Promise<BusinessEntryResult> {
  const entryRes = await supabase
    .from("business_investment_entries")
    .select("kind")
    .eq("id", id)
    .maybeSingle();
  if (entryRes.error) return { ok: false, error: entryRes.error.message };
  if (!entryRes.data) return { ok: false, error: "entry not found" };
  const { error } = await supabase.from("business_investment_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, cash: (CASH_KINDS as readonly string[]).includes(entryRes.data.kind as string) };
}

// ---- allocation plan writes (rulings 12–13, 15) ----

const presetKeySchema = z.enum(["balanced", "growth", "aggressive", "barbell"]);

/** "Set as plan" — stores the selected preset key (ruling 13). */
export async function performSelectAllocationPreset(
  supabase: SupabaseClient,
  key: PresetKey,
): Promise<NetWorthWriteResult> {
  const parsed = presetKeySchema.safeParse(key);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("user_settings")
    .upsert({ allocation_preset: parsed.data }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const presetPctsSchema = z
  .object({
    bank_pct: z.number().int().min(0).max(100),
    cashlike_pct: z.number().int().min(0).max(100),
    equities_pct: z.number().int().min(0).max(100),
  })
  .refine((v) => v.bank_pct + v.cashlike_pct + v.equities_pct === 100, {
    message: "the three percentages must sum to 100",
  });

export type PresetPctsInput = z.infer<typeof presetPctsSchema>;

/** "Edit targets" — upserts the per-user override row (ruling 13). */
export async function performUpdateAllocationPreset(
  supabase: SupabaseClient,
  key: PresetKey,
  pcts: PresetPctsInput,
): Promise<NetWorthWriteResult> {
  const keyParsed = presetKeySchema.safeParse(key);
  if (!keyParsed.success) return zodError(keyParsed.error);
  const parsed = presetPctsSchema.safeParse(pcts);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("allocation_presets")
    .upsert({ key: keyParsed.data, ...parsed.data }, { onConflict: "user_id,key" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** ETF share of the equities slice (ruling 15). */
export async function performUpdateEquitiesTarget(
  supabase: SupabaseClient,
  target_etf_pct: number,
): Promise<NetWorthWriteResult> {
  const parsed = z.number().int().min(0).max(100).safeParse(target_etf_pct);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("user_settings")
    .upsert({ target_etf_pct: parsed.data }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const bucketSchema = z.enum(["bank", "cashlike", "equities", "exclude"]);

/** Settings → Accounts seg-mini control (ruling 12). */
export async function performSetAllocationBucket(
  supabase: SupabaseClient,
  account_id: string,
  bucket: Bucket,
): Promise<NetWorthWriteResult> {
  const parsed = bucketSchema.safeParse(bucket);
  if (!parsed.success) return zodError(parsed.error);
  return patchItem(supabase, "accounts", account_id, { allocation_bucket: parsed.data }, "account");
}
