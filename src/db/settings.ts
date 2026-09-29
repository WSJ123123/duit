import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { importMappingSchema, type ImportMapping } from "@/lib/import";

export interface Settings {
  show_tips: boolean;
  default_account_id: string | null;
  onboarded_at: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  show_tips: true,
  default_account_id: null,
  onboarded_at: null,
};

/** Returns the caller's settings row, or the defaults when none exists yet. */
export async function getSettings(supabase: SupabaseClient): Promise<Settings> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("show_tips, default_account_id, onboarded_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_SETTINGS;
  return data as Settings;
}

export interface SettingsPatch {
  showTips?: boolean;
  defaultAccountId?: string | null;
  onboardedAt?: string | null;
}

const settingsPatchSchema = z.object({
  showTips: z.boolean().optional(),
  defaultAccountId: z.string().min(1).nullable().optional(),
  onboardedAt: z.string().nullable().optional(),
});

export type SettingsWriteResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * Upsert-style write: merges `patch` onto the caller's existing row (or the
 * defaults, if none exists yet) and writes the result. `user_id` defaults to
 * auth.uid() per the table definition, so RLS + the composite FK on
 * default_account_id are the only guards needed against cross-user writes.
 */
export async function performUpdateSettings(
  supabase: SupabaseClient,
  patch: SettingsPatch,
): Promise<SettingsWriteResult> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? first.message : "invalid settings patch" };
  }
  const p = parsed.data;

  const current = await getSettings(supabase);
  const next = {
    show_tips: p.showTips ?? current.show_tips,
    default_account_id:
      p.defaultAccountId !== undefined ? p.defaultAccountId : current.default_account_id,
    onboarded_at: p.onboardedAt !== undefined ? p.onboardedAt : current.onboarded_at,
  };

  const { error } = await supabase.from("user_settings").upsert(next, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true };
}

/**
 * Plan 8 ruling 16: the last column mapping used per account, keyed by
 * account id. A preference — `user_settings` is outside the export by design.
 * Each entry is zod-validated on read and an entry that no longer parses is
 * dropped on its own (the owner rebuilds it in four clicks), never the map.
 */
export async function getImportMappings(
  supabase: SupabaseClient,
): Promise<Record<string, ImportMapping>> {
  const { data, error } = await supabase.from("user_settings").select("import_mappings").maybeSingle();
  if (error) throw error;
  const stored = z.record(z.string(), z.unknown()).safeParse(data?.import_mappings ?? {});
  const mappings: Record<string, ImportMapping> = {};
  if (!stored.success) return mappings;
  for (const [accountId, value] of Object.entries(stored.data)) {
    const parsed = importMappingSchema.safeParse(value);
    if (parsed.success) mappings[accountId] = parsed.data;
  }
  return mappings;
}

/** Ruling 16's remember-per-account: merges one account's mapping into the
 *  stored map. The only write the import preview makes. Plan 9 ruling 7:
 *  the entry is stamped `saved_at` (ISO) for v7's `last used … <date>`;
 *  `header_line` rides in the mapping as given. */
export async function saveImportMapping(
  supabase: SupabaseClient,
  accountId: string,
  mapping: ImportMapping,
): Promise<SettingsWriteResult> {
  const parsed = importMappingSchema.safeParse(mapping);
  if (!parsed.success) return { ok: false, error: "invalid import mapping" };
  const current = await getImportMappings(supabase);
  const next = { ...current, [accountId]: { ...parsed.data, saved_at: new Date().toISOString() } };
  const { error } = await supabase
    .from("user_settings")
    .upsert({ import_mappings: next }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true };
}
