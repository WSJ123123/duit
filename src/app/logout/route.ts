import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerSupabase } from "@/db/server";
import { ONB_COOKIE } from "@/lib/onboarding-cookie";

export async function POST() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  // Drop the onboarding cookie-cache with the session — the next user in
  // this browser must not inherit (or even carry) a stale onboarded marker.
  (await cookies()).delete(ONB_COOKIE);
  redirect("/login");
}
