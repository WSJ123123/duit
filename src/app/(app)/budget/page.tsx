import { createServerSupabase } from "@/db/server";
import { getBudgetMonth } from "@/db/budget";
import { klToday } from "@/lib/kl-date";
import { shiftMonth, clampMonth } from "@/lib/budget-nav";
import { nextPlanBannerVisible } from "@/lib/budget";
import { BudgetTable } from "@/components/BudgetTable";
import { BudgetMobile } from "@/components/BudgetMobile";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
}

function monthShort(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

/** Every "YYYY-MM" from `min` to `max` inclusive, for the mobile month-switcher
 *  `<select>` — same clamp range as the ‹ › nav (Task 4). */
function monthOptionsRange(min: string, max: string): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  let cursor = min;
  while (cursor <= max) {
    options.push({ value: cursor, label: monthLabel(cursor) });
    cursor = shiftMonth(cursor, 1);
  }
  return options;
}

/** "Aug 29"-style label for the mobile banner's "opens <date>" — the day the
 *  banner starts showing (last 3 calendar days of `month`, ruling 9). */
function bannerOpenDateLabel(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const totalDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const openDay = totalDays - 2;
  return new Date(Date.UTC(y, m - 1, openDay)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; edit?: string }>;
}) {
  const { month: monthParam, edit: editParam } = await searchParams;
  const supabase = await createServerSupabase();

  const todayStr = klToday(new Date());
  const currentMonth = todayStr.slice(0, 7);
  const maxMonth = shiftMonth(currentMonth, 1);

  // Earliest transaction month clamps how far back the nav can go — queried
  // before the target month, since the clamp needs it to compute `month`.
  const earliestRes = await supabase
    .from("transactions")
    .select("date")
    .order("date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (earliestRes.error) throw earliestRes.error;
  const minMonth = earliestRes.data ? (earliestRes.data as { date: string }).date.slice(0, 7) : currentMonth;

  const requested = monthParam && MONTH_RE.test(monthParam) ? monthParam : currentMonth;
  const month = clampMonth(requested, minMonth, maxMonth);

  const data = await getBudgetMonth(supabase, month);

  const prevMonthStr = shiftMonth(month, -1);
  const nextMonthStr = shiftMonth(month, 1);
  const prevLink = month > minMonth ? `/budget?month=${prevMonthStr}` : null;
  const nextLink = month < maxMonth ? `/budget?month=${nextMonthStr}` : null;
  const isPast = month < currentMonth;

  // Mobile "Start plan" CTA routes into this same page with ?edit=1 to reuse
  // BudgetTable's edit mode (Task 5 contract: no separate mobile planner
  // logic). exitEditHref sends Cancel/Save back to the read-only mobile view.
  const mobileEdit = editParam === "1";
  const exitEditHref = `/budget?month=${month}`;

  return (
    <>
      {/* Keyed on month + mobileEdit: a full remount on nav resets any
          in-flight edit draft rather than carrying stale allocation state
          across months, and picks up a fresh `startInEdit` on mode change. */}
      <div className={mobileEdit ? "" : "hidden md:block"}>
        <BudgetTable
          key={`${month}-${mobileEdit}`}
          month={month}
          monthLabel={monthLabel(month)}
          monthName={monthName(month)}
          prevMonthName={monthName(prevMonthStr)}
          prevMonthAbbrev={monthShort(prevMonthStr)}
          prevLink={prevLink}
          nextLink={nextLink}
          isPast={isPast}
          data={data}
          startInEdit={mobileEdit}
          exitEditHref={mobileEdit ? exitEditHref : undefined}
        />
      </div>

      {!mobileEdit ? (
        <div className="md:hidden">
          <BudgetMobile
            month={month}
            monthName={monthName(month)}
            monthOptions={monthOptionsRange(minMonth, maxMonth)}
            data={data}
            isPast={isPast}
            todayStr={todayStr}
            bannerVisible={nextPlanBannerVisible(todayStr)}
            bannerHref={`/budget?month=${maxMonth}`}
            bannerNextMonthName={monthName(maxMonth)}
            bannerCurrentMonthName={monthName(currentMonth)}
            bannerOpenDateLabel={bannerOpenDateLabel(currentMonth)}
          />
        </div>
      ) : null}
    </>
  );
}
