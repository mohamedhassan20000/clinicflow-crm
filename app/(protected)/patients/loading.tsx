import { Skeleton } from "@/components/ui/skeleton";

export default function PatientsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      <div className="flex gap-3">
        <Skeleton className="h-9 flex-1 max-w-sm" />
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="border-b border-border/50 bg-muted/30 px-4 py-3 flex gap-4">
          {[120, 100, 80, 80].map((w, i) => (
            <Skeleton key={i} className="h-4" style={{ width: w }} />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border-b border-border/50 px-4 py-3 flex gap-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
