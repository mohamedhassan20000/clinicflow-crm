import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { listStaffPagePermissions } from "@/actions/page-permissions";
import { PageVisibilityCustomizer } from "@/components/settings/page-visibility-customizer";

export const metadata: Metadata = { title: "Customize" };

interface PageProps {
  searchParams: Promise<{ staff?: string }>;
}

export default async function CustomizeSettingsPage({ searchParams }: PageProps) {
  await requireRole(["admin", "manager"]);
  const params = await searchParams;
  const { data, error } = await listStaffPagePermissions();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">Page visibility</h2>
        <p className="text-sm text-muted-foreground">
          Choose which role-eligible pages are visible for each staff member.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <PageVisibilityCustomizer
          staff={data ?? []}
          initialSelectedId={params.staff}
        />
      )}
    </div>
  );
}
