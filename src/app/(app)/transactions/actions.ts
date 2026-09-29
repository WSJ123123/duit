"use server";

import { createServerSupabase } from "@/db/server";
import { revalidateTxPaths } from "@/app/(app)/transactions/revalidate";
import {
  performUpsert,
  performUpdate,
  performDelete,
  type TxInput,
  type TxUpsertResult,
  type TxWriteResult,
} from "@/lib/transactions";

export async function upsertTransaction(input: TxInput): Promise<TxUpsertResult> {
  const supabase = await createServerSupabase();
  const result = await performUpsert(supabase, input);
  // Revalidating on `created: false` (the 23505 no-op) is LOAD-BEARING, not
  // waste: Bills' `Record now` shows its "already recorded" notice off this
  // very result, and the row only flips to recorded because of this refresh
  // (`RecordNow.tsx`, `TxFormSheet.tsx`'s create branch). Do not narrow it to
  // `result.created`.
  if (result.ok) revalidateTxPaths();
  return result;
}

export async function updateTransaction(id: string, input: TxInput): Promise<TxWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdate(supabase, id, input);
  if (result.ok) revalidateTxPaths();
  return result;
}

export async function deleteTransaction(id: string): Promise<TxWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performDelete(supabase, id);
  if (result.ok) revalidateTxPaths();
  return result;
}
