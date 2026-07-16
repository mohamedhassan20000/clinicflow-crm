import { TableSkeleton } from "@/components/shared/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

export default function SettingsLoading() {
  const t = useTranslations("protected");

  return (
    <div className="space-y-5" role="status" aria-label={t("loadingSettings")}>
      <div className="space-y-5" aria-hidden="true">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border/50">
          <TableSkeleton columns={4} rows={6} />
        </div>
      </div>
    </div>
  );
}
