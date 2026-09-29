// Demo-account seeder: creates (or resets) ONE demo user on a Supabase
// project and fills it with realistic fake data — accounts, ~a month of
// transactions, this month's budget, an emergency fund, a car loan, a stock
// holding and recurring rules.
//
// Run it yourself:   npm run seed:demo
//
// - Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
//   environment or .env.local; if the key is missing it is prompted for
//   (hidden input). Neither value is ever printed.
// - The demo password is typed at run time (hidden, entered twice). It is
//   never written to disk or logged.
// - Safe to re-run: an existing demo user keeps its id, gets the new
//   password, and has every one of ITS rows wiped and re-seeded.
//
// Isolation: the service-role key bypasses RLS, so this script scopes itself.
// The target email must end in `.example` (RFC 2606 reserved — no real person
// can own it), the user id is resolved from that exact email, and every
// delete/insert carries that user id explicitly. Shared tables (`prices`,
// `fx_rates`, `rate_limits`) are never written: the holding uses a manual
// price and every account is in MYR.
import { createInterface } from "node:readline";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local", quiet: true });

const DEMO_EMAIL = (process.env.DEMO_EMAIL ?? "demo@duit-demo.example").toLowerCase();
const TZ = "Asia/Kuala_Lumpur";

// ------------------------------------------------------------------ prompts

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Reads a line without echoing it (for the password / key). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error("Hidden input needs an interactive terminal."));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// -------------------------------------------------------------------- dates

/** Today's calendar date in Kuala Lumpur, as a UTC-midnight Date. */
function klToday() {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  return new Date(`${iso}T00:00:00Z`);
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);
const firstOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
/** The date of `day` in d's month, clamped to the month's length. */
function dayInMonth(monthStart, day) {
  const last = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, last.getUTCDate())));
}
/** Next occurrence of a monthly `day` strictly after `today`. */
function nextMonthly(today, day) {
  const thisMonth = dayInMonth(firstOfMonth(today), day);
  return thisMonth > today ? thisMonth : dayInMonth(addMonths(today, 1), day);
}

// ------------------------------------------------------------ deterministic

/** Small seeded PRNG so every reset produces the same-looking month. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260801);
const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) / 10) * 10; // sen, 10-sen steps
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

// --------------------------------------------------------------- the data

// Mirrors public.seed_default_categories() (which keys on auth.uid() and so
// cannot run under the service role).
const DEFAULT_CATEGORIES = [
  ["Food", "expense", "needs", ["Groceries", "Eating out", "Delivery"]],
  ["Transport", "expense", "needs", ["Petrol", "Tolls", "Parking", "Grab"]],
  ["Bills & utilities", "expense", "needs", ["Rent", "Electricity", "Water", "Internet", "Phone"]],
  ["Shopping", "expense", "wants", []],
  ["Entertainment", "expense", "wants", ["Subscriptions"]],
  ["Health", "expense", "needs", []],
  ["Family", "expense", "needs", []],
  ["Education", "expense", "needs", []],
  ["Travel", "expense", "wants", []],
  ["Zakat & donations", "expense", "needs", []],
  ["Salary", "income", "savings", []],
  ["Bonus", "income", "savings", []],
  ["Freelance", "income", "savings", []],
  ["Interest", "income", "savings", []],
  ["Dividends", "income", "savings", []],
];

// Child-first, so composite FKs never block a delete. Every table here has a
// user_id column; net_worth_snapshots is written by the daily cron.
const USER_TABLES = [
  "transaction_splits",
  "reimbursement_payments",
  "fund_contributions",
  "trades",
  "liability_values",
  "manual_asset_values",
  "business_investment_entries",
  "net_worth_snapshots",
  "budget_changes",
  "budget_allocations",
  "budget_months",
  "parser_aliases",
  "api_tokens",
  "transactions",
  "recurring_rules",
  "import_batches",
  "holdings",
  "liabilities",
  "manual_assets",
  "business_investments",
  "funds",
  "allocation_presets",
  "user_settings",
];

// -------------------------------------------------------------- supabase

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function findUserByEmail(admin, email) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listing users: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
}

async function wipeDemoRows(db, userId) {
  for (const table of USER_TABLES) {
    await must(db.from(table).delete().eq("user_id", userId), `clearing ${table}`);
  }
  // Sub-categories before their parents (categories.parent_id FK).
  await must(
    db.from("categories").delete().eq("user_id", userId).not("parent_id", "is", null),
    "clearing sub-categories",
  );
  await must(db.from("categories").delete().eq("user_id", userId), "clearing categories");
  await must(db.from("accounts").delete().eq("user_id", userId), "clearing accounts");
}

async function seed(db, userId) {
  const today = klToday();
  const month = firstOfMonth(today);
  const lastMonth = addMonths(month, -1);
  const u = (row) => ({ user_id: userId, ...row });

  // Categories: parents, then children; returns name -> id.
  const cat = {};
  for (const [name, kind, tag, children] of DEFAULT_CATEGORIES) {
    const [parent] = await must(
      db.from("categories").insert(u({ name, kind, tag })).select("id"),
      `category ${name}`,
    );
    cat[name] = parent.id;
    if (children.length) {
      const rows = await must(
        db
          .from("categories")
          .insert(children.map((c) => u({ name: c, kind, tag, parent_id: parent.id })))
          .select("id, name"),
        `sub-categories of ${name}`,
      );
      for (const r of rows) cat[r.name] = r.id;
    }
  }

  // Accounts.
  const accountRows = await must(
    db
      .from("accounts")
      .insert([
        u({ name: "Maybank Savings", type: "bank", starting_balance_sen: 850_000, allocation_bucket: "bank" }),
        u({ name: "Touch 'n Go eWallet", type: "ewallet", starting_balance_sen: 30_000, allocation_bucket: "exclude" }),
        u({ name: "Cash", type: "cash", starting_balance_sen: 20_000, allocation_bucket: "exclude" }),
        u({ name: "Brokerage Cash", type: "brokerage", starting_balance_sen: 600_000, allocation_bucket: "equities" }),
      ])
      .select("id, name"),
    "accounts",
  );
  const acct = Object.fromEntries(accountRows.map((a) => [a.name, a.id]));
  const bank = acct["Maybank Savings"];
  const ewallet = acct["Touch 'n Go eWallet"];
  const cash = acct["Cash"];
  const brokerage = acct["Brokerage Cash"];

  await must(
    db.from("user_settings").insert(u({ onboarded_at: new Date().toISOString(), default_account_id: bank })),
    "user settings",
  );

  // Recurring rules — next_run is always in the future, so the daily cron
  // does not immediately post a duplicate of the seeded occurrences below.
  const rules = await must(
    db
      .from("recurring_rules")
      .insert([
        u({ name: "Salary", type: "income", amount_sen: 650_000, account_id: bank, category_id: cat["Salary"], freq: "monthly", day_of_month: 25, next_run: iso(nextMonthly(today, 25)) }),
        u({ name: "Rent", type: "expense", amount_sen: 180_000, account_id: bank, category_id: cat["Rent"], freq: "monthly", day_of_month: 1, next_run: iso(nextMonthly(today, 1)) }),
        u({ name: "Netflix", type: "expense", amount_sen: 5_500, account_id: bank, category_id: cat["Subscriptions"], freq: "monthly", day_of_month: 7, next_run: iso(nextMonthly(today, 7)) }),
        u({ name: "Unifi fibre", type: "expense", amount_sen: 12_900, account_id: bank, category_id: cat["Internet"], freq: "monthly", day_of_month: 12, next_run: iso(nextMonthly(today, 12)) }),
      ], { defaultToNull: false })
      .select("id, name, type, amount_sen, account_id, category_id, day_of_month"),
    "recurring rules",
  );

  // ~A month of transactions: the window is the 31 days ending today.
  const start = addDays(today, -30);
  const tx = [];
  const inWindow = (d) => d >= start && d <= today;

  for (const r of rules) {
    for (const m of [lastMonth, month]) {
      const d = dayInMonth(m, r.day_of_month);
      if (!inWindow(d)) continue;
      tx.push(u({ type: r.type, amount_sen: r.amount_sen, account_id: r.account_id, category_id: r.category_id, date: iso(d), note: r.name, source: "recurring", recurring_rule_id: r.id }));
    }
  }

  const daily = [
    { cat: "Eating out", acct: ewallet, notes: ["Nasi lemak", "Mamak supper", "Chicken rice", "Kopitiam lunch", "Banana leaf"], lo: 900, hi: 3_500, p: 0.75 },
    { cat: "Groceries", acct: bank, notes: ["Jaya Grocer", "Lotus's", "Village Grocer", "99 Speedmart"], lo: 4_000, hi: 18_000, p: 0.2 },
    { cat: "Grab", acct: ewallet, notes: ["Grab to office", "Grab home"], lo: 1_200, hi: 2_800, p: 0.2 },
    { cat: "Delivery", acct: ewallet, notes: ["GrabFood", "foodpanda"], lo: 1_800, hi: 4_500, p: 0.15 },
    { cat: "Petrol", acct: bank, notes: ["Petronas RON95", "Shell RON95"], lo: 5_000, hi: 8_000, p: 0.12 },
    { cat: "Tolls", acct: ewallet, notes: ["SPRINT toll", "NPE toll"], lo: 210, hi: 690, p: 0.2 },
    { cat: "Parking", acct: cash, notes: ["Parking — KLCC", "Street parking"], lo: 300, hi: 1_200, p: 0.12 },
  ];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    for (const k of daily) {
      if (rand() < k.p) {
        tx.push(u({ type: "expense", amount_sen: between(k.lo, k.hi), account_id: k.acct, category_id: cat[k.cat], date: iso(d), note: pick(k.notes) }));
      }
    }
  }

  const oneOffs = [
    [3, "expense", 11_800, bank, "Electricity", "TNB bill"],
    [5, "expense", 2_450, bank, "Water", "Air Selangor"],
    [9, "expense", 4_800, bank, "Phone", "Postpaid plan"],
    [11, "expense", 18_990, bank, "Shopping", "Uniqlo"],
    [14, "expense", 6_500, cash, "Health", "Clinic visit"],
    [17, "expense", 20_000, bank, "Family", "Parents — monthly"],
    [20, "expense", 5_000, bank, "Zakat & donations", "Mosque donation"],
    [22, "income", 85_000, bank, "Freelance", "Logo design gig"],
    [27, "income", 1_240, bank, "Interest", "Savings interest"],
  ];
  for (const [offset, type, amount_sen, account_id, c, note] of oneOffs) {
    tx.push(u({ type, amount_sen, account_id, category_id: cat[c], date: iso(addDays(start, offset)), note }));
  }
  // Transfers: eWallet reloads and cash withdrawals.
  for (const offset of [2, 9, 16, 23]) {
    tx.push(u({ type: "transfer", amount_sen: 20_000, account_id: bank, transfer_account_id: ewallet, date: iso(addDays(start, offset)), note: "TNG reload" }));
  }
  tx.push(u({ type: "transfer", amount_sen: 20_000, account_id: bank, transfer_account_id: cash, date: iso(addDays(start, 8)), note: "ATM withdrawal" }));
  // One entry left for review, as a quick-entry parse would.
  tx.push(u({ type: "expense", amount_sen: 2_300, account_id: ewallet, category_id: null, date: iso(today), note: "tealive", source: "nl", needs_review: true }));

  // defaultToNull: false — rows carry different keys, and without it PostgREST
  // sends NULL (not the column default) for each key a row omits.
  await must(db.from("transactions").insert(tx, { defaultToNull: false }), "transactions");

  // Budget for the current month.
  await must(
    db.from("budget_months").insert(u({ month: iso(month), expected_income_sen: 650_000, savings_planned_sen: 100_000, savings_allocated_sen: 100_000 })),
    "budget month",
  );
  const plan = [
    ["Rent", 180_000], ["Groceries", 60_000], ["Eating out", 60_000], ["Delivery", 15_000],
    ["Petrol", 25_000], ["Grab", 15_000], ["Tolls", 6_000], ["Parking", 5_000],
    ["Electricity", 15_000], ["Water", 3_000], ["Internet", 12_900], ["Phone", 4_800],
    ["Subscriptions", 5_500], ["Shopping", 30_000], ["Health", 10_000], ["Family", 20_000],
  ];
  await must(
    db.from("budget_allocations").insert(plan.map(([c, sen]) => u({ month: iso(month), category_id: cat[c], planned_sen: sen, allocated_sen: sen }))),
    "budget allocations",
  );

  // Fund: an emergency fund targeting six months of expenses.
  const [fund] = await must(
    db.from("funds").insert(u({ name: "Emergency fund", kind: "emergency", target_months: 6, monthly_contribution_sen: 50_000, priority: 0 })).select("id"),
    "fund",
  );
  await must(
    db.from("fund_contributions").insert([-2, -1, 0].map((n) => u({ fund_id: fund.id, month: iso(addMonths(month, n)), amount_sen: 50_000 }))),
    "fund contributions",
  );

  // Liability: a car loan with two month-end balance marks.
  const [loan] = await must(
    db.from("liabilities").insert(u({ name: "Car loan — Myvi", kind: "loan", interest_rate_bp: 320, minimum_payment_sen: 62_000, planned_payment_sen: 80_000 })).select("id"),
    "liability",
  );
  await must(
    db.from("liability_values").insert([
      u({ liability_id: loan.id, balance_sen: 3_240_000, noted_on: iso(addDays(month, -1)) }),
      u({ liability_id: loan.id, balance_sen: 3_180_000, noted_on: iso(today) }),
    ]),
    "liability values",
  );

  // Holding: a Bursa stock on a manual price (no shared `prices` row).
  const [holding] = await must(
    db.from("holdings").insert(u({ symbol: "MAYBANK", name: "Malayan Banking Bhd", kind: "stock", currency: "MYR", price_source: "manual", manual_price_e8: 1_025_000_000 })).select("id"),
    "holding",
  );
  // 500 units @ RM 9.60 + RM 12.00 fees = RM 4,812.00 out of the brokerage cash.
  await must(
    db.from("trades").insert(u({ holding_id: holding.id, account_id: brokerage, side: "buy", date: iso(addDays(start, 6)), quantity_e8: 50_000_000_000, price_e8: 960_000_000, fees_cent: 1_200, cash_delta_sen: 481_200, note: "Initial position" })),
    "trade",
  );

  return { transactions: tx.length };
}

// ------------------------------------------------------------------- main

async function main() {
  if (!DEMO_EMAIL.endsWith(".example")) {
    throw new Error(`Refusing: DEMO_EMAIL must end in ".example" (got "${DEMO_EMAIL}").`);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set (env or .env.local).");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || (await askHidden("Supabase service-role key: "));
  if (!key) throw new Error("No service-role key given.");

  console.log(`\nTarget project: ${new URL(url).host}`);
  console.log(`Demo user:      ${DEMO_EMAIL}`);
  console.log("This creates the demo user, or wipes and re-seeds ONLY that user's data.");
  if ((await ask('Type "yes" to continue: ')).toLowerCase() !== "yes") {
    console.log("Aborted.");
    return;
  }

  const password = await askHidden("Demo password (min 8 chars): ");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if ((await askHidden("Repeat password: ")) !== password) throw new Error("Passwords do not match.");

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let user = await findUserByEmail(db, DEMO_EMAIL);
  if (user) {
    await must(db.auth.admin.updateUserById(user.id, { password, email_confirm: true }), "updating demo password");
    console.log("Existing demo user found — resetting its data.");
  } else {
    const created = await must(
      db.auth.admin.createUser({ email: DEMO_EMAIL, password, email_confirm: true }),
      "creating demo user",
    );
    user = created.user;
    console.log("Demo user created.");
  }
  // Belt and braces: never proceed on anything but the exact demo address.
  if (!user?.id || (user.email ?? "").toLowerCase() !== DEMO_EMAIL) {
    throw new Error("Resolved user does not match the demo email — aborting.");
  }

  await wipeDemoRows(db, user.id);
  const { transactions } = await seed(db, user.id);
  console.log(`Seeded: 4 accounts, ${transactions} transactions, budget, fund, loan, holding, 4 recurring rules.`);
  console.log(`Log in as ${DEMO_EMAIL} with the password you just typed.`);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
