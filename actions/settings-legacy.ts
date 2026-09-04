"use server";

import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { revalidatePath, revalidateTag } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  requireMutationRole as requireRole,
  requireRole as requireReadRole,
} from "@/lib/rbac";
import { ensureDefaultPagePermissions } from "@/actions/page-permissions";
import {
  updateStaffSchema,
  type ClinicWorkingHoursValues,
  type DoctorScheduleValues,
  type StaffShiftTemplatesValues,
} from "@/lib/validations/settings";
import { canonicalClock, mergeIntervals } from "@/lib/scheduling/clock";
import { normalizePhone } from "@/lib/phone/registry";
import { cleanClinicLogo } from "@/lib/images/clean-clinic-logo";
import {
  cleanedClinicLogoStoragePath,
} from "@/lib/images/clinic-logo-cleanup";

export interface ActionResult {
  error?: string;
  success?: boolean;
  staffId?: string;
}

// ── Staff ────────────────────────────────────────────────────────────────────

async function getStaffTargetForClinic(
  staffId: string,
  clinicId: string,
) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, clinic_id, role, full_name, department_id, phone, is_active")
    .eq("id", staffId)
    .eq("clinic_id", clinicId)
    .single();

  return data;
}

function managerCanManageTarget(
  actorRole: string,
  targetRole: string,
) {
  return actorRole === "admin" || targetRole !== "admin";
}

/**
 * Replaces an assistant's supervising-doctor set (many-to-many). This drives the
 * assistant's DATA SCOPE only — never page/report visibility. For a non-assistant
 * role it clears any assignments (e.g. a role change away from assistant). Only
 * same-clinic active doctors are accepted. The database RPC validates and
 * replaces the complete set in one transaction, so a stale or forged doctor id
 * fails the update instead of silently leaving the assistant unassigned.
 */
async function syncAssistantAssignments(
  assistantId: string,
  role: string,
  doctorIds: string[],
): Promise<boolean> {
  const supabase = await createClient();

  const { error } = await supabase.rpc(
    "replace_assistant_doctor_assignments",
    {
      p_assistant_id: assistantId,
      p_doctor_ids:
        role === "assistant" ? Array.from(new Set(doctorIds)) : [],
    },
  );
  return !error;
}

/** The supervising-doctor ids currently assigned to an assistant (edit prefill). */
export async function getAssistantSupervisingDoctorIds(
  staffId: string,
): Promise<string[]> {
  const user = await requireRole(["admin", "manager"]);
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { data } = await adminClient
    .from("assistant_doctor_assignments")
    .select("doctor_id")
    .eq("clinic_id", user.clinicId)
    .eq("assistant_id", staffId);
  return (data ?? []).map((row) => row.doctor_id);
}


export async function updateStaff(
  staffId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = updateStaffSchema.safeParse({
    full_name: fd.get("full_name"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
    is_active: fd.get("is_active") === "true",
    supervising_doctor_ids: fd.getAll("supervising_doctor_ids").map(String),
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  // Prevent self-deactivation
  if (staffId === user.id && !parsed.data.is_active) {
    return { error: await actionError("settings.youCannotDeactivateYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }
  if (user.role !== "admin" && parsed.data.role !== target.role) {
    return { error: await actionError("settings.onlyAdminsCanChangeStaffRoles") };
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      role: parsed.data.role,
      department_id: parsed.data.department_id ?? null,
      phone: parsed.data.phone ? normalizePhone(parsed.data.phone) : null,
      is_active: parsed.data.is_active,
    }, { count: "exact" })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  if (!count) return { error: await actionError("settings.couldNotUpdateThisStaffMemberYouMayLackPermission") };

  const assignmentsSaved = await syncAssistantAssignments(
    staffId,
    parsed.data.role,
    parsed.data.supervising_doctor_ids ?? [],
  );
  if (!assignmentsSaved) {
    await supabase
      .from("profiles")
      .update({
        full_name: target.full_name,
        role: target.role,
        department_id: target.department_id,
        phone: target.phone,
        is_active: target.is_active,
      })
      .eq("id", target.id)
      .eq("clinic_id", target.clinic_id);
    return {
      error: await actionError(
        "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }

  if (user.role === "admin" || user.role === "manager") {
    await ensureDefaultPagePermissions(staffId, parsed.data.role, user.clinicId);
  }

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

/** Saves only the editable Profile tab fields for one clinic staff member. */

export async function toggleStaffActive(
  staffId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id && !isActive) {
    return { error: await actionError("settings.youCannotDeactivateYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ is_active: isActive })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function softDeleteStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id) {
    return { error: await actionError("settings.youCannotDeleteYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function restoreStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ deleted_at: null, is_active: true })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function deleteStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id) {
    return { error: await actionError("settings.youCannotDeleteYourOwnAccount") };
  }

  const supabase = await createClient();

  // Verify same clinic (RLS also enforces)
  const { data: target } = await supabase
    .from("profiles")
    .select("id, clinic_id, role")
    .eq("id", staffId)
    .single();

  if (!target || target.clinic_id !== user.clinicId) {
    return { error: await actionError("settings.staffMemberNotFound") };
  }
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  // Delete auth user → cascades to profile via FK on auth.users
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { error } = await adminClient.auth.admin.deleteUser(staffId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  // Best-effort profile cleanup if FK cascade didn't fire
  await supabase.from("profiles").delete().eq("id", staffId);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

const temporaryPasswordSchema = z.object({
  temporary_password: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[0-9]/),
});

export async function resetStaffPassword(
  staffId: string,
  temporaryPassword: string,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = temporaryPasswordSchema.safeParse({
    temporary_password: temporaryPassword,
  });
  if (!parsed.success) {
    return { error: await actionError("settings.invalidPassword") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { error } = await adminClient.auth.admin.updateUserById(staffId, {
    password: parsed.data.temporary_password,
  });

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  // Force must_change_password
  const supabase = await createClient();
  await supabase
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function emptyStaffTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const { data: targets, error: selectError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (selectError) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const staff = targets ?? [];
  if (staff.some((target) => target.id === user.id)) {
    return { error: await actionError("settings.youCannotPermanentlyDeleteYourOwnAccount") };
  }
  if (
    user.role !== "admin" &&
    staff.some((target) => target.role === "admin")
  ) {
    return { error: await actionError("settings.onlyAdminsCanEmptyTrashContainingAdminUsers") };
  }
  if (staff.length === 0) return { success: true };

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  for (const target of staff) {
    const { error } = await adminClient.auth.admin.deleteUser(target.id);
    if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  await supabase
    .from("profiles")
    .delete()
    .eq("clinic_id", user.clinicId)
    .in(
      "id",
      staff.map((target) => target.id),
    )
    .not("deleted_at", "is", null);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

// ── Departments ──────────────────────────────────────────────────────────────







export async function emptyDepartmentsTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

// ── Insurance ────────────────────────────────────────────────────────────────







export async function emptyInsuranceTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

// ── Clinic ───────────────────────────────────────────────────────────────────


/**
 * Toggle the clinic's daily appointment reminders (§7.2b). When enabled, the
 * daily morning cron sends WhatsApp + Email reminders for confirmed
 * appointments scheduled today and tomorrow; when disabled, the clinic is
 * excluded from the reminder run entirely.
 */

export type InvoiceFollowupSettingsInput = {
  enabled: boolean;
  firstDays: number;
  secondDays: number;
  emailSubject: string | null;
  emailBody: string | null;
};

/**
 * Configure the clinic's overdue-invoice reminders (§7.3b): on/off, the day
 * offsets for the first and second reminder, and the email subject/body. The
 * WhatsApp wording is the clinic's own `invoice_followup` template (managed in
 * the templates settings). Values out of range are rejected.
 */

export async function uploadClinicLogo(fd: FormData): Promise<ActionResult & { url?: string }> {
  const user = await requireRole(["admin", "manager"]);

  const file = fd.get("logo") as File | null;
  if (!file || file.size === 0) return { error: await actionError("settings.noFileProvided") };

  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  if (file.size > MAX_SIZE) return { error: await actionError("settings.fileMustBeUnder5Mb") };

  const allowedTypes = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return { error: await actionError("settings.onlyPngJpegOrSvgFilesAreAccepted") };
  }

  let cleanedLogo: Awaited<ReturnType<typeof cleanClinicLogo>>;
  try {
    cleanedLogo = await cleanClinicLogo(
      new Uint8Array(await file.arrayBuffer()),
    );
  } catch {
    return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  const path = cleanedClinicLogoStoragePath(user.clinicId);

  const supabase = await createClient();
  const { error: uploadError } = await supabase.storage
    .from("clinic-assets")
    .upload(path, cleanedLogo.bytes, {
      upsert: true,
      contentType: "image/png",
    });

  if (uploadError) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { data: urlData } = supabase.storage
    .from("clinic-assets")
    .getPublicUrl(path);

  const logoUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase
    .from("clinics")
    .update({ logo_url: logoUrl })
    .eq("id", user.clinicId);

  if (updateError) {
    return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidatePath("/settings/clinic");
  return { success: true, url: logoUrl };
}

// ── Services ─────────────────────────────────────────────────────────────────






export async function emptyServicesTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}


// ── Clinic working hours ──────────────────────────────────────────────────────

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export async function getClinicWorkingHours(): Promise<ClinicWorkingHoursValues> {
  const user = await requireReadRole([
    "admin",
    "manager",
    "receptionist",
    "doctor",
    "assistant",
  ]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("clinic_working_hours")
    .select("day_of_week, shift_start, shift_end")
    .eq("clinic_id", user.clinicId)
    .order("day_of_week")
    .order("shift_start");

  const rows = data ?? [];

  return ALL_DAYS.map((dow) => {
    const dayRows = rows.filter((r) => r.day_of_week === dow);
    return {
      day_of_week: dow,
      open: dayRows.length > 0,
      shifts: dayRows.map((r) => ({
        shift_start: (r.shift_start as string).slice(0, 5),
        shift_end: (r.shift_end as string).slice(0, 5),
      })),
    };
  });
}


// ── Doctor schedule ───────────────────────────────────────────────────────────

export async function getStaffSchedule(
  staffId: string,
): Promise<DoctorScheduleValues> {
  const user = await requireReadRole([
    "admin",
    "manager",
    "receptionist",
    "doctor",
    "assistant",
  ]);
  const supabase = await createClient();

  const { data: target } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (!target) {
    return ALL_DAYS.map((day_of_week) => ({
      day_of_week,
      works: false,
      start_time: null,
      end_time: null,
      intervals: [],
    }));
  }

  const { data } = await supabase
    .from("doctor_schedules")
    .select("day_of_week, start_time, end_time")
    .eq("doctor_id", staffId)
    .eq("clinic_id", user.clinicId)
    .order("day_of_week")
    .order("start_time");

  const rows = data ?? [];

  // A staff weekday may hold several disjoint intervals since P14; pre-P14
  // rows simply come back as a single-interval day.
  return ALL_DAYS.map((dow) => {
    const intervals = mergeIntervals(
      rows
        .filter((r) => r.day_of_week === dow)
        .map((r) => ({ start: r.start_time as string, end: r.end_time as string })),
    ).map((interval) => ({ start_time: interval.start, end_time: interval.end }));
    return {
      day_of_week: dow,
      works: intervals.length > 0,
      start_time: intervals[0]?.start_time ?? null,
      end_time: intervals.at(-1)?.end_time ?? null,
      intervals,
    };
  });
}

// ── Staff shift templates ─────────────────────────────────────────────────────

export async function getStaffShiftTemplates(): Promise<StaffShiftTemplatesValues> {
  const user = await requireReadRole([
    "admin",
    "manager",
    "receptionist",
    "doctor",
    "assistant",
  ]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("staff_shift_templates")
    .select("id, name, start_time, end_time, is_enabled, sort_order")
    .eq("clinic_id", user.clinicId)
    .order("sort_order")
    .order("created_at");

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    start_time: canonicalClock(row.start_time) ?? "09:00",
    end_time: canonicalClock(row.end_time) ?? "17:00",
    is_enabled: row.is_enabled,
    sort_order: row.sort_order,
  }));
}


// Compatibility exports for existing callers outside the Staff drawer.
export const getDoctorSchedule = getStaffSchedule;
