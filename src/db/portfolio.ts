import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  positionFromTrades,
  realizedInYear,
  holdingValueSen,
  centToSen,
  unrealizedCent,
  effectivePriceE8,
  priceIsStale,
  OversellError,
  type Position,
  type TradeLike,
} from "@/lib/portfolio";
import { apportion } from "@/lib/allocation";
import { accountMyrSen } from "@/lib/fx";

/**
 * Investments query layer + write helpers (Plan 5 Task 5). Everything runs
 * under the caller's RLS session client; prices/fx_rates are the global
 * reference tables (ruling 7 — authenticated may read, only the cron
 * writes). Valuation composes the SAME pure libs as the snapshot cron
 * (src/db/snapshots.ts) and follows the same rules — non-archived holdings
 * value the net-worth part, missing price/FX contributes 0 until a fetch
 * lands, stale rows are used as-is (ruling 10) — so pages and cron can
 * never disagree on the numbers.
 *
 * Local conventions (documented decisions):
 * - Holdings and cash accounts are ordered by created_at (stable house
 *   ordering); largest-remainder ties therefore resolve deterministically.
 * - pct_tenths: one apportion pass over [listed holdings..., cash] with
 *   total 1000 (ruling 19); a group's pct_tenths is the SUM of its member
 *   holdings' tenths so the displayed column always adds up.
 * - `fx` map is keyed by pair ("USDMYR"), mirroring fx_rates.
 * - A manual-priced holding renders price.as_of as "" (the UI shows
 *   "manual" instead of a date — ruling 11) and is never stale.
 */

const FX_IDENTITY_E8 = 100_000_000;
const KIND_ORDER = ["etf", "stock", "crypto"] as const;

export interface HoldingRow {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  currency: string;
  price_source: string;
  manual_price_e8: number | null;
  target_pct: number | null;
  archived: boolean;
  position: Position;
  price: { price_e8: number; as_of: string; stale: boolean; manual: boolean } | null;
  value_sen: number; // MYR; 0 when no price/FX yet
  value_cent: number; // holding-currency minor units; 0 when no price yet (ruling 8 native display)
  unrealized_cent: number;
  unrealized_sen: number;
  pct_tenths: number; // share of portfolio_total_sen (largest remainder)
}

export interface TradeRow {
  id: string;
  holding_id: string;
  account_id: string;
  side: string;
  date: string;
  quantity_e8: number;
  price_e8: number;
  fees_cent: number;
  cash_delta_sen: number;
  note: string;
  created_at: string;
  symbol: string;
  holding_currency: string;
  account_name: string;
}

export interface ArchivedHoldingRow {
  id: string;
  symbol: string;
  kind: string;
  tradeCount: number;
}

export interface InvestmentsData {
  holdings: HoldingRow[]; // non-archived + archived-with-position (ruling 9 spirit)
  /** Archived + zero-position — the Task-3 "Archived (n)" disclosure
   *  (ruling 4). Delete is only offered per-row when tradeCount === 0. */
  archivedHoldings: ArchivedHoldingRow[];
  groups: Array<{ kind: string; value_sen: number; pct_tenths: number; holding_ids: string[] }>;
  cash: {
    /** MYR — non-MYR brokerage balances converted at <CUR>MYR (Task 5);
     *  an account with no rate row yet contributes 0 (myr_sen null). */
    value_sen: number;
    pct_tenths: number;
    /** balance_sen stays native minor units of `currency` — the sub-line
     *  names non-MYR amounts with their code. */
    accounts: Array<{ name: string; balance_sen: number; currency: string; myr_sen: number | null }>;
  };
  portfolio_total_sen: number; // holdings + cash — the % denominator
  trades: TradeRow[]; // all trades, newest first
  totals: {
    value_sen: number;
    cost_sen: number;
    unrealized_sen: number;
    realized_ytd_sen: number;
  };
  /** <CUR>MYR rows for holding AND non-archived non-MYR account currencies —
   *  the trade form's rate-resolution feed (ruling 6). */
  fx: Map<string, { rate_e8: number; as_of: string }>;
  accounts: Array<{ id: string; name: string; currency: string }>; // trade form select
  holdings_display: HoldingsDisplay; // ruling 8 toggle, persisted on user_settings
}

// ---------------------------------------------------------------------------
// Shared valuation load (also consumed by src/db/networth.ts)
// ---------------------------------------------------------------------------

interface DbHolding {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  currency: string;
  price_source: string;
  manual_price_e8: number | null;
  target_pct: number | null;
  archived: boolean;
}

interface DbTrade {
  id: string;
  holding_id: string;
  account_id: string;
  side: "buy" | "sell";
  date: string;
  quantity_e8: number;
  price_e8: number;
  fees_cent: number;
  cash_delta_sen: number;
  note: string;
  created_at: string;
}

export interface ValuedHolding extends DbHolding {
  position: Position;
  price: HoldingRow["price"];
  fx: { rate_e8: number; as_of: string } | null; // null for MYR / missing pair
  value_sen: number;
  unrealized_cent: number;
  unrealized_sen: number;
  cost_sen: number; // MYR at current FX (0 when FX unknown)
  realized_ytd_sen: number;
}

export interface PortfolioValuation {
  holdings: ValuedHolding[]; // every holding, archived included, created_at order
  trades: DbTrade[]; // chronological (date, created_at)
  fx: Map<string, { rate_e8: number; as_of: string }>;
}

/** True when the row belongs on the Investments page (ruling 9 spirit). */
export function isListedHolding(h: { archived: boolean; position: Position }): boolean {
  return !h.archived || h.position.quantity_e8 > 0;
}

export async function loadPortfolioValuation(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<PortfolioValuation> {
  const [holdingsRes, tradesRes] = await Promise.all([
    supabase
      .from("holdings")
      .select("id, symbol, name, kind, currency, price_source, manual_price_e8, target_pct, archived")
      .order("created_at"),
    supabase
      .from("trades")
      .select("id, holding_id, account_id, side, date, quantity_e8, price_e8, fees_cent, cash_delta_sen, note, created_at")
      .order("date")
      .order("created_at"),
  ]);
  if (holdingsRes.error) throw holdingsRes.error;
  if (tradesRes.error) throw tradesRes.error;
  const holdings = holdingsRes.data as DbHolding[];
  const trades = tradesRes.data as DbTrade[];

  const tradesByHolding = new Map<string, DbTrade[]>();
  for (const t of trades) {
    const list = tradesByHolding.get(t.holding_id) ?? [];
    list.push(t);
    tradesByHolding.set(t.holding_id, list);
  }

  const symbols = holdings.map((h) => h.symbol);
  const pairs = [...new Set(holdings.filter((h) => h.currency !== "MYR").map((h) => `${h.currency}MYR`))];
  const [pricesRes, fxRes] = await Promise.all([
    symbols.length
      ? supabase.from("prices").select("symbol, price_e8, as_of").in("symbol", symbols)
      : Promise.resolve({ data: [], error: null }),
    pairs.length
      ? supabase.from("fx_rates").select("pair, rate_e8, as_of").in("pair", pairs)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pricesRes.error) throw pricesRes.error;
  if (fxRes.error) throw fxRes.error;
  const priceBySymbol = new Map(
    (pricesRes.data as Array<{ symbol: string; price_e8: number; as_of: string }>).map((p) => [p.symbol, p]),
  );
  const fx = new Map(
    (fxRes.data as Array<{ pair: string; rate_e8: number; as_of: string }>).map((r) => [
      r.pair,
      { rate_e8: r.rate_e8, as_of: r.as_of },
    ]),
  );

  const year = Number(todayIso.slice(0, 4));
  const valued: ValuedHolding[] = holdings.map((h) => {
    const own = tradesByHolding.get(h.id) ?? [];
    const position = positionFromTrades(own as TradeLike[]);
    const fetched = priceBySymbol.get(h.symbol) ?? null;
    const priceE8 = effectivePriceE8(h, fetched);
    const manual = h.price_source === "manual";
    const price: HoldingRow["price"] =
      priceE8 === null
        ? null
        : manual
          ? { price_e8: priceE8, as_of: "", stale: false, manual: true }
          : {
              price_e8: priceE8,
              as_of: fetched!.as_of,
              stale: priceIsStale(fetched!.as_of, todayIso),
              manual: false,
            };
    const fxEntry = h.currency === "MYR" ? null : (fx.get(`${h.currency}MYR`) ?? null);
    // fx_rates.rate_e8 (MYR per 1 CUR, ×1e8) is consumed directly as fx_e8
    // (sen per 1 minor unit, ×1e8): for 2-decimal currencies the two scales
    // are numerically identical — the ×100 sen/RM and ÷100 minor/CUR cancel.
    const fxE8 = h.currency === "MYR" ? FX_IDENTITY_E8 : fxEntry?.rate_e8;
    const value_sen =
      priceE8 !== null && fxE8 !== undefined
        ? holdingValueSen(position.quantity_e8, priceE8, fxE8)
        : 0;
    const unrealized_cent = priceE8 !== null ? unrealizedCent(position, priceE8) : 0;
    const unrealized_sen =
      priceE8 !== null && fxE8 !== undefined ? centToSen(unrealized_cent, fxE8) : 0;
    const cost_sen = fxE8 !== undefined ? centToSen(position.cost_cent, fxE8) : 0;
    const realized_ytd_sen =
      fxE8 !== undefined ? centToSen(realizedInYear(own as TradeLike[], year), fxE8) : 0;
    return {
      ...h,
      position,
      price,
      fx: fxEntry,
      value_sen,
      unrealized_cent,
      unrealized_sen,
      cost_sen,
      realized_ytd_sen,
    };
  });

  return { holdings: valued, trades, fx };
}

// ---------------------------------------------------------------------------
// getInvestments
// ---------------------------------------------------------------------------

export async function getInvestments(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<InvestmentsData> {
  const [valuation, accountsRes, balancesRes, settingsRes] = await Promise.all([
    loadPortfolioValuation(supabase, todayIso),
    supabase.from("accounts").select("id, name, type, currency, archived").order("created_at"),
    supabase.from("account_balances").select("account_id, balance_sen"),
    supabase.from("user_settings").select("holdings_display").maybeSingle(),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (balancesRes.error) throw balancesRes.error;
  if (settingsRes.error) throw settingsRes.error;
  const accounts = accountsRes.data as Array<{
    id: string;
    name: string;
    type: string;
    currency: string;
    archived: boolean;
  }>;
  const balanceById = new Map(
    (balancesRes.data as Array<{ account_id: string; balance_sen: number | string }>).map((b) => [
      b.account_id,
      Number(b.balance_sen), // integer sen; exact within MAX_SAFE_INTEGER
    ]),
  );

  // Rate-resolution feed (ruling 6): the valuation load only fetched pairs
  // for holding currencies; a cross-currency trade may also need the
  // ACCOUNT-currency leg (<CUR>MYR) for the via-MYR cross. Fetch the missing
  // ones once and merge — usually a no-op (all accounts MYR).
  const accountPairs = [
    ...new Set(
      accounts.filter((a) => !a.archived && a.currency !== "MYR").map((a) => `${a.currency}MYR`),
    ),
  ].filter((p) => !valuation.fx.has(p));
  if (accountPairs.length > 0) {
    const extraFx = await supabase
      .from("fx_rates")
      .select("pair, rate_e8, as_of")
      .in("pair", accountPairs);
    if (extraFx.error) throw extraFx.error;
    for (const r of extraFx.data as Array<{ pair: string; rate_e8: number; as_of: string }>) {
      valuation.fx.set(r.pair, { rate_e8: r.rate_e8, as_of: r.as_of });
    }
  }

  const listed = valuation.holdings.filter(isListedHolding);

  // Archived + zero-position (the complement of isListedHolding) — Task 3's
  // "Archived (n)" disclosure (ruling 4). tradeCount drives the per-row
  // Delete affordance (ruling 5: zero-trade holdings only).
  const tradeCountByHolding = new Map<string, number>();
  for (const t of valuation.trades) {
    tradeCountByHolding.set(t.holding_id, (tradeCountByHolding.get(t.holding_id) ?? 0) + 1);
  }
  const archivedHoldings: ArchivedHoldingRow[] = valuation.holdings
    .filter((h) => !isListedHolding(h))
    .map((h) => ({
      id: h.id,
      symbol: h.symbol,
      kind: h.kind,
      tradeCount: tradeCountByHolding.get(h.id) ?? 0,
    }));

  // Investment cash (ruling 19): non-archived brokerage-type accounts.
  // Task 5 (ruling 7): non-MYR balances convert at their <CUR>MYR rate; a
  // never-fetched rate contributes 0 to the MYR row (myr_sen null) — the
  // sub-line still names the native amount.
  const ratesByPair = new Map([...valuation.fx].map(([pair, r]) => [pair, r.rate_e8]));
  const cashAccounts = accounts
    .filter((a) => !a.archived && a.type === "brokerage")
    .map((a) => {
      const balance_sen = balanceById.get(a.id) ?? 0;
      return {
        name: a.name,
        balance_sen,
        currency: a.currency,
        myr_sen: accountMyrSen(balance_sen, a.currency, ratesByPair),
      };
    });
  const cashSen = cashAccounts.reduce((sum, a) => sum + (a.myr_sen ?? 0), 0);

  const holdingsValueSen = listed.reduce((sum, h) => sum + h.value_sen, 0);
  const portfolio_total_sen = holdingsValueSen + cashSen;

  // One largest-remainder pass over holdings + cash → the column sums to 1000.
  const tenths = apportion([...listed.map((h) => h.value_sen), cashSen], 1000);
  const cashTenths = tenths[listed.length]!;

  const holdings: HoldingRow[] = listed.map((h, i) => ({
    id: h.id,
    symbol: h.symbol,
    name: h.name,
    kind: h.kind,
    currency: h.currency,
    price_source: h.price_source,
    manual_price_e8: h.manual_price_e8,
    target_pct: h.target_pct,
    archived: h.archived,
    position: h.position,
    price: h.price,
    value_sen: h.value_sen,
    // Holding-currency value (identity fx): ruling 8's native display needs
    // it FX-free — it exists whenever a price does, even with no rate yet.
    value_cent: h.price
      ? holdingValueSen(h.position.quantity_e8, h.price.price_e8, FX_IDENTITY_E8)
      : 0,
    unrealized_cent: h.unrealized_cent,
    unrealized_sen: h.unrealized_sen,
    pct_tenths: tenths[i]!,
  }));

  const groups: InvestmentsData["groups"] = [];
  for (const kind of KIND_ORDER) {
    const members = holdings.filter((h) => h.kind === kind);
    if (members.length === 0) continue;
    groups.push({
      kind,
      value_sen: members.reduce((s, h) => s + h.value_sen, 0),
      pct_tenths: members.reduce((s, h) => s + h.pct_tenths, 0),
      holding_ids: members.map((h) => h.id),
    });
  }

  const holdingById = new Map(valuation.holdings.map((h) => [h.id, h]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const trades: TradeRow[] = [...valuation.trades]
    .reverse() // chronological load → newest first
    .map((t) => ({
      ...t,
      symbol: holdingById.get(t.holding_id)?.symbol ?? "",
      holding_currency: holdingById.get(t.holding_id)?.currency ?? "MYR",
      account_name: accountById.get(t.account_id)?.name ?? "",
    }));

  return {
    holdings,
    archivedHoldings,
    groups,
    cash: { value_sen: cashSen, pct_tenths: cashTenths, accounts: cashAccounts },
    portfolio_total_sen,
    trades,
    totals: {
      value_sen: holdingsValueSen,
      cost_sen: listed.reduce((s, h) => s + h.cost_sen, 0),
      unrealized_sen: listed.reduce((s, h) => s + h.unrealized_sen, 0),
      realized_ytd_sen: listed.reduce((s, h) => s + h.realized_ytd_sen, 0),
    },
    fx: valuation.fx,
    accounts: accounts
      .filter((a) => !a.archived)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    holdings_display:
      (settingsRes.data?.holdings_display as HoldingsDisplay | undefined) ?? "myr",
  };
}

// ---------------------------------------------------------------------------
// Write helpers ("perform*" — plain functions so DB tests can exercise them;
// the "use server" actions in investments/actions.ts wrap these).
// ---------------------------------------------------------------------------

export type PortfolioWriteResult = { ok: true } | { ok: false; error: string };

function zodError(error: z.ZodError): PortfolioWriteResult {
  const first = error.issues[0];
  return { ok: false, error: first ? first.message : "invalid input" };
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const currencySchema = z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code");

const holdingCreateSchema = z
  .object({
    symbol: z.string().trim().min(1).max(20),
    name: z.string().trim().max(60).optional(),
    kind: z.enum(["stock", "etf", "crypto"]),
    currency: currencySchema,
    price_source: z.enum(["auto", "manual"]).optional(),
    manual_price_e8: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.price_source !== "manual" || typeof v.manual_price_e8 === "number", {
    message: "manual pricing requires a manual price",
  });

export type HoldingCreateInput = z.infer<typeof holdingCreateSchema>;

export async function performCreateHolding(
  supabase: SupabaseClient,
  input: HoldingCreateInput,
): Promise<PortfolioWriteResult> {
  const parsed = holdingCreateSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;
  const { error } = await supabase.from("holdings").insert({
    symbol: v.symbol,
    name: v.name ?? "",
    kind: v.kind,
    currency: v.currency,
    price_source: v.price_source ?? "auto",
    manual_price_e8: v.manual_price_e8 ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const holdingPatchSchema = z
  .object({
    name: z.string().trim().max(60).optional(),
    price_source: z.enum(["auto", "manual"]).optional(),
    manual_price_e8: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) => v.price_source !== "manual" || typeof v.manual_price_e8 === "number",
    { message: "manual pricing requires a manual price" },
  );

export type HoldingPatchInput = z.infer<typeof holdingPatchSchema>;

/** Symbol is immutable once trades exist (Task-7 contract) — it is simply
 *  not editable here; recreate the holding to change identity. */
export async function performUpdateHolding(
  supabase: SupabaseClient,
  id: string,
  patch: HoldingPatchInput,
): Promise<PortfolioWriteResult> {
  const idParsed = z.uuid().safeParse(id);
  if (!idParsed.success) return zodError(idParsed.error);
  const parsed = holdingPatchSchema.safeParse(patch);
  if (!parsed.success) return zodError(parsed.error);
  const fields: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) fields.name = parsed.data.name;
  if (parsed.data.price_source !== undefined) fields.price_source = parsed.data.price_source;
  if (parsed.data.manual_price_e8 !== undefined) fields.manual_price_e8 = parsed.data.manual_price_e8;
  if (Object.keys(fields).length === 0) return { ok: true };
  const { data, error } = await supabase.from("holdings").update(fields).eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "holding not found" };
  return { ok: true };
}

export async function performArchiveHolding(
  supabase: SupabaseClient,
  id: string,
): Promise<PortfolioWriteResult> {
  const { data, error } = await supabase
    .from("holdings")
    .update({ archived: true })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "holding not found" };
  return { ok: true };
}

/** Reverses archiving (Task 3, ruling 4) — a plain flip back to visible.
 *  Position/group membership and % math are derived at read time, so an
 *  unarchived holding rejoins its kind group automatically. */
export async function performUnarchiveHolding(
  supabase: SupabaseClient,
  id: string,
): Promise<PortfolioWriteResult> {
  const { data, error } = await supabase
    .from("holdings")
    .update({ archived: false })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "holding not found" };
  return { ok: true };
}

/** Zero-trade hard delete (Task 3, ruling 5) — closes the archive +
 *  `unique (user_id, symbol)` trap for holdings that were never really
 *  traded. The trade count is re-checked SERVER-SIDE, inside this RLS
 *  session, immediately before the delete — a trade that lands between the
 *  client's "0 trades" read and this call still blocks it (count then
 *  delete; nonzero count -> visible error, nothing deleted). With >=1 trade,
 *  archive remains the only path. */
export async function performDeleteHolding(
  supabase: SupabaseClient,
  id: string,
): Promise<PortfolioWriteResult> {
  const holdingRes = await supabase.from("holdings").select("id").eq("id", id).maybeSingle();
  if (holdingRes.error) return { ok: false, error: holdingRes.error.message };
  if (!holdingRes.data) return { ok: false, error: "holding not found" };

  const countRes = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("holding_id", id);
  if (countRes.error) return { ok: false, error: countRes.error.message };
  if ((countRes.count ?? 0) > 0) {
    return {
      ok: false,
      error: "This holding has trades — archive it instead, or delete its trades first.",
    };
  }

  const { error } = await supabase.from("holdings").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const targetSchema = z.number().int().min(0).max(100).nullable();

/** Per-holding equities-split target (ruling 15). */
export async function performSetHoldingTarget(
  supabase: SupabaseClient,
  holding_id: string,
  target_pct: number | null,
): Promise<PortfolioWriteResult> {
  const parsed = targetSchema.safeParse(target_pct);
  if (!parsed.success) return zodError(parsed.error);
  const { data, error } = await supabase
    .from("holdings")
    .update({ target_pct: parsed.data })
    .eq("id", holding_id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "holding not found" };
  return { ok: true };
}

const holdingsDisplaySchema = z.enum(["myr", "native"]);

export type HoldingsDisplay = z.infer<typeof holdingsDisplaySchema>;

/** Investments-page display toggle (Plan 6 ruling 8): per-holding Value and
 *  Unrealized P/L render in MYR or the holding's own currency. Persisted on
 *  user_settings (single-column upsert — performUpdateEquitiesTarget's
 *  pattern) so the choice survives reloads and devices. */
export async function performSetHoldingsDisplay(
  supabase: SupabaseClient,
  display: HoldingsDisplay,
): Promise<PortfolioWriteResult> {
  const parsed = holdingsDisplaySchema.safeParse(display);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("user_settings")
    .upsert({ holdings_display: parsed.data }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const tradeSchema = z.object({
  id: z.uuid(), // client-generated (rule 14) — create-or-update key
  holding_id: z.uuid(),
  account_id: z.uuid(),
  side: z.enum(["buy", "sell"]),
  date: dateSchema,
  quantity_e8: z.number().int().positive(),
  price_e8: z.number().int().min(0),
  fees_cent: z.number().int().min(0).default(0),
  cash_delta_sen: z.number().int().min(0),
  note: z.string().max(200).default(""),
});

export type TradeInput = z.input<typeof tradeSchema>;

interface ChronoTrade extends TradeLike {
  id: string;
}

/** The holding's trades in replay order: (date, created_at) from the DB.
 *  positionFromTrades sorts stably by date, so this fixes same-day order. */
async function holdingTrades(supabase: SupabaseClient, holding_id: string): Promise<ChronoTrade[]> {
  const { data, error } = await supabase
    .from("trades")
    .select("id, side, date, quantity_e8, price_e8, fees_cent")
    .eq("holding_id", holding_id)
    .order("date")
    .order("created_at");
  if (error) throw error;
  return data as ChronoTrade[];
}

/** null when valid; a visible message when the chronology oversells. */
function oversellCheck(trades: TradeLike[]): string | null {
  try {
    positionFromTrades(trades);
    return null;
  } catch (e) {
    if (e instanceof OversellError) {
      return `${e.message} — nothing was saved`;
    }
    throw e;
  }
}

/**
 * Create or update a trade by its client UUID (rule 14). The FULL chronology
 * of the target holding — with this trade applied — is validated via
 * positionFromTrades BEFORE any write; an oversell anywhere in the sequence
 * is rejected with a visible error and nothing is written (ruling 4). When
 * an edit keeps the trade's date, it keeps its same-day slot; a new or
 * re-dated trade validates at the end of its day. When an edit moves the
 * trade to a different holding, the old holding's remaining set is
 * re-validated too.
 */
export async function performSaveTrade(
  supabase: SupabaseClient,
  input: TradeInput,
): Promise<PortfolioWriteResult> {
  const parsed = tradeSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const v = parsed.data;

  const existingRes = await supabase
    .from("trades")
    .select("id, holding_id, date")
    .eq("id", v.id)
    .maybeSingle();
  if (existingRes.error) return { ok: false, error: existingRes.error.message };
  const existing = existingRes.data as { id: string; holding_id: string; date: string } | null;

  let target: TradeLike[];
  try {
    const current = await holdingTrades(supabase, v.holding_id);
    const idx = current.findIndex((t) => t.id === v.id);
    if (idx >= 0 && current[idx]!.date === v.date) {
      target = current.map((t, i) => (i === idx ? v : t));
    } else {
      target = [...current.filter((t) => t.id !== v.id), v];
    }
    const targetError = oversellCheck(target);
    if (targetError) return { ok: false, error: targetError };

    if (existing && existing.holding_id !== v.holding_id) {
      const old = await holdingTrades(supabase, existing.holding_id);
      const oldError = oversellCheck(old.filter((t) => t.id !== v.id));
      if (oldError) return { ok: false, error: oldError };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "trade validation failed" };
  }

  const { error } = await supabase.from("trades").upsert({
    id: v.id,
    holding_id: v.holding_id,
    account_id: v.account_id,
    side: v.side,
    date: v.date,
    quantity_e8: v.quantity_e8,
    price_e8: v.price_e8,
    fees_cent: v.fees_cent,
    cash_delta_sen: v.cash_delta_sen,
    note: v.note,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Hard delete (ruling 4) — the REMAINING chronology must stay valid: a buy
 *  that funds a later sell cannot be deleted (visible error, nothing
 *  written). */
export async function performDeleteTrade(
  supabase: SupabaseClient,
  id: string,
): Promise<PortfolioWriteResult> {
  const tradeRes = await supabase
    .from("trades")
    .select("id, holding_id")
    .eq("id", id)
    .maybeSingle();
  if (tradeRes.error) return { ok: false, error: tradeRes.error.message };
  if (!tradeRes.data) return { ok: false, error: "trade not found" };

  try {
    const rest = (await holdingTrades(supabase, tradeRes.data.holding_id as string)).filter(
      (t) => t.id !== id,
    );
    const restError = oversellCheck(rest);
    if (restError) return { ok: false, error: restError };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "trade validation failed" };
  }

  const { error } = await supabase.from("trades").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
