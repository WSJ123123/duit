import JSZip from "jszip";
import { createServerSupabase } from "@/db/server";
import { klToday } from "@/lib/kl-date";
import { toCsv } from "@/lib/csv";
import { fetchAllPages, type PageResult } from "@/db/paging";

/**
 * One entry per exported user table: the CSV filename, the source table, and
 * an EXPLICIT column list (every user-visible column, ids included so
 * relations are reconstructable — see supabase/migrations/ for the
 * authoritative column sets). `user_settings` (device-local preference) and
 * `api_tokens` (token hashes) are intentionally excluded — noted in
 * manifest.txt rather than silently omitted.
 */
const EXPORT_TABLES: Array<{ file: string; table: string; columns: string[]; order?: string[] }> = [
  {
    file: "accounts.csv",
    table: "accounts",
    columns: ["id", "name", "type", "currency", "starting_balance_sen", "archived", "created_at"],
  },
  {
    file: "categories.csv",
    table: "categories",
    columns: ["id", "name", "kind", "parent_id", "tag", "archived", "created_at"],
  },
  {
    file: "transactions.csv",
    table: "transactions",
    columns: [
      "id", "type", "amount_sen", "account_id", "transfer_account_id", "received_sen",
      "category_id", "date", "note", "source", "needs_review", "expected_back_sen",
      "fund_id", "recurring_rule_id", "import_batch_id", "created_at", "updated_at",
    ],
    order: ["date", "id"],
  },
  {
    file: "transaction_splits.csv",
    table: "transaction_splits",
    columns: ["id", "transaction_id", "category_id", "amount_sen"],
  },
  {
    file: "reimbursement_payments.csv",
    table: "reimbursement_payments",
    columns: ["id", "transaction_id", "account_id", "amount_sen", "date", "note"],
  },
  {
    file: "recurring_rules.csv",
    table: "recurring_rules",
    columns: [
      "id", "name", "type", "amount_sen", "variable", "account_id", "transfer_account_id",
      "category_id", "freq", "day_of_month", "weekday", "month_of_year", "next_run",
      "active", "created_at",
    ],
  },
  {
    file: "parser_aliases.csv",
    table: "parser_aliases",
    columns: ["id", "phrase", "category_id", "account_id"],
  },
  // Plan 7: a fund is derived (ruling 5) — its balance is Σ contributions −
  // Σ tagged transactions — so BOTH of these plus transactions.fund_id above
  // are needed to reconstruct one from the zip. Any of the three missing and
  // the export looks complete while silently not being.
  {
    file: "funds.csv",
    table: "funds",
    columns: [
      "id", "name", "kind", "target_sen", "target_months", "target_date",
      "monthly_contribution_sen", "priority", "archived", "created_at",
    ],
  },
  {
    file: "fund_contributions.csv",
    table: "fund_contributions",
    columns: ["id", "fund_id", "month", "amount_sen", "created_at"],
  },
  // Plan 8: an import batch is what `transactions.import_batch_id` above
  // points at, so both travel or the tag is a dangling reference.
  {
    file: "import_batches.csv",
    table: "import_batches",
    columns: [
      "id", "account_id", "filename", "content_sha256", "row_count", "skipped_count",
      "needs_review_count", "unparseable_count", "undone_at", "created_at",
    ],
  },
];

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

/**
 * Full data export, zipped: one CSV per user table, run AS THE USER under
 * RLS via the session client — never the admin client, so the export is
 * exactly what the caller owns.
 */
export async function GET(): Promise<Response> {
  const supabase = await createServerSupabase();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return unauthorized();

  const dateStr = klToday(new Date());
  const zip = new JSZip();
  const manifestLines = [`Duit export — ${dateStr}`, ""];

  for (const { file, table, columns, order = ["id"] } of EXPORT_TABLES) {
    // Plan 8 ruling 14 (finding #19): an unpaged select is capped at 1000
    // rows with no error — a backup that looks complete while not being. Every
    // table is paged on a TOTAL order (`id` last) until an empty page.
    const rows = await fetchAllPages<Record<string, unknown>>((from, to) => {
      let q = supabase.from(table).select(columns.join(", "));
      for (const col of order) q = q.order(col);
      // The column list is a runtime string, so the builder types its rows
      // as GenericStringError; the same boundary cast the unpaged read made.
      return q.range(from, to) as unknown as PromiseLike<PageResult<Record<string, unknown>>>;
    });
    zip.file(file, toCsv(rows, columns));
    manifestLines.push(`${file}: ${rows.length} rows`);
  }

  manifestLines.push(
    "",
    "Excluded: user_settings (device-local preference) and api_tokens (token",
    "hashes) — not user data to carry around.",
  );
  zip.file("manifest.txt", manifestLines.join("\n") + "\n");

  const zipped = await zip.generateAsync({ type: "arraybuffer" });
  return new Response(zipped, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="duit-export-${dateStr}.zip"`,
    },
  });
}
