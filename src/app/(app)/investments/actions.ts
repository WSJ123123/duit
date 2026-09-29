"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import {
  performCreateHolding,
  performUpdateHolding,
  performArchiveHolding,
  performUnarchiveHolding,
  performDeleteHolding,
  performSaveTrade,
  performDeleteTrade,
  performSetHoldingTarget,
  performSetHoldingsDisplay,
  type HoldingsDisplay,
  type HoldingCreateInput,
  type HoldingPatchInput,
  type TradeInput,
  type PortfolioWriteResult,
} from "@/db/portfolio";
import {
  performSelectAllocationPreset,
  performUpdateAllocationPreset,
  performUpdateEquitiesTarget,
  type PresetPctsInput,
  type NetWorthWriteResult,
} from "@/db/networth";
import type { PresetKey } from "@/lib/allocation";

/** Portfolio/allocation data surfaces on the Investments page, the Net
 *  Worth page (holdings part), the dashboard net-worth card and the /more
 *  rows (Task-5 audit list). */
function revalidatePortfolioPaths(): void {
  revalidatePath("/investments");
  revalidatePath("/net-worth");
  revalidatePath("/dashboard");
  revalidatePath("/more");
}

/** Trade writes additionally move the linked account's balance, which
 *  surfaces on /transactions and /quick (Plan-4 audit convention) — and, since
 *  Plan 7, on /bills: a trade is a ±cash_delta_sen term in account_balances,
 *  and that view IS ruling 12's projection base. */
function revalidateTradePaths(): void {
  revalidatePortfolioPaths();
  revalidatePath("/transactions");
  revalidatePath("/quick");
  revalidatePath("/bills");
  // …and ruling 9b's Goals denominator, off the same view.
  revalidatePath("/goals");
  // F3: /settings/accounts renders a per-account balance off the same
  // account_balances view, so it belongs to this enumeration too.
  revalidatePath("/settings/accounts");
}

export async function createHolding(input: HoldingCreateInput): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performCreateHolding(supabase, input);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function updateHolding(
  id: string,
  patch: HoldingPatchInput,
): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateHolding(supabase, id, patch);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function archiveHolding(id: string): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveHolding(supabase, id);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function unarchiveHolding(id: string): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUnarchiveHolding(supabase, id);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

/** Ruling 5: zero-trade hard delete — the server re-checks the trade count
 *  itself (performDeleteHolding), so a racing trade insert still blocks it. */
export async function deleteHolding(id: string): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performDeleteHolding(supabase, id);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

/** Create or update by client UUID; oversell rejected before write. */
export async function saveTrade(input: TradeInput): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSaveTrade(supabase, input);
  if (result.ok) revalidateTradePaths();
  return result;
}

export async function deleteTrade(id: string): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performDeleteTrade(supabase, id);
  if (result.ok) revalidateTradePaths();
  return result;
}

/** Ruling 8 display toggle — a per-user display preference that only the
 *  Investments page reads, so it revalidates /investments ONLY. */
export async function setHoldingsDisplay(display: HoldingsDisplay): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetHoldingsDisplay(supabase, display);
  if (result.ok) revalidatePath("/investments");
  return result;
}

export async function setHoldingTarget(
  holding_id: string,
  target_pct: number | null,
): Promise<PortfolioWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetHoldingTarget(supabase, holding_id, target_pct);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function updateEquitiesTarget(target_etf_pct: number): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateEquitiesTarget(supabase, target_etf_pct);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function selectAllocationPreset(key: PresetKey): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSelectAllocationPreset(supabase, key);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}

export async function updateAllocationPreset(
  key: PresetKey,
  pcts: PresetPctsInput,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateAllocationPreset(supabase, key, pcts);
  if (result.ok) revalidatePortfolioPaths();
  return result;
}
