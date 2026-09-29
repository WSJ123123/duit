"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useMoney } from "@/components/Money";
import { KIND_LABEL } from "@/lib/funds-display";
import { ActionLink } from "@/components/DialogKit";
import { ArchivedDisclosure } from "@/components/ArchivedDisclosure";
import { unarchiveFund } from "@/app/(app)/goals/actions";
import type { FundRow } from "@/db/funds";

/**
 * Q9: the mobile Goals screen's `Archived (n)` disclosure. The desktop copy
 * lives inside FundsTable, whose rows are `<tr colSpan>` shells the phone
 * layout cannot reuse — so this is the same disclosure (ArchivedDisclosure),
 * the same `unarchiveFund` action and therefore the same revalidation set,
 * over stacked divs instead of table rows. Ruling 9a: an archived fund stays
 * visible WITH its balance, and Unarchive is the only action (funds have no
 * delete path).
 */
export function ArchivedFundLine({ fund }: { fund: FundRow }) {
  const { fmt } = useMoney();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveFund(fund.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2.5 border-b py-2 text-[13px] last:border-b-0"
      style={{ borderColor: "var(--grid)" }}
    >
      <span className="flex-1" style={{ color: "var(--ink-3)" }}>
        <span className="font-semibold">{fund.name}</span>
        <span
          className="ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
          style={{ background: "var(--chip)", color: "var(--ink-3)" }}
        >
          {KIND_LABEL[fund.kind]}
        </span>
        <span
          className="ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
          style={{ background: "var(--chip)", color: "var(--ink-3)" }}
        >
          archived
        </span>
        <span className="mt-0.5 block text-[11.5px]">{fmt(fund.balance_sen)} saved</span>
      </span>
      <ActionLink onClick={unarchive}>Unarchive</ActionLink>
      {error ? (
        <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function ArchivedFundsMobile({ funds }: { funds: FundRow[] }) {
  return (
    <ArchivedDisclosure count={funds.length}>
      <div className="flex flex-col">
        {funds.map((fund) => (
          <ArchivedFundLine key={fund.id} fund={fund} />
        ))}
      </div>
    </ArchivedDisclosure>
  );
}
