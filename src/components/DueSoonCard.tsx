import Link from "next/link";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { Money } from "@/components/Money";
import { formatDM } from "@/lib/bills-display";
import type { DueSoonRow, DueSoonRows } from "@/db/bills";
import type { Projection } from "@/lib/bills";

/**
 * Ruling 13's in-app reminder — mockup v6 §9's left fragment. No push
 * infrastructure, no badge in the shared layout (that is the revalidation
 * trap Session 9 caught); this card is the reminder surface.
 *
 * Ruling 23: the count, the total, every row and the low point are DATA and
 * stay on screen with tips off. Only the "what this is" line is a Tip.
 */

function Row({ row, income }: { row: DueSoonRow; income?: boolean }) {
  const blocked = row.blocked_reason !== null;
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 text-[13px] last:border-b-0" style={{ borderColor: "var(--grid)" }}>
      <span>
        <span style={{ color: blocked ? "var(--critical)" : "var(--ink-1)", fontWeight: 550 }}>{row.name}</span>
        <span className="mt-0.5 block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          {formatDM(row.date)} · {row.account_name}
          {row.variable ? " · variable" : ""}
        </span>
        {blocked ? (
          // Ruling 11a: the money is real (the daily job records it, so it is
          // in the total above), but the rule is misconfigured and this row
          // must never read as an ordinary bill. Same reason text and same
          // destination as the Bills page's Needs-attention row. Data, not a
          // Tip — it stays on screen with tips off.
          <span className="mt-0.5 block text-[11.5px]" style={{ color: "var(--critical)" }}>
            {row.blocked_reason} ·{" "}
            <Link href="/settings/recurring" style={{ color: "var(--accent)", fontWeight: 600 }}>
              Fix rule →
            </Link>
          </span>
        ) : null}
      </span>
      <span
        className="whitespace-nowrap font-semibold tabular-nums"
        style={{ color: income ? "var(--good-text)" : "var(--ink-1)" }}
      >
        {income ? (
          <>
            + <Money sen={row.amount_sen} />
          </>
        ) : (
          <Money sen={row.amount_sen} />
        )}
      </span>
    </div>
  );
}

export function DueSoonCard({
  dueSoon,
  projection,
  todayIso,
}: {
  dueSoon: DueSoonRows;
  projection: Projection;
  todayIso: string;
}) {
  const belowZero = projection.min_sen <= 0;
  return (
    <Card title="Due soon">
      <Tip className="-mt-1 mb-1">
        bills from your recurring rules · a row disappears the moment its transaction is recorded
      </Tip>
      <p className="mb-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
        next 7 days · {dueSoon.count} bill{dueSoon.count === 1 ? "" : "s"} · <Money sen={dueSoon.total_sen} />
      </p>

      {dueSoon.bills.length === 0 && dueSoon.next_income === null ? (
        <p className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
          Nothing due in the next 7 days.
        </p>
      ) : (
        <>
          {dueSoon.bills.map((row) => (
            <Row key={`${row.rule_id}:${row.date}`} row={row} />
          ))}
          {dueSoon.next_income ? <Row row={dueSoon.next_income} income /> : null}
        </>
      )}

      <div
        className="mt-2 flex items-center justify-between border-t pt-2 text-xs font-semibold"
        style={{ borderColor: "var(--grid)", color: "var(--ink-2)" }}
      >
        <span>
          Lowest balance {formatDM(projection.min_date)}
          {projection.min_date === todayIso ? " (today)" : ""}
        </span>
        <span className="tabular-nums" style={{ color: belowZero ? "var(--critical)" : "var(--good-text)" }}>
          <Money sen={projection.min_sen} />
        </span>
      </div>
      <Link href="/bills" className="mt-2 inline-block text-xs font-semibold" style={{ color: "var(--accent)" }}>
        View bills →
      </Link>
    </Card>
  );
}
