import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { requireUser, createServerSupabase } from "@/db/server";
import { getSettings } from "@/db/settings";
import { TipsProvider } from "@/components/Tip";
import { AmountsToggle, MoneyProvider } from "@/components/Money";
import { AMOUNTS_COOKIE } from "@/lib/money-mask";
import { ensureSeedCategories } from "./settings/categories/actions";
import { Sidebar } from "./Sidebar";
import { TabBar } from "@/components/TabBar";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  await ensureSeedCategories();

  const supabase = await createServerSupabase();
  const settings = await getSettings(supabase);

  // Plan 9 ruling 1: the amounts mask is per-device cookie state, read here on
  // the server so the very first paint is already masked (no flash of
  // figures). Absent means shown. The provider wraps the WHOLE layout — the
  // controls (Task 3) live in the Sidebar and beside the TabBar, outside main.
  const amountsHidden = (await cookies()).get(AMOUNTS_COOKIE)?.value === "hidden";

  return (
    <MoneyProvider initialHidden={amountsHidden}>
      <div className="flex min-h-screen" style={{ background: "var(--page)" }}>
        <div className="hidden md:flex">
          <Sidebar userEmail={user.email ?? ""} />
        </div>
        <main className="min-w-0 flex-1 p-6 pb-24 md:pb-6">
          <TipsProvider showTips={settings.show_tips}>{children}</TipsProvider>
        </main>
        <TabBar />
        {/* Ruling 5 / mockup v8 §15: the phone's fixed eye (md:hidden). */}
        <AmountsToggle variant="mobile" />
      </div>
    </MoneyProvider>
  );
}
