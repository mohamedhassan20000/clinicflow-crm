import { Skeleton } from "@/components/ui/skeleton";

export default function AssistantLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-start gap-3">
        <Skeleton className="size-11 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-80 max-w-[70vw]" />
        </div>
      </div>
      <Skeleton className="min-h-[38rem] rounded-3xl" />
    </div>
  );
}
