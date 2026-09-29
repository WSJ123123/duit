import { Skeleton } from "@/components/Skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-8 w-44" />
        <Skeleton className="ml-auto h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
