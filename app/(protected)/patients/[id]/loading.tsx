import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

export default function PatientDetailLoading() {
  const t = useTranslations("protected");
  return (
    <div className="space-y-6" role="status" aria-label={t("loadingPatientDetails")}>
      <div className="space-y-6" aria-hidden="true">
        <header className="flex flex-wrap items-center gap-4">
          <Skeleton className="size-16 rounded-full" />
          <div className="min-w-48 flex-1 space-y-2">
            <Skeleton className="h-7 w-52 max-w-full" /><Skeleton className="h-4 w-36" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-20" />
          </div>
        </header>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 rounded-xl border border-border/50 bg-card p-5">
            <Skeleton className="h-4 w-20" />
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-36 max-w-full" />
              </div>
            ))}
          </div>
          <div className="space-y-6 lg:col-span-2">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/50 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="space-y-2 bg-card p-4">
                  <Skeleton className="h-3 w-16" /><Skeleton className="h-5 w-24 max-w-full" />
                </div>
              ))}
            </div>
            {Array.from({ length: 3 }).map((_, section) => (
              <section key={section} className="space-y-3">
                <Skeleton className="h-4 w-28" />
                <div className="space-y-3 rounded-xl border border-border/50 bg-card p-4">
                  <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/5" />
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
