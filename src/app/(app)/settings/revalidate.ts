import { revalidatePath } from "next/cache";

/**
 * Q10's shared settings-index revalidation.
 *
 * Four gaps were recorded at the Plan-7 audit, all cosmetic, all inside the
 * 30 s `staleTimes.dynamic` window, and all the same shape — a settings page
 * that renders something OTHER pages own:
 *   /settings            summary counts of accounts, categories, active
 *                        recurring rules and aliases (getSettingsSummaries)
 *   /settings/recurring   account + category DISPLAY NAMES on every rule row
 *   /settings/aliases     account + category display names on every alias row
 *   /settings/categories  the tag control, whose action lives in budget/
 *
 * So the fix is one enumeration, called from each action set that moves one
 * of those pages, rather than four more paths sprinkled across four files.
 *
 * ⚠ THIS IS A PLAIN MODULE, not "use server": the exported symbol has to stay
 * a directly callable function for the action modules that import it (a
 * "use server" export would become an async server-action reference).
 */
export function revalidateSettingsIndexPaths(): void {
  revalidatePath("/settings");
  revalidatePath("/settings/recurring");
  revalidatePath("/settings/aliases");
  revalidatePath("/settings/categories");
}
