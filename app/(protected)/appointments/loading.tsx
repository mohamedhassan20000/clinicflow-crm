import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

export default function AppointmentsLoading() {
  const t = useTranslations("protected");
  return (
    <div className="space-y-6" role="status" aria-label={t("loadingContent")}>
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* Week grid skeleton */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        {/* Header row */}
        <div className="grid grid-cols-7 border-b border-border/50">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="p-3 text-center border-e last:border-e-0 border-border/50">
              <Skeleton className="h-4 w-8 mx-auto mb-1" />
              <Skeleton className="h-6 w-6 mx-auto" />
            </div>
          ))}
        </div>
        {/* Cells */}
        <div className="grid grid-cols-7 min-h-[300px]">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="border-e last:border-e-0 border-border/50 p-2 space-y-1.5">
              {i % 3 !== 2 && (
                <>
                  <Skeleton className="h-14 w-full rounded-lg" />
                  {i % 2 === 0 && <Skeleton className="h-14 w-full rounded-lg" />}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
