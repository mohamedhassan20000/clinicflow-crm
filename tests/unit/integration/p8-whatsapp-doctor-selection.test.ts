import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * End-to-end doctor selection over a real local Postgres.
 *
 * The unit suite proves the resolver logic; this proves the *queries*. The
 * defect that produced a technical error on "في دكاترة غيره؟" was not logic at
 * all — `computeAvailability` reads `doctor_unavailability`, and the clinic-
 * scoped service client used by the WhatsApp path refused that table outright.
 * Nothing short of running the real client against a real schema catches that,
 * which is why this file exists next to the mocked one.
 */

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
  process.env.LOCAL_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "anon";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `p8-docsel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const dermId = randomUUID();
const cardioId = randomUUID();
const adminId = randomUUID();
const nabilId = randomUUID();
const saraId = randomUUID();
const khaledId = randomUUID();
const onLeaveId = randomUUID();
const inactiveId = randomUUID();
const cardioDoctorId = randomUUID();
const authUserIds = [
  adminId,
  nabilId,
  saraId,
  khaledId,
  onLeaveId,
  inactiveId,
  cardioDoctorId,
];
let conversationId = "";

const CLINIC_PHONE = "+20 2 9999 8888";

async function cleanup() {
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("doctor_unavailability").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", authUserIds);
  await service.from("departments").delete().in("id", [dermId, cardioId]);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await Promise.all(
    authUserIds.map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
}

beforeAll(async () => {
  await cleanup();
  await Promise.all(
    authUserIds.map((id, index) =>
      service.auth.admin.createUser({
        id,
        email: `${suffix}-${index}@example.com`,
        password: "DoctorSelection123!",
        email_confirm: true,
      }),
    ),
  );

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Doctor Selection Clinic ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: CLINIC_PHONE,
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

  const departments = await service.from("departments").insert([
    { id: dermId, clinic_id: clinicId, name: "الجلدية" },
    { id: cardioId, clinic_id: clinicId, name: "القلب" },
  ]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    {
      id: adminId,
      clinic_id: clinicId,
      department_id: null,
      full_name: "Clinic Admin",
      role: "admin",
      is_active: true,
    },
    {
      id: nabilId,
      clinic_id: clinicId,
      department_id: dermId,
      full_name: "أحمد نبيل",
      role: "doctor",
      is_active: true,
    },
    {
      id: saraId,
      clinic_id: clinicId,
      department_id: dermId,
      full_name: "سارة علي",
      role: "doctor",
      is_active: true,
    },
    {
      id: khaledId,
      clinic_id: clinicId,
      department_id: dermId,
      full_name: "محمد خالد",
      role: "doctor",
      is_active: true,
    },
    {
      id: onLeaveId,
      clinic_id: clinicId,
      department_id: dermId,
      full_name: "هالة فؤاد",
      role: "doctor",
      is_active: true,
    },
    {
      id: inactiveId,
      clinic_id: clinicId,
      department_id: dermId,
      full_name: "عمر زكي",
      role: "doctor",
      is_active: false,
    },
    {
      id: cardioDoctorId,
      clinic_id: clinicId,
      department_id: cardioId,
      full_name: "يوسف عادل",
      role: "doctor",
      is_active: true,
    },
  ]);
  if (profiles.error) throw profiles.error;

  // Real, currently-in-force leave. This is the only thing that may make the
  // assistant say a doctor is unavailable.
  const leave = await service.from("doctor_unavailability").insert({
    clinic_id: clinicId,
    doctor_id: onLeaveId,
    kind: "leave",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    is_active: true,
  });
  if (leave.error) throw leave.error;

  // A real schedule for Dr Nabil, so the days path has something true to return.
  const schedules = await service.from("doctor_schedules").insert(
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      clinic_id: clinicId,
      doctor_id: nabilId,
      day_of_week: day,
      start_time: "08:00:00",
      end_time: "18:00:00",
      is_enabled: true,
    })),
  );
  if (schedules.error) throw schedules.error;

  const conversation = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: `+2010${Date.now().toString().slice(-8)}`,
      status: "open",
    })
    .select("id")
    .single();
  if (conversation.error) throw conversation.error;
  conversationId = conversation.data.id;
}, 60_000);

afterAll(cleanup, 60_000);

async function tools() {
  const { buildPatientTools } = await import("@/lib/ai/patient-tools");
  return buildPatientTools(
    { clinicId, conversationId, locale: "ar" },
    "patient_booking",
  );
}

async function call(name: string, input: Record<string, unknown> = {}) {
  const mounted = await tools();
  return (await mounted[name]!.execute!(input as never, {} as never)) as Record<
    string,
    unknown
  >;
}

/**
 * Puts the shared conversation back to the state a brand-new thread is in.
 *
 * Every case in this file drives the same conversation, and a settled doctor
 * survives from one to the next. That is not incidental to the case below: once
 * a doctor is settled, a bare `doctor_id` carried by the model cannot switch
 * doctors on its own — only patient-authored text can — so a case that means to
 * ask about a *different* doctor has to start from no settled doctor at all.
 */
async function resetBookingState() {
  const reset = await service
    .from("conversations")
    .update({ ai_booking_stage: null, ai_collected_data: {} })
    .eq("id", conversationId);
  if (reset.error) throw reset.error;
}

function names(result: Record<string, unknown>, key = "doctors") {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}

describe("WhatsApp doctor selection over real data", () => {
  it("returns all three bookable dermatology doctors, not one", async () => {
    const result = await call("prepare_booking", { department: "جلدية" });
    expect(result).toMatchObject({ field: "doctor", doctor_count: 3 });
    expect(names(result).sort()).toEqual(["أحمد نبيل", "سارة علي", "محمد خالد"].sort());
  });

  it("excludes the on-leave, deactivated and cross-department doctors", async () => {
    const result = await call("prepare_booking", { department: "جلدية" });
    expect(names(result)).not.toContain("هالة فؤاد");
    expect(names(result)).not.toContain("عمر زكي");
    expect(names(result)).not.toContain("يوسف عادل");
  });

  it("answers 'في دكاترة غيره؟' with the roster instead of a technical error", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "أحمد نبيل" });
    const result = await call("prepare_booking", { doctor: "في دكاترة غيره؟" });
    expect(result.technical_error).toBeUndefined();
    expect(result).toMatchObject({ field: "doctor", doctor_count: 3 });
  });

  it("list_doctors keeps the department and drops the doctor already offered", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "أحمد نبيل" });
    const result = await call("list_doctors", { exclude_doctor_id: nabilId });
    expect(result).toMatchObject({
      department_already_selected: true,
      doctor_count: 2,
    });
    expect(names(result)).not.toContain("أحمد نبيل");
  });

  it("explains the on-leave doctor from the clinic's own leave record", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const result = await call("prepare_booking", { doctor: "هالة فؤاد" });
    expect(result).toMatchObject({ reason: "doctor_on_leave", doctor_count: 3 });
    expect(result.technical_error).toBeUndefined();
  });

  it("explains the deactivated doctor rather than calling them unknown", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const result = await call("prepare_booking", { doctor: "عمر زكي" });
    expect(result).toMatchObject({ reason: "doctor_inactive" });
  });

  it("explains a doctor who belongs to another department", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const result = await call("prepare_booking", { doctor: "يوسف عادل" });
    expect(result).toMatchObject({
      reason: "doctor_in_other_department",
      requested_doctor: { department: "القلب" },
    });
  });

  it("lists real available days for the chosen doctor without throwing", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "أحمد نبيل" });
    const result = await call("list_available_days", { duration_minutes: 30 });
    expect(result.technical_error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, doctorId: nabilId });
    expect(Array.isArray(result.availableDays)).toBe(true);
  });

  it("explains the on-leave doctor rather than returning an empty day list", async () => {
    // The preceding case settled أحمد نبيل on this conversation. The anti-switch
    // rule would rightly keep him, so the thread is reset rather than the rule
    // relaxed: this case is about a patient asking after هالة فؤاد from scratch.
    await resetBookingState();
    const result = await call("list_available_days", {
      doctor_id: onLeaveId,
      duration_minutes: 30,
    });
    // P9B: this used to answer `{ ok: true, availableDays: [] }` — true, but
    // indistinguishable from "fully booked", so the assistant had no reason to
    // give and no alternative to offer. `list_available_days` now runs the same
    // directory check `prepare_booking` does, so leave is named and the roster
    // travels with it. Still not an error, and still never a dead end.
    expect(result.technical_error).toBeUndefined();
    expect(result).toMatchObject({
      needs_selection: true,
      reason: "doctor_on_leave",
      requested_doctor: { id: onLeaveId },
    });
    expect(names(result)).not.toContain("هالة فؤاد");
    expect(names(result).length).toBeGreaterThan(0);
  });

  it("carries the clinic's stored phone in the technical fallback", async () => {
    const { buildPatientTechnicalFallback } = await import("@/lib/ai/patient-fallback");
    await expect(buildPatientTechnicalFallback(clinicId)).resolves.toMatchObject({
      technical_error: true,
      clinic_phone: CLINIC_PHONE,
    });
  });
});
