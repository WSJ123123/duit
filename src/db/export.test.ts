import { describe, it, expect, beforeAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { adminClient } from "@/db/test-clients";
import { getFunds } from "@/db/funds";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type CookieRec = { name: string; value: string };

/**
 * The route authenticates via `createServerSupabase()`, which reads cookies
 * through `next/headers` — real inside a Next.js request, but next/headers'
 * `cookies()` needs Next's own request-scoped AsyncLocalStorage, which does
 * not exist when a test imports and calls `GET()` directly. There is no
 * existing precedent in this repo for calling a session-authed route from a
 * test (grep confirms), so this file builds the minimal harness: mock
 * next/headers to serve cookies from an in-memory jar, and populate that jar
 * by constructing a session client the exact same way the app does elsewhere
 * (`@supabase/ssr`'s `createServerClient` + `auth.signInWithPassword`, see
 * src/app/login/actions.ts) — just pointed at the jar instead of the real
 * cookie store. Both the write (harness sign-in) and the read (route's
 * createServerSupabase) go through the same @supabase/ssr cookie
 * encoding/decoding, so no cookie format needs to be hand-rolled.
 */
let activeCookies: CookieRec[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => activeCookies,
    set: () => {},
  }),
}));

const { GET } = await import("@/app/api/export/route");

async function freshUserWithCreds(): Promise<{
  userId: string;
  email: string;
  password: string;
  client: SupabaseClient;
}> {
  const email = `test-${randomUUID()}@test.local`;
  const password = "test-password-123!";
  const admin = adminClient();
  const { data: createData, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) throw cErr;
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { userId: createData.user!.id, email, password, client };
}

/** Cookies as @supabase/ssr's own storage adapter would write them for this session. */
async function cookiesForSession(email: string, password: string): Promise<CookieRec[]> {
  const jar: CookieRec[] = [];
  const sessionClient = createServerClient(url, anon, {
    cookies: {
      getAll: () => jar,
      setAll: (list) => {
        for (const { name, value } of list) {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i] = { name, value };
          else jar.push({ name, value });
        }
      },
    },
  });
  const { error } = await sessionClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return jar;
}

async function seedFullSet(client: SupabaseClient, tag: string) {
  const { data: acct, error: acctErr } = await client
    .from("accounts")
    .insert({ name: `${tag} Bank`, type: "bank" })
    .select()
    .single();
  if (acctErr) throw acctErr;

  const { data: cat, error: catErr } = await client
    .from("categories")
    .insert({ name: `${tag} Cat`, kind: "expense" })
    .select()
    .single();
  if (catErr) throw catErr;

  // Plan 7: a fund is DERIVED (ruling 5) — reconstructing one from the zip
  // needs the fund row, its contributions AND the tagged transactions, so the
  // seed carries all three legs of that identity.
  const { data: fund, error: fundErr } = await client
    .from("funds")
    .insert({ name: `${tag} Road tax`, kind: "sinking", monthly_contribution_sen: 5000 })
    .select()
    .single();
  if (fundErr) throw fundErr;

  const { error: contribErr } = await client.from("fund_contributions").insert([
    { fund_id: fund!.id, month: "2026-08-01", amount_sen: 7700 },
    { fund_id: fund!.id, month: "2026-09-01", amount_sen: 12300 },
  ]);
  if (contribErr) throw contribErr;

  const { data: tx, error: txErr } = await client
    .from("transactions")
    .insert({
      type: "expense",
      amount_sen: 1800,
      account_id: acct!.id,
      category_id: cat!.id,
      note: `${tag} lunch`,
      fund_id: fund!.id,
    })
    .select()
    .single();
  if (txErr) throw txErr;

  // A second draw on the same fund: with one row on each side, a reconstruction
  // that summed nothing would still come out right by accident.
  const { error: tx2Err } = await client.from("transactions").insert({
    type: "expense",
    amount_sen: 4250,
    account_id: acct!.id,
    category_id: cat!.id,
    note: `${tag} road tax`,
    fund_id: fund!.id,
  });
  if (tx2Err) throw tx2Err;

  const { error: splitErr } = await client.from("transaction_splits").insert({
    transaction_id: tx!.id,
    category_id: cat!.id,
    amount_sen: 1800,
  });
  if (splitErr) throw splitErr;

  const { error: reimbErr } = await client.from("reimbursement_payments").insert({
    transaction_id: tx!.id,
    account_id: acct!.id,
    amount_sen: 500,
  });
  if (reimbErr) throw reimbErr;

  const { error: recErr } = await client.from("recurring_rules").insert({
    name: `${tag} rent`,
    type: "expense",
    amount_sen: 5000,
    account_id: acct!.id,
    category_id: cat!.id,
    freq: "monthly",
    day_of_month: 1,
    next_run: "2026-09-01",
  });
  if (recErr) throw recErr;

  const { error: aliasErr } = await client.from("parser_aliases").insert({
    phrase: `${tag}-alias`,
    category_id: cat!.id,
  });
  if (aliasErr) throw aliasErr;

  return {
    acctId: acct!.id as string,
    catId: cat!.id as string,
    txId: tx!.id as string,
    fundId: fund!.id as string,
  };
}

let a: SupabaseClient, b: SupabaseClient;
let aEmail: string, aPassword: string, bEmail: string, bPassword: string;
let cEmail: string, cPassword: string;
let aFundId: string;

beforeAll(async () => {
  const ua = await freshUserWithCreds();
  const ub = await freshUserWithCreds();
  a = ua.client;
  b = ub.client;
  aEmail = ua.email;
  aPassword = ua.password;
  bEmail = ub.email;
  bPassword = ub.password;

  ({ fundId: aFundId } = await seedFullSet(a, "A"));
  await seedFullSet(b, "B");

  // Plan 8 ruling 14: a third user whose ONE table holds 1,200 rows —
  // PostgREST truncates an unpaged select at 1000 with HTTP 200 and no flag
  // (finding #19), so a backup that looked complete would silently drop 200.
  const uc = await freshUserWithCreds();
  cEmail = uc.email;
  cPassword = uc.password;
  const cAcct = await uc.client.from("accounts").insert({ name: "C Bank", type: "bank" }).select().single();
  if (cAcct.error) throw cAcct.error;
  const cRows = Array.from({ length: 1200 }, () => ({
    type: "expense",
    amount_sen: 1,
    account_id: cAcct.data.id,
    date: "2077-04-01",
    note: "C paging row",
  }));
  const cIns = await uc.client.from("transactions").insert(cRows);
  if (cIns.error) throw cIns.error;
}, 60_000);

async function unzipResponse(res: Response): Promise<JSZip> {
  const buf = await res.arrayBuffer();
  return JSZip.loadAsync(buf);
}

describe("GET /api/export", () => {
  it("401s with no session", async () => {
    activeCookies = [];
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("streams a zip of exactly the calling user's data (RLS proof) with the seeded amount as exact sen", async () => {
    activeCookies = await cookiesForSession(aEmail, aPassword);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("duit-export-");
    expect(res.headers.get("Content-Disposition")).toContain(".zip");

    const zip = await unzipResponse(res);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      "accounts.csv",
      "categories.csv",
      "fund_contributions.csv",
      "funds.csv",
      "import_batches.csv",
      "manifest.txt",
      "parser_aliases.csv",
      "recurring_rules.csv",
      "reimbursement_payments.csv",
      "transaction_splits.csv",
      "transactions.csv",
    ]);
    // Neither excluded table gets a file.
    expect(zip.files["user_settings.csv"]).toBeUndefined();
    expect(zip.files["api_tokens.csv"]).toBeUndefined();

    const txCsv = await zip.files["transactions.csv"]!.async("string");
    const txLines = txCsv.trim().split("\r\n");
    // header + exactly the 2 seeded transactions for A.
    expect(txLines).toHaveLength(3);
    // Plan 8: the batch tag rides along, or an import is not reconstructable.
    expect(txLines[0]).toContain("import_batch_id");
    const lunch = txLines.find((l) => l.includes("A lunch"))!;
    expect(lunch).toContain("1800");
    expect(lunch).not.toMatch(/18\.00/);

    const manifest = await zip.files["manifest.txt"]!.async("string");
    expect(manifest).toContain("transactions.csv: 2 rows");
    expect(manifest).toContain("user_settings");
    expect(manifest).toContain("api_tokens");
  });

  it("RECONSTRUCTS a fund's balance from the zip alone — the only claim that matters", async () => {
    // Ruling 5: balance = Σ fund_contributions − Σ tagged transactions. Three
    // legs, and the zip is only a real backup if all three survive it. So this
    // does not check that files exist — it rebuilds the number from the CSVs
    // the way a person restoring from the zip would, and holds it against what
    // the live query layer derives from the database.
    activeCookies = await cookiesForSession(aEmail, aPassword);
    const zip = await unzipResponse(await GET());

    const rows = (csv: string): Array<Record<string, string>> => {
      const [header, ...body] = csv.trim().split("\r\n");
      const cols = header!.split(",");
      // The exported fields here carry no commas, quotes or newlines (ids,
      // enums, integer sen, ISO dates), so a plain split is exact — and the
      // header assertion below is what keeps that true if a column moves.
      return body.map((line) => Object.fromEntries(line.split(",").map((v, i) => [cols[i]!, v])));
    };

    const funds = rows(await zip.files["funds.csv"]!.async("string"));
    const contributions = rows(await zip.files["fund_contributions.csv"]!.async("string"));
    const txCsv = await zip.files["transactions.csv"]!.async("string");
    expect(txCsv.split("\r\n")[0]).toContain("fund_id");
    const transactions = rows(txCsv);

    // Leg 1 — the fund itself is identifiable and carries its settings.
    const fund = funds.find((f) => f.id === aFundId)!;
    expect(fund.name).toBe("A Road tax");
    expect(fund.kind).toBe("sinking");
    expect(fund.monthly_contribution_sen).toBe("5000");

    // Legs 2 and 3 — the two halves of the identity, summed from the CSVs.
    const contributed = contributions
      .filter((c) => c.fund_id === aFundId)
      .reduce((sum, c) => sum + Number(c.amount_sen), 0);
    const drawn = transactions
      .filter((t) => t.fund_id === aFundId)
      .reduce((sum, t) => sum + Number(t.amount_sen), 0);
    expect(contributed).toBe(20_000); // 7,700 + 12,300, both rows survived
    expect(drawn).toBe(6_050); //        1,800 + 4,250, both rows survived

    // The reconstruction, against the live derivation. Drop any one of the
    // three legs from EXPORT_TABLES and this stops matching.
    const live = await getFunds(a, "2026-08-20");
    const liveFund = live.funds.find((f) => f.id === aFundId)!;
    expect(contributed - drawn).toBe(13_950);
    expect(contributed - drawn).toBe(liveFund.balance_sen);

    const manifest = await zip.files["manifest.txt"]!.async("string");
    expect(manifest).toContain("funds.csv: 1 rows");
    expect(manifest).toContain("fund_contributions.csv: 2 rows");
  });

  it("exports every one of 1,200 rows in one table — past PostgREST's 1000-row cap (ruling 14)", async () => {
    activeCookies = await cookiesForSession(cEmail, cPassword);
    const res = await GET();
    expect(res.status).toBe(200);
    const zip = await unzipResponse(res);
    const txCsv = await zip.files["transactions.csv"]!.async("string");
    const txLines = txCsv.trim().split("\r\n");
    expect(txLines).toHaveLength(1201); // header + 1200; an unpaged read gives 1001
    const manifest = await zip.files["manifest.txt"]!.async("string");
    expect(manifest).toContain("transactions.csv: 1200 rows");
  }, 60_000);

  it("user B's export contains none of user A's rows", async () => {
    activeCookies = await cookiesForSession(bEmail, bPassword);
    const res = await GET();
    expect(res.status).toBe(200);
    const zip = await unzipResponse(res);

    const txCsv = await zip.files["transactions.csv"]!.async("string");
    const txLines = txCsv.trim().split("\r\n");
    expect(txLines).toHaveLength(3); // header + B's own 2 transactions
    expect(txCsv).not.toContain("A lunch");

    const aliasCsv = await zip.files["parser_aliases.csv"]!.async("string");
    expect(aliasCsv).toContain("B-alias");
    expect(aliasCsv).not.toContain("A-alias");

    const fundsCsv = await zip.files["funds.csv"]!.async("string");
    expect(fundsCsv).toContain("B Road tax");
    expect(fundsCsv).not.toContain("A Road tax");
    const contribCsv = await zip.files["fund_contributions.csv"]!.async("string");
    expect(contribCsv).not.toContain(aFundId);
  });
});
