import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { getCachedDepartments, getCachedStaff } from "@/lib/cache/reference-data";
import { StaffByDepartment } from "@/components/settings/staff-by-department";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";
import { SettingsTrashSection, type TrashItem } from "@/components/settings/settings-trash-section";
import { restoreStaff, deleteStaff, emptyStaffTrash } from "@/actions/settings";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Staff" };

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default async function StaffSettingsPage() {
  const user = await requireRole(["admin", "manager"]);

  const [allStaff, cachedDepts, canCustomize, lastSeenMap] = await Promise.all([
    getCachedStaff(user.clinicId),
    getCachedDepartments(user.clinicId),
    user.role === "admin"
      ? isPrimaryClinicAdmin(user.id, user.clinicId)
      : Promise.resolve(false),
    user.role === "admin"
      ? createAdminClient()
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
          <h2 className="font-semibold">Staff members</h2>
          <p className="text-sm text-muted-foreground">
            {staff.length} member{staff.length !== 1 ? "s" : ""}{" "}
            across {departments?.length ?? 0} department
            {(departments?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <AddStaffDialog
          departments={
            (departments ?? []).map(({ id, name }) => ({ id, name }))
          }
          currentRole={user.role}
          canCustomize={canCustomize}
        />
      </div>

      <StaffByDepartment
        staff={
          staff as Parameters<typeof StaffByDepartment>[0]["staff"]
        }
        departments={departments ?? []}
        currentUserId={user.id}
        lastSeenMap={lastSeenMap ?? undefined}
      />

      <SettingsTrashSection
        items={trashItems}
        entityLabel="staff member"
        onRestore={restoreStaff}
        onPermanentDelete={deleteStaff}
        onEmptyTrash={emptyStaffTrash}
      />
    </div>
  );
}
