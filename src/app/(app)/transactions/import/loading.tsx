import { Skeleton } from "@/components/Skeleton";

export default function ImportLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="ml-auto h-5 w-28" />
      </div>
      <Skeleton className="h-5 w-72" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
