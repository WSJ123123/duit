"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import {
  performCreateManualAsset,
  performUpdateManualAsset,
  performArchiveManualAsset,
  performUnarchiveManualAsset,
  performSetManualAssetValue,
  performCreateLiability,
  performUpdateLiability,
  performArchiveLiability,
  performUnarchiveLiability,
  performSetLiabilityBalance,
  performRecordLiabilityPayment,
  performCreateBusiness,
  performUpdateBusiness,
  performArchiveBusiness,
  performUnarchiveBusiness,
  performSaveBusinessEntry,
  performDeleteBusinessEntry,
  type ManualAssetCreateInput,
  type ManualAssetPatchInput,
  type LiabilityCreateInput,
  type LiabilityPatchInput,
  type LiabilityPaymentInput,
  type LiabilityPaymentResult,
  type BusinessCreateInput,
  type BusinessPatchInput,
  type BusinessEntryInput,
  type BusinessEntryResult,
  type NetWorthWriteResult,
} from "@/db/networth";

/** Net-worth data surfaces on the Net Worth page, the dashboard net-worth
 *  card and the /more rows (Task-5 audit list). */
function revalidateNetWorthPaths(): void {
  revalidatePath("/net-worth");
  revalidatePath("/dashboard");
  revalidatePath("/more");
}

/** A liability payment writes an ordinary expense — it additionally surfaces
 *  on /transactions, /quick and /budget (ruling 6). */
function revalidatePaymentPaths(): void {
  revalidateNetWorthPaths();
  revalidatePath("/transactions");
  revalidatePath("/quick");
  revalidatePath("/budget");
  revalidatePath("/investments");
  // Plan 7 ruling 12: it moves an account balance, so it moves the
  // projection's spendable base — and ruling 9b's Goals denominator, plus
  // (this being an ordinary expense) the six-month average behind a
  // months-of-expenses fund target.
  revalidatePath("/bills");
  revalidatePath("/goals");
  // F3: /settings/accounts renders a per-account balance off the same
  // account_balances view, so it belongs to this enumeration too.
  revalidatePath("/settings/accounts");
}

/** Business cash entries move account balances, which additionally surface
 *  on /transactions, /quick and /investments (ruling 20 + Plan-4 audit
 *  convention). */
function revalidateBusinessCashPaths(): void {
  revalidateNetWorthPaths();
  revalidatePath("/transactions");
  revalidatePath("/quick");
  revalidatePath("/investments");
  // Plan 7 ruling 12: same reason as a liability payment — it moves cash;
  // ruling 9b for /goals, off the same account_balances enumeration.
  revalidatePath("/bills");
  revalidatePath("/goals");
  // F3: /settings/accounts renders a per-account balance off the same
  // account_balances view, so it belongs to this enumeration too.
  revalidatePath("/settings/accounts");
}

// ---- manual assets ----

export async function createManualAsset(
  input: ManualAssetCreateInput,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performCreateManualAsset(supabase, input);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function updateManualAsset(
  id: string,
  patch: ManualAssetPatchInput,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateManualAsset(supabase, id, patch);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function archiveManualAsset(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveManualAsset(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function unarchiveManualAsset(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUnarchiveManualAsset(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function setManualAssetValue(
  asset_id: string,
  value_sen: number,
  noted_on: string,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetManualAssetValue(supabase, asset_id, value_sen, noted_on);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

// ---- liabilities ----

export async function createLiability(input: LiabilityCreateInput): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performCreateLiability(supabase, input);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function updateLiability(
  id: string,
  patch: LiabilityPatchInput,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateLiability(supabase, id, patch);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function archiveLiability(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveLiability(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function unarchiveLiability(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUnarchiveLiability(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function setLiabilityBalance(
  liability_id: string,
  balance_sen: number,
  noted_on: string,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetLiabilityBalance(supabase, liability_id, balance_sen, noted_on);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function recordLiabilityPayment(
  input: LiabilityPaymentInput,
): Promise<LiabilityPaymentResult> {
  const supabase = await createServerSupabase();
  const result = await performRecordLiabilityPayment(supabase, input);
  // On a PARTIAL failure the expense half landed — revalidate so no page
  // shows stale money while the visible error asks for a retry.
  if (result.ok || result.partial) revalidatePaymentPaths();
  return result;
}

// ---- business investments ----

export async function createBusiness(input: BusinessCreateInput): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performCreateBusiness(supabase, input);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function updateBusiness(
  id: string,
  patch: BusinessPatchInput,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateBusiness(supabase, id, patch);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function archiveBusiness(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveBusiness(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function unarchiveBusiness(id: string): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUnarchiveBusiness(supabase, id);
  if (result.ok) revalidateNetWorthPaths();
  return result;
}

export async function saveBusinessEntry(input: BusinessEntryInput): Promise<BusinessEntryResult> {
  const supabase = await createServerSupabase();
  const result = await performSaveBusinessEntry(supabase, input);
  if (result.ok) {
    if (result.cash) revalidateBusinessCashPaths();
    else revalidateNetWorthPaths();
  }
  return result;
}

export async function deleteBusinessEntry(id: string): Promise<BusinessEntryResult> {
  const supabase = await createServerSupabase();
  const result = await performDeleteBusinessEntry(supabase, id);
  if (result.ok) {
    if (result.cash) revalidateBusinessCashPaths();
    else revalidateNetWorthPaths();
  }
  return result;
}
