import { createAdminClient } from "@/db/admin";
import { writeSnapshot } from "@/db/snapshots";
import { klToday } from "@/lib/kl-date";
import { fetchQuotes, fetchFx } from "@/lib/prices";
import { materializeDueRules } from "@/lib/recurring";
import { safeEqual } from "@/lib/safe-equal";

export const maxDuration = 60; // external price/FX fetches

/**
 * Daily cron entry point (Vercel cron). Server-only: this is the sanctioned
 * boundary that reads the wall clock and holds the service-role key. Order
 * is binding: (1) materialize recurring rules, (2) refresh prices for auto
 * holdings, (3) refresh FX for non-MYR holding currencies, (4) one net-worth
 * snapshot per user. A source outage degrades the counts — never a 500.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const today = klToday(new Date());

  let inserted = 0;
  let prices_updated = 0;
  let prices_failed = 0;
  let fx_updated = 0;
  let fx_failed = 0;
  let snapshots_written = 0;
  // Ruling 17: one entry per unit of work whose failure the counts cannot
  // show. The counts themselves never change meaning — the standing morning
  // check reads them.
  const errors: string[] = [];

  // (1) recurring rules. A currency-guard skip (ruling 16) inserts nothing
  // and advances nothing, so `inserted` alone cannot show it. A throw mid-run
  // leaves `inserted` at 0 even if some rows landed before it — read `errors`
  // first, as the standing check does: the line names the run as failed.
  try {
    const materialized = await materializeDueRules(admin, today);
    inserted = materialized.inserted;
    for (const skip of materialized.skipped) errors.push(`recurring ${skip}`);
  } catch (e) {
    errors.push(`recurring: ${e instanceof Error ? e.message : "materialization failed"}`);
  }

  // (2) prices + (3) FX — failures keep the previous rows (stale grace).
  try {
    // ⚠ A PostgREST failure RESOLVES with `{ data: null, error }` — it does
    // not reject — so the try/catch around this block never sees it. Left
    // undestructured, `data` is null, the loop below runs zero times, and the
    // response is byte-identical to a clean nothing-to-do day. Ruling 17: one
    // entry per unit of work whose failure the counts cannot show, and this is
    // the sharpest example of that — see the accounts read below.
    const { data: holdings, error: holdingsErr } = await admin
      .from("holdings")
      .select("symbol, kind, currency, price_source")
      .eq("archived", false);
    if (holdingsErr) errors.push(`prices/fx holdings: ${holdingsErr.message}`);
    const autoSymbols = new Map<string, string>(); // symbol → kind
    const currencies = new Set<string>();
    for (const h of holdings ?? []) {
      if (h.price_source === "auto") autoSymbols.set(h.symbol, h.kind);
      if (h.currency !== "MYR") currencies.add(h.currency);
    }
    // Task 5 (ruling 7): distinct non-MYR ACCOUNT currencies join the pair
    // enumeration — snapshots and pages convert those balances, archived
    // accounts included (ruling 9 sums them too).
    // The genuinely count-invisible one: if this fails, non-MYR ACCOUNT
    // currencies silently drop out of the pair enumeration while `fx_updated`
    // stays >= 1 from the holding currencies — not one count moves.
    const { data: acctCurrencies, error: acctCurrenciesErr } = await admin
      .from("accounts")
      .select("currency");
    if (acctCurrenciesErr) errors.push(`prices/fx accounts: ${acctCurrenciesErr.message}`);
    for (const a of acctCurrencies ?? []) {
      if (typeof a.currency === "string" && a.currency !== "MYR") currencies.add(a.currency);
    }

    if (autoSymbols.size > 0) {
      const quotes = await fetchQuotes(
        [...autoSymbols].map(([symbol, kind]) => ({ symbol, kind })),
      );
      const rows = [];
      for (const [symbol, q] of quotes) {
        if ("error" in q) {
          prices_failed++; // old row stays — stale grace (ruling 10)
          errors.push(`price ${symbol}: ${q.error}`);
          continue;
        }
        rows.push({
          symbol,
          currency: q.currency,
          price_e8: q.price_e8,
          as_of: q.as_of,
          fetched_at: new Date().toISOString(),
          source: q.source,
        });
      }
      if (rows.length > 0) {
        const { error } = await admin.from("prices").upsert(rows, { onConflict: "symbol" });
        if (error) prices_failed += rows.length;
        else prices_updated = rows.length;
      }
    }

    if (currencies.size > 0) {
      const fx = await fetchFx([...currencies].map((c) => `${c}MYR`));
      const rows = [];
      for (const [pair, q] of fx) {
        if ("error" in q) {
          fx_failed++;
          errors.push(`fx ${pair}: ${q.error}`);
          continue;
        }
        rows.push({
          pair,
          rate_e8: q.price_e8,
          as_of: q.as_of,
          fetched_at: new Date().toISOString(),
          source: q.source,
        });
      }
      if (rows.length > 0) {
        const { error } = await admin.from("fx_rates").upsert(rows, { onConflict: "pair" });
        if (error) fx_failed += rows.length;
        else fx_updated = rows.length;
      }
    }
  } catch (e) {
    // degraded run: snapshots below still write from whatever rows exist —
    // but a WHOLESALE failure must name itself (ruling 3), otherwise the
    // summary is byte-identical to a clean nothing-to-do day.
    errors.push(`prices/fx: ${e instanceof Error ? e.message : "price/FX refresh failed"}`);
  }

  // (4) snapshots — one per distinct user over accounts.
  try {
    const { data: accts, error: acctsErr } = await admin.from("accounts").select("user_id");
    // Same shape as the two reads above: without this the run reports
    // snapshots_written: 0 and an empty errors[], which reads as "no users".
    if (acctsErr) errors.push(`snapshots: ${acctsErr.message}`);
    const users = [...new Set((accts ?? []).map((r) => r.user_id as string))];
    for (const userId of users) {
      try {
        await writeSnapshot(admin, userId, today);
        snapshots_written++;
      } catch (e) {
        // this user's snapshot is missed today; tomorrow's run heals it — but
        // a missing snapshot is a finding, so the miss names itself (ruling
        // 17). No user id: the app is single-user and it would not change
        // what the owner does.
        errors.push(`snapshot ${today}: ${e instanceof Error ? e.message : "snapshot failed"}`);
      }
    }
  } catch (e) {
    // enumeration failed — counts stay at their degraded values, and the
    // failure is reported rather than read as "no users to snapshot".
    errors.push(`snapshots: ${e instanceof Error ? e.message : "user enumeration failed"}`);
  }

  const summary = {
    inserted,
    prices_updated,
    prices_failed,
    fx_updated,
    fx_failed,
    snapshots_written,
    errors,
  };
  console.log("[cron/daily]", summary);
  return Response.json(summary);
}
