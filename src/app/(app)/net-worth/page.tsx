import { Fragment, type ReactNode } from "react";
import { createServerSupabase } from "@/db/server";
import { getNetWorth, type NetWorthData } from "@/db/networth";
import { loadPortfolioValuation } from "@/db/portfolio";
import { klToday } from "@/lib/kl-date";
import { ratePct } from "@/lib/debt";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { Tip } from "@/components/Tip";
import { NetWorthChart } from "@/components/NetWorthChart";
import {
  AddAssetButton,
  UpdateAssetValueButton,
  ArchiveAssetButton,
  UnarchiveAssetButton,
  AddLiabilityButton,
  LiabilityActionsButton,
  ArchiveLiabilityButton,
  UnarchiveLiabilityButton,
} from "@/components/ManualItemDialogs";
import {
  AddBusinessButton,
  BusinessEntryButton,
  BusinessEntriesSection,
  ArchiveBusinessButton,
  UnarchiveBusinessButton,
} from "@/components/BusinessDialogs";
import { ArchivedDisclosure } from "@/components/ArchivedDisclosure";
import { DebtPayoffCard } from "@/components/DebtPayoffCard";

/**
 * Desktop Net Worth page (Plan 5 Task 6, v5 §6 binding). Server component:
 * fetches getNetWorth once (+ the account list and expense categories the
 * dialogs' selects need, + a holdings count via the shared portfolio
 * valuation loader) and renders everything from that single snapshot;
 * dialogs are client components layered on top of the Task-5 actions.
 */

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  bank: "bank",
  ewallet: "ewallet",
  cash: "cash",
  brokerage: "brokerage",
  epf: "epf",
  other: "other",
};

function dayMonthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Previous calendar month's short name, for the hero delta chip's "vs Jul". */
function prevMonthShortLabel(todayIso: string): string {
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return new Date(Date.UTC(py, pm - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

/** Up to `max` names joined, "+N more" beyond that — the stat-tile sublines'
 *  minimal generalization of the mockup's "EPF · car" two-item example. */
function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(" · ");
  return `${names.slice(0, max).join(" · ")} +${names.length - max} more`;
}

function Pill({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return (
    <span
      className="ml-1.5 inline-block flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: "var(--chip)", color: warn ? "var(--warning)" : "var(--ink-2)" }}
    >
      {children}
    </span>
  );
}

function StatTile({
  swatch,
  label,
  value,
  valueColor,
  sub,
}: {
  swatch: string;
  label: string;
  value: ReactNode;
  valueColor?: string;
  sub: ReactNode;
}) {
  return (
    <div className="rounded-2xl p-3.5" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: swatch }} />
        {label}
      </div>
      <div
        className="mt-1 text-lg font-bold tracking-tight tabular-nums"
        style={{ color: valueColor ?? "var(--ink-1)" }}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
        {sub}
      </div>
    </div>
  );
}

function DeltaChip({ deltaSen, prevMonthLabel }: { deltaSen: number; prevMonthLabel: string }) {
  const isUp = deltaSen > 0;
  const isDown = deltaSen < 0;
  const color = isUp ? "var(--good-text)" : isDown ? "var(--critical)" : "var(--ink-2)";
  const bg = isUp
    ? "color-mix(in srgb, var(--good) 12%, transparent)"
    : isDown
      ? "color-mix(in srgb, var(--critical) 12%, transparent)"
      : "var(--chip)";
  const arrow = isUp ? "▲" : isDown ? "▼" : "→";
  return (
    <span className="rounded-full px-2.5 py-1 text-[13px] font-semibold" style={{ color, background: bg }}>
      {arrow} <Money sen={Math.abs(deltaSen)} /> vs {prevMonthLabel}
    </span>
  );
}

/** "3.20% · min RM 620/mo"-style sub-line — omitted parts that are zero/unset.
 *  Plan 8 (v7 §11): gains `planned <b>RM x/mo</b>` and is DATA, not a Tip —
 *  rates and payments are values, and the planned figure is what the Debt
 *  payoff card below projects at. */
function liabilitySubLine(l: {
  interest_rate_bp: number;
  minimum_payment_sen: number;
  planned_payment_sen: number;
}): ReactNode {
  const parts: ReactNode[] = [];
  if (l.interest_rate_bp > 0) parts.push(ratePct(l.interest_rate_bp));
  if (l.minimum_payment_sen > 0) parts.push(<>min <Money sen={l.minimum_payment_sen} />/mo</>);
  if (l.planned_payment_sen > 0) {
    parts.push(
      <>
        planned{" "}
        <b>
          <Money sen={l.planned_payment_sen} />
          /mo
        </b>
      </>,
    );
  }
  if (parts.length === 0) return null;
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 ? " · " : null}
      {p}
    </Fragment>
  ));
}

// ---------------------------------------------------------------------------
// Row renderers (ruling 14). One component per list, rendered for BOTH the
// live rows and the ones inside the `Archived (n)` disclosure — the archived
// treatment (muted ink, the pill, Unarchive instead of the edit affordance)
// is driven off the row's own flag, so the two states cannot drift apart.
// ---------------------------------------------------------------------------

const rowStyle = { borderBottom: "1px solid var(--grid)" } as const;

function AccountRow({ a }: { a: NetWorthData["accounts"][number] }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-2.5 text-sm" style={rowStyle}>
      <span className="flex flex-1 items-center font-medium" style={{ color: a.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        {a.name}
        {a.archived ? <Pill>archived</Pill> : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {ACCOUNT_TYPE_LABELS[a.type] ?? a.type}
      </span>
      <span className="tabular-nums font-semibold" style={{ color: a.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        <Money sen={a.balance_sen} currency={a.currency} />
      </span>
    </div>
  );
}

function AssetRow({ a, todayIso }: { a: NetWorthData["manual_assets"][number]; todayIso: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-2.5 text-sm" style={rowStyle}>
      <span className="flex flex-1 items-center font-medium" style={{ color: a.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        {a.name}
        <Pill>manual</Pill>
        {a.archived ? <Pill>archived</Pill> : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {a.noted_on ? `updated ${dayMonthLabel(a.noted_on)}` : "not yet valued"}
      </span>
      <span className="tabular-nums font-semibold" style={{ color: a.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        <Money sen={a.value_sen} />
      </span>
      {a.archived ? (
        <UnarchiveAssetButton assetId={a.id} />
      ) : (
        <>
          <UpdateAssetValueButton assetId={a.id} name={a.name} currentValueSen={a.value_sen} todayStr={todayIso} />
          <ArchiveAssetButton assetId={a.id} />
        </>
      )}
    </div>
  );
}

function LiabilityRow({
  l,
  accounts,
  categories,
  todayIso,
}: {
  l: NetWorthData["liabilities"][number];
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  todayIso: string;
}) {
  const subLine = liabilitySubLine(l);
  const dialogProps = {
    liabilityId: l.id,
    liabilityName: l.name,
    prefillAmountSen: l.minimum_payment_sen,
    prefillCategoryId: l.last_payment_category_id,
    latestNotedOn: l.noted_on,
    balanceSen: l.balance_sen,
    interestRateBp: l.interest_rate_bp,
    plannedPaymentSen: l.planned_payment_sen,
    accounts,
    categories,
    todayStr: todayIso,
  };
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-2.5 text-sm" style={rowStyle}>
      <span className="flex-1">
        <span className="flex items-center font-medium" style={{ color: l.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
          {l.name}
          {l.archived ? <Pill>archived</Pill> : null}
        </span>
        {subLine ? (
          <span className="block text-xs" style={{ color: "var(--ink-3)" }}>
            {subLine}
          </span>
        ) : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {l.noted_on ? `updated ${dayMonthLabel(l.noted_on)}` : "not yet set"}
      </span>
      <span className="tabular-nums font-semibold" style={{ color: l.archived ? "var(--ink-3)" : "var(--critical)" }}>
        <Money sen={l.balance_sen} />
      </span>
      {l.archived ? (
        <UnarchiveLiabilityButton liabilityId={l.id} />
      ) : (
        <>
          <LiabilityActionsButton {...dialogProps} />
          <LiabilityActionsButton {...dialogProps} initialMode="plan" />
          <ArchiveLiabilityButton liabilityId={l.id} />
        </>
      )}
    </div>
  );
}

function BusinessRow({
  b,
  accounts,
  todayIso,
}: {
  b: NetWorthData["businesses"][number];
  accounts: Array<{ id: string; name: string }>;
  todayIso: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-2.5 text-sm" style={rowStyle}>
      <span className="flex-1">
        <span className="flex items-center font-medium" style={{ color: b.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
          {b.name}
          {b.archived ? <Pill>archived</Pill> : null}
        </span>
        {b.note ? <Tip as="span" className="block">{b.note}</Tip> : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        invested <Money sen={b.invested_sen} /> · returned <Money sen={b.returned_sen} />
      </span>
      <span className="tabular-nums font-semibold" style={{ color: b.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        <Money sen={b.value_sen} />
      </span>
      {/* Data, not a Tip — which valuation basis applies stays visible tips-off. */}
      <span className="text-xs" style={{ color: "var(--ink-3)" }}>
        {b.valued_on ? `valued ${dayMonthLabel(b.valued_on)}` : "at cost"}
      </span>
      {b.archived ? (
        <UnarchiveBusinessButton businessId={b.id} />
      ) : (
        <>
          <BusinessEntryButton businessId={b.id} businessName={b.name} accounts={accounts} todayStr={todayIso} />
          <ArchiveBusinessButton businessId={b.id} />
        </>
      )}
      <BusinessEntriesSection
        businessId={b.id}
        businessName={b.name}
        entries={b.entries}
        accounts={accounts}
        todayStr={todayIso}
      />
    </div>
  );
}

export default async function NetWorthPage() {
  const todayIso = klToday(new Date());
  const supabase = await createServerSupabase();

  const [nw, categoriesRes, valuation] = await Promise.all([
    getNetWorth(supabase, todayIso),
    supabase.from("categories").select("id, name, kind, archived").order("created_at"),
    loadPortfolioValuation(supabase, todayIso),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;

  const categories = categoriesRes.data as Array<{
    id: string;
    name: string;
    kind: "expense" | "income";
    archived: boolean;
  }>;
  const expenseCategories = categories
    .filter((c) => c.kind === "expense" && !c.archived)
    .map((c) => ({ id: c.id, name: c.name }));
  // Ruling 7: business entries and liability payments record MYR sen, so
  // only MYR accounts are offered as the cash account.
  const activeAccounts = nw.accounts
    .filter((a) => !a.archived && a.currency === "MYR")
    .map((a) => ({ id: a.id, name: a.name }));
  const holdingsCount = valuation.holdings.filter((h) => !h.archived).length;

  const { parts, delta_vs_prev_month_sen, snapshots, price_staleness } = nw;
  const totalAssetsSen = parts.accounts_sen + parts.manual_assets_sen + parts.holdings_sen + parts.business_sen;

  // Ruling 9: parts.accounts_sen counts EVERY account, archived included, so
  // the tile's own sub-line has to count them all too — the two figures
  // describe the same set or one of them is lying.
  const accountCount = nw.accounts.length + nw.archived_accounts.length;
  const accountsSub = `${accountCount} account${accountCount === 1 ? "" : "s"}`;
  const accountsCardEmpty =
    accountCount === 0 && nw.manual_assets.length === 0 && nw.archived_manual_assets.length === 0;
  const investmentsSub = `${holdingsCount} holding${holdingsCount === 1 ? "" : "s"} · marked to market`;
  const businessReturnedTotal = nw.businesses.reduce((sum, b) => sum + b.returned_sen, 0);
  const businessSub =
    nw.businesses.length === 0 ? (
      "No businesses yet"
    ) : (
      <>
        {nw.businesses.length} · <Money sen={businessReturnedTotal} /> returned
      </>
    );
  const manualSub = nw.manual_assets.length === 0 ? "No manual assets yet" : joinNames(nw.manual_assets.map((a) => a.name));
  const liabilitiesSub =
    nw.liabilities.length === 0 ? "No liabilities" : `${nw.liabilities.length} · ${joinNames(nw.liabilities.map((l) => l.name))}`;

  const businessInvestedTotal = nw.businesses.reduce((sum, b) => sum + b.invested_sen, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="eye-clear flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Net Worth
        </h2>
        <div className="ml-auto flex gap-2">
          <AddAssetButton todayStr={todayIso} />
          <AddLiabilityButton todayStr={todayIso} />
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline gap-3.5">
          <span className="text-[34px] font-extrabold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
            <Money sen={parts.total_sen} />
          </span>
          {delta_vs_prev_month_sen !== null ? (
            <DeltaChip deltaSen={delta_vs_prev_month_sen} prevMonthLabel={prevMonthShortLabel(todayIso)} />
          ) : null}
        </div>
        {/* Data, not a Tip — stays visible tips-off; warn color when any price is stale (ruling 10). */}
        <p
          className="mt-0.5 text-[12.5px]"
          style={{ color: price_staleness.any_stale ? "var(--warning)" : "var(--ink-3)" }}
        >
          as of today, {dayMonthLabel(todayIso)}
          {price_staleness.oldest_as_of ? ` · prices as of ${dayMonthLabel(price_staleness.oldest_as_of)}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile swatch="var(--accent)" label="Accounts" value={<Money sen={parts.accounts_sen} />} sub={accountsSub} />
        <StatTile swatch="var(--series-3)" label="Investments" value={<Money sen={parts.holdings_sen} />} sub={investmentsSub} />
        <StatTile swatch="var(--baseline)" label="Business" value={<Money sen={parts.business_sen} />} sub={businessSub} />
        <StatTile
          swatch="var(--series-2)"
          label="Manual assets"
          value={<Money sen={parts.manual_assets_sen} />}
          sub={manualSub}
        />
        <StatTile
          swatch="var(--critical)"
          label="Liabilities"
          value={<Money sen={-parts.liabilities_sen} />}
          valueColor="var(--critical)"
          sub={liabilitiesSub}
        />
      </div>

      <NetWorthChart snapshots={snapshots} todayIso={todayIso} liveTotalSen={parts.total_sen} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Accounts & manual assets">
          <Tip className="-mt-1 mb-3">
            account balances are derived from your transactions · manual values keep a history — update them anytime
          </Tip>
          {nw.fx_missing.length > 0 ? (
            // Ruling 7 honest gap: a never-fetched account currency exists
            // only between account creation and the next cron — its balances
            // show natively below but stay OUT of every MYR total until the
            // rate lands. Data, not a Tip — never hidden by tips-off.
            <p className="mb-2 text-xs font-medium" style={{ color: "var(--warning)" }}>
              No {nw.fx_missing.join(", ")} rate fetched yet — those balances are excluded from the
              MYR totals until the next daily update.
            </p>
          ) : null}
          {accountsCardEmpty ? (
            <p className="py-4 text-sm" style={{ color: "var(--ink-3)" }}>
              No accounts or manual assets yet.
            </p>
          ) : (
            <>
              {nw.accounts.map((a) => (
                <AccountRow key={a.id} a={a} />
              ))}
              {/* Accounts archive from Settings › Accounts and have no
                  unarchive action anywhere in the product — the disclosure
                  exists so an archived balance stays READABLE (parts.accounts
                  counts it, ruling 9), not to add a write path here. */}
              <ArchivedDisclosure count={nw.archived_accounts.length}>
                {nw.archived_accounts.map((a) => (
                  <AccountRow key={a.id} a={a} />
                ))}
              </ArchivedDisclosure>
              {nw.manual_assets.map((a) => (
                <AssetRow key={a.id} a={a} todayIso={todayIso} />
              ))}
              <ArchivedDisclosure count={nw.archived_manual_assets.length}>
                {nw.archived_manual_assets.map((a) => (
                  <AssetRow key={a.id} a={a} todayIso={todayIso} />
                ))}
              </ArchivedDisclosure>
              <div
                className="mt-2 flex justify-between pt-2.5 text-sm font-semibold"
                style={{ borderTop: "1px solid var(--grid)", color: "var(--ink-2)" }}
              >
                <span>Total assets</span>
                <span>
                  <Money sen={totalAssetsSen} />
                </span>
              </div>
            </>
          )}
        </Card>

        <div className="flex flex-col gap-4">
        <Card title="Liabilities">
          <Tip className="-mt-1 mb-3">
            balances keep a history like manual assets · Record payment logs the expense and steps the balance down
            in one go
          </Tip>
          {nw.liabilities.length === 0 && nw.archived_liabilities.length === 0 ? (
            <div className="flex flex-col gap-1.5 py-4">
              <p className="text-sm" style={{ color: "var(--ink-3)" }}>
                No liabilities yet.
              </p>
              <Tip>Add a liability to track loans, cards or PTPTN against your net worth.</Tip>
            </div>
          ) : (
            <>
              {nw.liabilities.map((l) => (
                <LiabilityRow
                  key={l.id}
                  l={l}
                  accounts={activeAccounts}
                  categories={expenseCategories}
                  todayIso={todayIso}
                />
              ))}
              <ArchivedDisclosure count={nw.archived_liabilities.length}>
                {nw.archived_liabilities.map((l) => (
                  <LiabilityRow
                    key={l.id}
                    l={l}
                    accounts={activeAccounts}
                    categories={expenseCategories}
                    todayIso={todayIso}
                  />
                ))}
              </ArchivedDisclosure>
              <div
                className="mt-2 flex justify-between pt-2.5 text-sm font-semibold"
                style={{ borderTop: "1px solid var(--grid)", color: "var(--ink-2)" }}
              >
                <span>Total liabilities</span>
                <span style={{ color: "var(--critical)" }}>
                  <Money sen={-parts.liabilities_sen} />
                </span>
              </div>
            </>
          )}
        </Card>
        {/* Plan 8 ruling 10: the payoff view lives here, beneath the list —
            no Debts route, no sidebar item, no dashboard card. Omitted while
            there is nothing active to project. */}
        {nw.liabilities.length > 0 ? <DebtPayoffCard rows={nw.liabilities} todayIso={todayIso} /> : null}
        </div>
      </div>

      <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
            Business investments
          </h3>
          <div className="ml-auto">
            <AddBusinessButton />
          </div>
        </div>
        <Tip className="mb-3">
          contributions and returns move cash against the account you pick — never an expense or income, budgets
          don&apos;t see them · current value defaults to what you&apos;ve put in until you record a valuation
        </Tip>
        {nw.businesses.length === 0 && nw.archived_businesses.length === 0 ? (
          <div className="flex flex-col gap-1.5 py-4">
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              No business investments yet.
            </p>
            <Tip>Add a business to track contributions, returns and its current value separately from your budget.</Tip>
          </div>
        ) : (
          <>
            {nw.businesses.map((b) => (
              <BusinessRow key={b.id} b={b} accounts={activeAccounts} todayIso={todayIso} />
            ))}
            <ArchivedDisclosure count={nw.archived_businesses.length}>
              {nw.archived_businesses.map((b) => (
                <BusinessRow key={b.id} b={b} accounts={activeAccounts} todayIso={todayIso} />
              ))}
            </ArchivedDisclosure>
            <div
              className="mt-2 flex flex-wrap justify-between gap-2 pt-2.5 text-sm font-semibold"
              style={{ borderTop: "1px solid var(--grid)", color: "var(--ink-2)" }}
            >
              <span>
                {nw.businesses.length} business{nw.businesses.length === 1 ? "" : "es"} · invested{" "}
                <Money sen={businessInvestedTotal} /> · returned <Money sen={businessReturnedTotal} />
              </span>
              <span>
                <Money sen={parts.business_sen} />
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
