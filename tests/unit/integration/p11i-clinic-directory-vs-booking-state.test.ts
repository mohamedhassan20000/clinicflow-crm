import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.LOCAL_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "anon";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `p11i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const clinicId = randomUUID();
const adminId = randomUUID();
const conversationId = randomUUID();
const selectedDoctorId = randomUUID();
const activeDepartments = Array.from({ length: 100 }, (_, index) => ({
  id: randomUUID(),
  clinic_id: clinicId,
  name: `Directory Unit ${String(index + 1).padStart(3, "0")} ${suffix}`,
  is_active: true,
  deleted_at: null,
}));
const excludedDepartments = [
  {
    id: randomUUID(),
    clinic_id: clinicId,
    name: `Inactive Unit ${suffix}`,
    is_active: false,
    deleted_at: null,
  },
  {
    id: randomUUID(),
    clinic_id: clinicId,
    name: `Deleted Unit ${suffix}`,
    is_active: true,
    deleted_at: new Date().toISOString(),
  },
];

async function cleanup() {
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("audit_logs").delete().eq("clinic_id", clinicId);
  await service.from("departments").delete().eq("clinic_id", clinicId);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await service.auth.admin.deleteUser(adminId).catch(() => null);
}

beforeAll(async () => {
  await cleanup();
  const user = await service.auth.admin.createUser({
    id: adminId,
    email: `${suffix}@example.com`,
    password: "ClinicDirectory123!",
    email_confirm: true,
  });
  if (user.error) throw user.error;

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Clinic Directory ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: "+20 2 5555 1111",
  });
  if (clinic.error) throw clinic.error;

  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw plan.error;
  const subscription = await service.from("subscriptions").insert({
    clinic_id: clinicId,
    plan_id: plan.data.id,
    status: "trialing",
    trial_ends_at: "2035-01-01T00:00:00Z",
  });
  if (subscription.error) throw subscription.error;
  const terms = await service.from("ai_commercial_terms").insert({
    clinic_id: clinicId,
    change_reason: "pilot",
    updated_by: adminId,
    accepted_at: new Date().toISOString(),
  });
  if (terms.error) throw terms.error;

  const departments = await service
    .from("departments")
    .insert([...activeDepartments, ...excludedDepartments]);
  if (departments.error) throw departments.error;

  const conversation = await service.from("conversations").insert({
    id: conversationId,
    clinic_id: clinicId,
    channel: "whatsapp",
    participant_address: `+2010${Date.now().toString().slice(-8)}`,
    status: "open",
    ai_collected_data: {
      department_id: activeDepartments[0]!.id,
      department_name: activeDepartments[0]!.name,
      doctor_id: selectedDoctorId,
      doctor_name: `Selected Doctor ${suffix}`,
      appointment_date: "2030-08-31",
      appointment_time: "09:00",
    },
    ai_booking_stage: {
      stage: "intake_collecting",
      escalated: false,
      submitted: false,
      turnCount: 9,
      intakeStaged: false,
      bookingForOther: true,
      offeredDoctorIds: [selectedDoctorId],
      offeredDays: ["2030-08-31"],
      offeredSlots: ["2030-08-31T09:00"],
      lastToolOutcome: null,
      illegalTransitions: 0,
      stageEnteredAt: new Date().toISOString(),
      appointmentLookup: null,
    },
  });
  if (conversation.error) throw conversation.error;
}, 90_000);

afterAll(cleanup, 60_000);

async function callDirectoryTool() {
  const { buildPatientTools } = await import("@/lib/ai/patient-tools");
  const tools = buildPatientTools(
    { clinicId, conversationId, locale: "en" },
    "patient_booking",
  );
  return (await tools.list_clinic_departments!.execute!(
    {},
    {} as never,
  )) as Record<string, unknown>;
}

async function setActiveCount(count: number) {
  const allIds = activeDepartments.map((department) => department.id);
  const disable = await service
    .from("departments")
    .update({ is_active: false })
    .in("id", allIds);
  if (disable.error) throw disable.error;
  const enable = await service
    .from("departments")
    .update({ is_active: true })
    .in(
      "id",
      activeDepartments.slice(0, count).map((department) => department.id),
    );
  if (enable.error) throw enable.error;
}

describe("P11I · real local Postgres clinic-directory authority", () => {
  it.each([3, 20, 100])(
    "returns all %i active rows regardless of selectedDepartmentId",
    async (count) => {
      await setActiveCount(count);
      const before = await service
        .from("conversations")
        .select("ai_collected_data, ai_booking_stage")
        .eq("id", conversationId)
        .single();
      if (before.error) throw before.error;

      const result = await callDirectoryTool();
      const returned = result.departments as Array<{ id: string; name: string }>;
      expect(result).toMatchObject({
        scope: "clinic_directory",
        complete: true,
        department_count: count,
      });
      expect(returned.map((row) => row.id).sort()).toEqual(
        activeDepartments
          .slice(0, count)
          .map((row) => row.id)
          .sort(),
      );
      for (const excluded of excludedDepartments) {
        expect(returned.map((row) => row.id)).not.toContain(excluded.id);
      }

      const after = await service
        .from("conversations")
        .select("ai_collected_data, ai_booking_stage")
        .eq("id", conversationId)
        .single();
      if (after.error) throw after.error;
      expect(after.data).toEqual(before.data);
    },
    30_000,
  );

  it("routes an Arabic mid-booking directory question away from nextBookingStep", async () => {
    await setActiveCount(100);
    const { openBookingStageTurn } = await import("@/lib/ai/booking-stage-store");
    const before = await service
      .from("conversations")
      .select("ai_collected_data")
      .eq("id", conversationId)
      .single();
    if (before.error) throw before.error;

    const turn = await openBookingStageTurn(
      { clinicId, conversationId, locale: "ar" },
      "patient_booking",
      {
        latestPatientText: "مفيش اقسام تانية؟",
        conversationEscalated: false,
      },
    );
    expect(turn.authority).toMatchObject({
      operation: "list_clinic_departments",
      reason: "needs_clinic_directory",
      requirement: "read_authority",
    });

    const after = await service
      .from("conversations")
      .select("ai_collected_data")
      .eq("id", conversationId)
      .single();
    if (after.error) throw after.error;
    expect(after.data.ai_collected_data).toEqual(before.data.ai_collected_data);
  });
});
