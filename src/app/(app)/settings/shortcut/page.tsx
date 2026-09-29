import Link from "next/link";
import { headers } from "next/headers";
import { createServerSupabase } from "@/db/server";
import type { ApiTokenRow } from "@/db/tokens";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { GenerateTokenButton } from "./GenerateTokenButton";
import { ShortcutGuide } from "./ShortcutGuide";
import { revokeApiToken } from "./actions";

function formatTimestamp(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kuala_Lumpur",
  });
}

async function revokeTokenAction(id: string): Promise<void> {
  "use server";
  await revokeApiToken(id);
}

export default async function ShortcutSettingsPage() {
  const [supabase, headerList] = await Promise.all([createServerSupabase(), headers()]);

  const host = headerList.get("host") ?? "localhost:3000";
  const proto =
    headerList.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const appUrl = `${proto}://${host}`;

  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, name, created_at, last_used_at, revoked")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const tokens = data as ApiTokenRow[];

  return (
    <div className="flex flex-col gap-6">
      <nav className="eye-clear flex gap-4 text-sm max-md:flex-wrap" style={{ color: "var(--ink-3)" }}>
        <Link href="/settings">Settings</Link>
        <Link href="/settings/accounts">Accounts</Link>
        <Link href="/settings/categories">Categories</Link>
        <Link href="/settings/aliases">Aliases</Link>
        <span style={{ color: "var(--ink-1)", fontWeight: 600 }}>Shortcut</span>
        <Link href="/settings/recurring">Recurring</Link>
      </nav>

      <Card title="API tokens">
        <Tip className="mb-3">Authenticate the iOS Shortcut. Tokens only allow creating quick-entry transactions.</Tip>
        <ul className="flex flex-col">
          {tokens.length === 0 ? (
            <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
              No tokens yet. Generate one below to set up the Shortcut.
            </li>
          ) : null}
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex flex-wrap items-center gap-3 py-2.5"
              style={{ borderBottom: "1px solid var(--grid)" }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
                  {token.name}
                </span>
                <span className="text-xs" style={{ color: "var(--ink-3)" }}>
                  Created {formatTimestamp(token.created_at)} · Last used{" "}
                  {formatTimestamp(token.last_used_at)}
                </span>
              </span>
              {token.revoked ? (
                <span
                  className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs"
                  style={{ background: "var(--chip)", color: "var(--ink-2)" }}
                >
                  Revoked
                </span>
              ) : (
                <form action={revokeTokenAction.bind(null, token.id)}>
                  <Button type="submit" variant="ghost" className="px-2 py-1">
                    Revoke
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Generate token">
        <Tip className="mb-3">
          The token is shown once, right here, and never again — paste it straight into the
          Shortcut. Lost it? Revoke and generate a new one.
        </Tip>
        <GenerateTokenButton label="Generate token" />
      </Card>

      <ShortcutGuide appUrl={appUrl} />
    </div>
  );
}
