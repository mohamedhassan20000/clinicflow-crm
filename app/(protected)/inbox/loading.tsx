import { Skeleton } from "@/components/ui/skeleton";

export default function InboxLoading() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid min-h-[36rem] overflow-hidden rounded-xl border lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-3 border-e p-4">
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <div className="space-y-5 p-5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="ms-auto h-16 w-2/3" />
          <Skeleton className="h-20 w-3/4" />
          <Skeleton className="ms-auto h-14 w-1/2" />
        </div>
      </div>
    </div>
  );
}
