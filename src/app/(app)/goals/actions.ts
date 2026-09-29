"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import {
  performCreateFund,
  performUpdateFund,
  performArchiveFund,
  performUnarchiveFund,
  performSetContribution,
  performApplyMonthlyContributions,
  type FundInput,
  type FundWriteResult,
  type FundApplyResult,
  type FundArchiveResult,
} from "@/db/funds";

/**
 * Thin "use server" wrappers over the Task-2 perform* functions (Task 3
 * contract).
 *
 * ⚠ THE REVALIDATION SET IS AN ENUMERATION OF EVERY PAGE THAT READS FUND
 * STATE. Keep it that way: add a fund read to a page ⇒ add the path here.
 * Task 3 derived the set from "which page shows a fund NUMBER", and Task 4
 * then put a fund LIST on four more pages, so the Task-7 audit found four
 * paths missing — the Session-9 T10 shape exactly (a path that needs
 * revalidation and does not get it). The reader enumeration, re-derived from
 * the call sites (`grep -rn 'getFunds(\|getFundOptions(' src`):
 *   /goals        getFunds — the page itself
 *   /investments  getFunds — ruling 20's Sinking fund reserve row
 *   /more         getFunds — the Goals summary row
 *   /budget       getBudgetMonth reads `funds` + `fund_contributions` for
 *                 ruling 4's savings row
 *   /transactions getFundOptions — ruling 7's "Paid from a fund" picker
 *   /quick        getFundOptions — same picker
 *   /dashboard    getFundOptions — same picker on the Add-entry sheet
 *   /bills        getFundOptions — same picker on `Record now`
 * Renaming, creating or archiving a fund changes what those pickers offer
 * (ruling 9a: a new tag may only pick an ACTIVE fund), so a stale one really
 * does misrepresent the product for the client Router Cache's 30s window.
 *
 * Deliberately NOT /net-worth: it is the one app page that reads no fund
 * state at all, and ruling 1 guarantees it never will — a fund is an earmark
 * that never enters net worth, the allocation pot or any snapshot part.
 */
function revalidateFundPaths(): void {
  revalidatePath("/goals");
  revalidatePath("/budget");
  revalidatePath("/investments");
  revalidatePath("/more");
  revalidatePath("/transactions");
  revalidatePath("/quick");
  revalidatePath("/dashboard");
  revalidatePath("/bills");
}

export async function createFund(input: FundInput): Promise<FundWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performCreateFund(supabase, input);
  if (result.ok) revalidateFundPaths();
  return result;
}

export async function updateFund(id: string, input: FundInput): Promise<FundWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateFund(supabase, id, input);
  if (result.ok) revalidateFundPaths();
  return result;
}

export async function archiveFund(id: string, month: string): Promise<FundArchiveResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveFund(supabase, id, month);
  if (result.ok) revalidateFundPaths();
  return result;
}

export async function unarchiveFund(id: string): Promise<FundWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUnarchiveFund(supabase, id);
  if (result.ok) revalidateFundPaths();
  return result;
}

export async function setContribution(
  id: string,
  month: string,
  amount_sen: number,
): Promise<FundWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetContribution(supabase, id, month, amount_sen);
  if (result.ok) revalidateFundPaths();
  return result;
}

export async function applyMonthlyContributions(month: string): Promise<FundApplyResult> {
  const supabase = await createServerSupabase();
  const result = await performApplyMonthlyContributions(supabase, month);
  if (result.ok) revalidateFundPaths();
  return result;
}
