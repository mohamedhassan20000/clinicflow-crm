import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

export default function StaffLoading() {
  const t = useTranslations("protected");
  return (
    <div className="space-y-5" role="status" aria-label={t("loadingContent")}>
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="border-b border-border/50 bg-muted/30 px-4 py-3 flex gap-8">
          {[120, 100, 60, 60].map((w, i) => (
            <Skeleton key={i} className="h-4" style={{ width: w }} />
          ))}
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="border-b border-border/50 px-4 py-3 flex items-center gap-8">
            <div className="space-y-1 flex-1">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-7 w-7 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
