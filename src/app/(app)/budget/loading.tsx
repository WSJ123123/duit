import { Skeleton } from "@/components/Skeleton";

export default function BudgetLoading() {
  return (
    <>
      <div className="hidden md:block">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-8 w-44" />
            <Skeleton className="ml-auto h-9 w-36" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </div>

      {/* Mobile silhouette: m-title row, bt-hero block, category rows. */}
      <div className="flex flex-col gap-4 md:hidden">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
        <div className="flex flex-col items-center gap-2 py-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-1 h-2.5 w-full" />
          <div className="flex w-full justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </>
  );
}
