import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BillsTable, BillsList, type BillFormOptions } from "@/components/BillsTable";
import { RecordNow, RecordedEntryLink } from "@/components/RecordNow";
import type { BillRow, RecordedBillRow } from "@/db/bills";

/**
 * Q11a's `recorded_tx_id` gets its renderer with Q11b/Q13: a recorded row
 * (desktop table, mobile card) links to the transaction it was recorded by —
 * the same `/transactions?month=…#id` target the Q11b notice uses — and an
 * unrecorded row keeps `Record now`. Markup-level, the house's Sidebar shape:
 * no DOM environment, so the sheet itself (behind `Portal`) never renders here.
 */
const TODAY = "2077-03-19";
const TX_ID = "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6";

const base: BillRow = {
  rule_id: "rule-water",
  name: "Water",
  type: "expense",
  amount_sen: 4_000,
  variable: false,
  account_id: "acct-bank",
  transfer_account_id: null,
  category_id: "cat-bills",
  date: "2077-03-10",
  account_name: "Maybank",
  transfer_account_name: null,
  category_name: "Bills",
  record_id: "1d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
};
const recorded: RecordedBillRow = { ...base, recorded_amount_sen: 4_000, recorded_tx_id: TX_ID };
const upcoming: BillRow = { ...base, rule_id: "rule-netflix", name: "Subscriptions", date: "2077-03-25" };

const form: BillFormOptions = {
  accounts: [{ id: "acct-bank", name: "Maybank", currency: "MYR", archived: false }],
  categories: [{ id: "cat-bills", name: "Bills", kind: "expense", archived: false }],
  funds: [],
  todayStr: TODAY,
};
const props = { upcoming: [upcoming], overdue: [], recorded: [recorded], todayIso: TODAY, form };
const HREF = `/transactions?month=2077-03#${TX_ID}`;

describe("recorded rows link to their transaction (Q11a renderer)", () => {
  it("desktop table: the recorded row links to its entry, the upcoming row keeps Record now", () => {
    const html = renderToStaticMarkup(createElement(BillsTable, props));
    expect(html).toContain(`href="${HREF}"`);
    expect(html.match(/>Record now</g)).toHaveLength(1);
  });

  it("mobile list: same pair", () => {
    const html = renderToStaticMarkup(createElement(BillsList, props));
    expect(html).toContain(`href="${HREF}"`);
    expect(html.match(/>Record now</g)).toHaveLength(1);
  });

  it("RecordedEntryLink renders the month-anchored href", () => {
    const html = renderToStaticMarkup(createElement(RecordedEntryLink, { txId: TX_ID, date: "2077-03-10" }));
    expect(html).toContain(`href="${HREF}"`);
  });

  it("RecordNow takes a transfer occurrence as it is (Q13)", () => {
    const transfer: BillRow = {
      ...base,
      rule_id: "rule-sweep",
      name: "Auto-invest",
      type: "transfer",
      transfer_account_id: "acct-broker",
      transfer_account_name: "Rakuten",
      category_id: null,
      category_name: null,
    };
    const html = renderToStaticMarkup(createElement(RecordNow, { row: transfer, form, recordedTxId: null }));
    expect(html).toContain(">Record now<");
  });

  it("RecordNow stays the cell's one component when the row is recorded — the link is its trigger", () => {
    const html = renderToStaticMarkup(createElement(RecordNow, { row: base, form, recordedTxId: TX_ID }));
    expect(html).toContain(`href="${HREF}"`);
    expect(html).not.toContain(">Record now<");
  });
});
