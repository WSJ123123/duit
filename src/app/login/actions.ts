"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAdminClient } from "@/db/admin";
import { createServerSupabase } from "@/db/server";
import { checkRateLimit, clientIp, LOGIN_RATE_LIMIT } from "@/lib/rate-limit";

const Creds = z.object({ email: z.string().email(), password: z.string().min(8) });

export async function login(_prev: { error?: string }, formData: FormData) {
  const allowed = await checkRateLimit(createAdminClient(), {
    key: `login:${clientIp(await headers())}`,
    ...LOGIN_RATE_LIMIT,
    now: new Date().toISOString(),
  });
  if (!allowed) return { error: "Too many attempts. Try again in a few minutes." };
  const parsed = Creds.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter a valid email and password." };
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Wrong email or password." };
  redirect("/transactions");
}
