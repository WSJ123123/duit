import { Skeleton } from "@/components/Skeleton";

/** Silhouette for the Bills page: header, 4-tile strip, projection card,
 *  Upcoming + Watch (desktop); hero + card list (mobile) — the same split
 *  convention goals/loading.tsx and budget/loading.tsx use. */
export default function BillsLoading() {
  return (
    <>
      <div className="hidden md:block">
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="ml-auto h-9 w-36" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
          <Skeleton className="h-64" />
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.6fr_1fr]">
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="ml-auto h-6 w-24" />
        </div>
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </>
  );
}
