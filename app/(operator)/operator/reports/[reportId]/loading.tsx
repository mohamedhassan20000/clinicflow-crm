import { TableSkeleton } from "@/components/shared/data-table";
import { Skeleton } from "@/components/ui/skeleton";

export default function OperatorReportLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading operator report">
      <div className="space-y-3">
        <Skeleton className="h-11 w-36" />
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 rounded-2xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
      <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b p-5">
          <div className="space-y-2"><Skeleton className="h-5 w-36" /><Skeleton className="h-4 w-48" /></div>
          <Skeleton className="h-10 w-40" />
        </div>
        <TableSkeleton columns={5} rows={8} />
      </section>
      <span className="sr-only">Loading report filters and rows…</span>
    </div>
  );
}
