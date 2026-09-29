import { randomBytes, randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { performCreateToken } from "../src/db/tokens";

// Local-stack env only (mirrors src/db/test-clients.ts / vitest.setup.ts).
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.test" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Local test credential for the `supabase start` stack. Setup below
 * creates the user if missing (e.g. after `supabase db reset`) — local dev
 * stack only, never a production credential, nothing secret is committed
 * (same pattern as src/db/test-clients.ts).
 */
const TEST_EMAIL = "e2e@test.local";
const TEST_PASSWORD = "test-password-123!";

let anon: SupabaseClient;
let apiToken: string;

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/** Ensure the fixture account exists for this user, returning its id. */
async function ensureAccount(
  client: SupabaseClient,
  name: string,
  type: string,
): Promise<string> {
  const { data: existing, error: findErr } = await client
    .from("accounts")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return (existing as { id: string }).id;

  const { data: created, error: insertErr } = await client
    .from("accounts")
    .insert({ name, type })
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  return (created as { id: string }).id;
}

async function setupFixtures(): Promise<void> {
  const admin = adminClient();

  // Ensure the test user exists (idempotent: local stack may have been
  // `supabase db reset` since it was last created). Create-and-tolerate-
  // duplicate rather than a listUsers scan — the default page holds 50 users
  // and vitest's disposable test users push this one off page 1.
  const { error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (createErr && !/already been registered/i.test(createErr.message)) {
    throw createErr;
  }

  anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error: signInErr } = await anon.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (signInErr) throw signInErr;

  // Fixture accounts the NL parser needs for a confident "grab 18 tng" /
  // "grab 19 tng" parse (account "tng" -> TnG eWallet, unambiguous word match).
  await ensureAccount(anon, "TnG eWallet", "ewallet");
  const maybankId = await ensureAccount(anon, "Maybank", "bank");

  // Idempotent: no-ops if this user already has categories.
  const { error: seedErr } = await anon.rpc("seed_default_categories");
  if (seedErr) throw seedErr;

  // Satisfy the onboarding middleware deterministically (accounts already
  // do via hasAccounts, but pin onboarded_at + a default account too, per
  // task instructions) and give quick-entry a fallback account.
  const { error: settingsErr } = await anon
    .from("user_settings")
    .upsert(
      { default_account_id: maybankId, onboarded_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (settingsErr) throw settingsErr;

  // Token for the endpoint round-trip test — created via the same
  // performCreateToken core the app uses (src/db/tokens.ts), through a
  // signed-in client so it lands under this user via RLS.
  const created = await performCreateToken(anon, "e2e-quick-entry");
  if (!created.token) throw new Error(created.error ?? "token creation failed");
  apiToken = created.token;
}

test.describe.serial("critical quick-entry flow", () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    await setupFixtures();
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("1. login lands on an authed page", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(TEST_EMAIL);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/transactions/);
    await expect(page).toHaveURL(/\/transactions/);
  });

  test("2. prefilled quick add parses confidently and saves", async () => {
    await page.goto("/quick?text=" + encodeURIComponent("grab 18 tng"));

    // Preview line renders as a single <p> text node: "RM 18.00 · Grab · TnG eWallet".
    const preview = page.locator("p", { hasText: "RM 18.00" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Grab");
    await expect(preview).toContainText("TnG eWallet");

    await page.getByRole("button", { name: /^Save/ }).click();

    // Recent list re-renders (router.refresh()) showing the new entry.
    await expect(page.getByText(/RM 18\.00/).first()).toBeVisible();
  });

  test("3. endpoint round-trip is idempotent", async ({ request }) => {
    // A per-run nonce in the note text scopes the /transactions row-count
    // check to just this run's insert, via the page's ?q= note search — the
    // shared local test user accumulates rows across repeated runs (accepted
    // per task notes), so counting by amount alone isn't safe run-to-run.
    // The nonce is an extra, unmatched token; parsing still resolves amount
    // (19.00), category (Grab, via "grab") and account (TnG eWallet, via
    // "tng") from the rest of the text.
    const nonce = randomBytes(4).toString("hex");
    const text = `grab 19 tng ${nonce}`;
    const clientId = randomUUID();

    const first = await request.post("/api/quick-entry", {
      headers: { Authorization: `Bearer ${apiToken}` },
      data: { text, clientId },
    });
    expect(first.ok()).toBeTruthy();
    const firstBody = (await first.json()) as { message: string };
    expect(firstBody.message).toContain("RM");

    await page.goto(`/transactions?q=${nonce}`);
    const matchingCells = page.getByRole("cell", { name: /RM 19\.00/ });
    await expect(matchingCells).toHaveCount(1);

    // Same clientId again: must not duplicate.
    const second = await request.post("/api/quick-entry", {
      headers: { Authorization: `Bearer ${apiToken}` },
      data: { text, clientId },
    });
    expect(second.ok()).toBeTruthy();

    await page.reload();
    await expect(matchingCells).toHaveCount(1);
  });
});
