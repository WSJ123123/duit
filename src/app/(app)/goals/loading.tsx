import { Skeleton } from "@/components/Skeleton";

/** Silhouette for the Goals page: header, hero, apply banner, 4-tile strip,
 *  waterfall + this-month cards, funds table (desktop); hero + banner +
 *  step cards (mobile) — mirrors budget/loading.tsx's split convention. */
export default function GoalsLoading() {
  return (
    <>
      <div className="hidden md:block">
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="ml-auto h-9 w-28" />
          </div>
          <Skeleton className="h-16 w-64" />
          <Skeleton className="h-10 w-full" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            <Skeleton className="h-72" />
            <Skeleton className="h-56" />
          </div>
          <Skeleton className="h-64" />
        </div>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </>
  );
}
