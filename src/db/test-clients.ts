import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export function adminClient(): SupabaseClient {
  return createClient(url, service, { auth: { persistSession: false } });
}

async function freshUser(): Promise<SupabaseClient> {
  const email = `test-${randomUUID()}@test.local`;
  const password = "test-password-123!";
  const admin = adminClient();
  const { error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) throw cErr;
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

/** Two signed-in clients for two brand-new users. */
export async function makeTestUsers(): Promise<{ a: SupabaseClient; b: SupabaseClient }> {
  return { a: await freshUser(), b: await freshUser() };
}
