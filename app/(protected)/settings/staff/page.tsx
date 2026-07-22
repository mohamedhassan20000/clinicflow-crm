import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { getCachedDepartments, getCachedStaff } from "@/lib/cache/reference-data";
import { StaffByDepartment } from "@/components/settings/staff-by-department";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";
import { SettingsTrashSection, type TrashItem } from "@/components/settings/settings-trash-section";
import { restoreStaff, deleteStaff, emptyStaffTrash } from "@/actions/settings";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { THIRTY_DAYS_MS } from "@/lib/constants";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { AssistantLauncherScope } from "@/components/assistant/assistant-launcher-scope";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataStaff") };
}

export default async function StaffSettingsPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);

  const [
    allStaff,
    cachedDepts,
    canCustomize,
    lastSeenMap,
    staffAssistant,
    scheduleAssistant,
  ] = await Promise.all([
    getCachedStaff(user.clinicId),
    getCachedDepartments(user.clinicId),
    user.role === "admin"
      ? isPrimaryClinicAdmin(user.id, user.clinicId)
      : Promise.resolve(false),
    user.role === "admin"
      ? createClinicScopedAdminClient(user.clinicId)
          .auth.admin.listUsers({ perPage: 1000 })
          .then(({ data }) => {
            const map: Record<string, string | null> = {};
            for (const u of data?.users ?? []) {
              map[u.id] = u.last_sign_in_at ?? null;
            }
            return map;
          })
          .catch(() => null)
      : Promise.resolve(null),
    resolveAssistantLauncher({ user, context: { type: "staff" } }),
    resolveAssistantLauncher({
      user,
      context: { type: "doctor-schedule" },
    }),
  ]);

  const departments = cachedDepts.filter((d) => !d.deleted_at && d.is_active);
  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();
  const staff = allStaff.filter((s) => !s.deleted_at);
  const trashedStaff = allStaff.filter(
    (s) => s.deleted_at && s.deleted_at > cutoff,
  );

  const trashItems: TrashItem[] = trashedStaff.map((s) => ({
    id: s.id,
    label: s.full_name,
    subtitle: s.role,
    deletedAt: s.deleted_at!,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{t("staffMembers")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("membersAcrossDepartments", { members: staff.length, departments: departments?.length ?? 0 })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AssistantLauncherEntry resolution={staffAssistant} role={user.role} />
          <AddStaffDialog
            departments={
              (departments ?? []).map(({ id, name }) => ({ id, name }))
            }
            currentRole={user.role}
            canCustomize={canCustomize}
          />
        </div>
      </div>

      <AssistantLauncherScope
        context={scheduleAssistant?.context ?? null}
        role={user.role}
      >
        <StaffByDepartment
          staff={
            staff as Parameters<typeof StaffByDepartment>[0]["staff"]
          }
          departments={departments ?? []}
          currentUserId={user.id}
          lastSeenMap={lastSeenMap ?? undefined}
          isAdmin={user.role === "admin"}
        />
      </AssistantLauncherScope>

      <SettingsTrashSection
        items={trashItems}
        entityLabel={t("staffMember")}
        onRestore={restoreStaff}
        onPermanentDelete={deleteStaff}
        onEmptyTrash={emptyStaffTrash}
      />
    </div>
  );
}
