import { Skeleton } from "@/components/Skeleton";

export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-52" />
      <Skeleton className="h-28" />
      <Skeleton className="h-20" />
    </div>
  );
}
