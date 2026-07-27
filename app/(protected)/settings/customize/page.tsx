import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { listStaffPagePermissions } from "@/actions/page-permissions";
import { listStaffReportPermissions } from "@/actions/report-permissions";
import { PageVisibilityCustomizer } from "@/components/settings/page-visibility-customizer";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataCustomize") };
}

interface PageProps {
  searchParams: Promise<{ staff?: string }>;
}

export default async function CustomizeSettingsPage({ searchParams }: PageProps) {
  const t = await getTranslations("protected");
  await requireRole("admin");
  const params = await searchParams;
  const [{ data, error }, reportResult] = await Promise.all([
    listStaffPagePermissions(),
    listStaffReportPermissions(),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">{t("pageVisibility")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("chooseWhichRoleEligiblePagesAre")}</p>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <PageVisibilityCustomizer
          staff={data ?? []}
          reports={reportResult.data ?? []}
          initialSelectedId={params.staff}
        />
      )}
    </div>
  );
}
