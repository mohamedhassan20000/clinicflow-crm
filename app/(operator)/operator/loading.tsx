import { TableSkeleton } from "@/components/shared/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

export default function OperatorLoading() {
  const t = useTranslations("operator");

  return (
    <div className="space-y-6" role="status" aria-label={t("loadingOperatorContent")}>
      <div className="space-y-6" aria-hidden="true">
        <header className="space-y-2">
          <Skeleton className="h-9 w-52" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </header>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="space-y-2 border-b p-5">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
          <TableSkeleton columns={5} rows={6} />
        </section>
      </div>
    </div>
  );
}
