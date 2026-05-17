import { Skeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <Skeleton className="h-4 w-28" />
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-8 w-24 rounded-full" />
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      </div>

      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-start justify-between gap-4 border-b border-border/50 pb-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-80" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
          <div className="grid gap-3 py-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((__, metricIndex) => (
              <Skeleton key={metricIndex} className="h-20 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-44 rounded-lg" />
        </div>
      ))}
    </div>
  );
}
