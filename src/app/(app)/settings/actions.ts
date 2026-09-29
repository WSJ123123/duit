"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createServerSupabase } from "@/db/server";
import { performUpdateSettings, type SettingsPatch } from "@/db/settings";
import { ONB_COOKIE, ONB_COOKIE_OPTS } from "@/lib/onboarding-cookie";

export async function updateSettings(patch: SettingsPatch): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performUpdateSettings(supabase, patch);
  if (!result.ok) return { error: result.error };

  // Keep the proxy's onboarding cookie-cache in sync: the wizard's finish
  // AND skip paths both land here with a non-null `onboardedAt`, so set the
  // cookie immediately (the very next request skips the DB checks instead
  // of re-running them once). Explicitly nulling `onboardedAt` (nothing in
  // the UI does today) drops the cache so the checks run again.
  if (patch.onboardedAt !== undefined) {
    const cookieStore = await cookies();
    if (patch.onboardedAt !== null) {
      const { data } = await supabase.auth.getUser();
      if (data.user) cookieStore.set(ONB_COOKIE, data.user.id, ONB_COOKIE_OPTS);
    } else {
      cookieStore.delete(ONB_COOKIE);
    }
  }

  revalidatePath("/", "layout");
  return {};
}
