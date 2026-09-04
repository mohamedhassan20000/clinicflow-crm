import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P9B — the booking continues after the doctor is chosen.
 *
 * This is the real WhatsApp conversation, replayed against a real Postgres:
 * "which departments do you have?" → "جلدية" → the Dermatology roster →
 * "احمد نبيل" → days → times → a pending appointment.
 *
 * It exists because that conversation ended, in production, at step four. The
 * audit trail says exactly how: the model never called `prepare_booking` (the
 * stage trace for those turns records `tool_called: "none"`), so it held no real
 * ids, and on the doctor-selection turn it called `list_available_days` with an
 * invented `service_id`. The service lookup missed, the tool answered
 * `{ ok: false, reason: "service_not_found" }` with no roster and no guidance,
 * and the assistant's only remaining move was the technical-error apology with
 * the clinic's phone number. The conversation's `ai_collected_data` still held
 * nothing but a date, because none of the tools after `prepare_booking` ever
 * wrote the doctor down.
 *
 * So the two load-bearing claims here are:
 *
 *   1. a tool call carrying ids the clinic never issued is *recoverable* — the
 *      real roster comes back, never a failure the patient can hear; and
 *   2. once a real doctor is chosen, every following step finds them, all the
 *      way to a pending appointment, whichever tool the model reaches for.
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

/** The rollback switch, read exactly as `booking-stage-store` reads it. */
const TRACKING_ENABLED = !["off", "0", "false"].includes(
  (process.env.AI_PATIENT_STAGE_ORCHESTRATION ?? "").trim().toLowerCase(),
);

const suffix = `p9b-booking-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TIMEZONE = "Africa/Cairo";
const clinicId = randomUUID();
const dermId = randomUUID();
const cardioId = randomUUID();
const adminId = randomUUID();
const nabilId = randomUUID();
const saraId = randomUUID();
const cardioDoctorId = randomUUID();
const patientId = randomUUID();
const authUserIds = [adminId, nabilId, saraId, cardioDoctorId];
let conversationId = "";

async function cleanup() {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", clinicId);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("services").delete().eq("clinic_id", clinicId);
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
        password: "BookingContinuation123!",
        email_confirm: true,
      }),
    ),
  );

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Booking Continuation Clinic ${suffix}`,
    country: "EG",
    timezone: TIMEZONE,
    phone: "+20 2 1111 2222",
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
      id: cardioDoctorId,
      clinic_id: clinicId,
      department_id: cardioId,
      full_name: "يوسف عادل",
      role: "doctor",
      is_active: true,
    },
  ]);
  if (profiles.error) throw profiles.error;

  // Every weekday, wide open. The 24-hour minimum notice is what decides which
  // day the flow actually lands on, and it must decide it from real rows.
  const schedules = await service.from("doctor_schedules").insert(
    [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
      [nabilId, saraId].map((doctorId) => ({
        clinic_id: clinicId,
        doctor_id: doctorId,
        day_of_week: day,
        start_time: "08:00:00",
        end_time: "18:00:00",
        is_enabled: true,
      })),
    ),
  );
  if (schedules.error) throw schedules.error;

  const patient = await service.from("patients").insert({
    id: patientId,
    clinic_id: clinicId,
    full_name: "محمد حسن",
    email: `${suffix}-patient@example.com`,
    national_id: `${Date.now()}`.slice(-11),
    file_number: `${suffix}-P`,
    phone: `+2011${Date.now().toString().slice(-8)}`,
    date_of_birth: "2000-09-12",
    created_by: adminId,
  });
  if (patient.error) throw patient.error;
}, 60_000);

afterAll(cleanup, 60_000);

/**
 * A brand-new conversation for every case: this file is about what happens to a
 * booking that starts from nothing, so leaking collected state between cases
 * would quietly prove the wrong thing.
 */
beforeEach(async () => {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", clinicId);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  if (conversationId) {
    await service.from("conversations").delete().eq("id", conversationId);
  }
  const conversation = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: `+2010${Date.now().toString().slice(-8)}`,
      status: "open",
      patient_id: patientId,
      // Linked and already past the date-of-birth check: this file is about the
      // booking steps, and identity has its own suite.
      identity_verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (conversation.error) throw conversation.error;
  conversationId = conversation.data.id;
});

async function call(name: string, input: Record<string, unknown> = {}) {
  const { buildPatientTools } = await import("@/lib/ai/patient-tools");
  const mounted = buildPatientTools(
    { clinicId, conversationId, locale: "ar" },
    "patient_booking",
  );
  return (await mounted[name]!.execute!(input as never, {} as never)) as Record<
    string,
    unknown
  >;
}

async function conversationRow() {
  const row = await service
    .from("conversations")
    .select("ai_collected_data, ai_booking_stage")
    .eq("id", conversationId)
    .single();
  if (row.error) throw row.error;
  return {
    collected: (row.data.ai_collected_data ?? {}) as Record<string, unknown>,
    stage: (row.data.ai_booking_stage ?? {}) as Record<string, unknown>,
  };
}

function names(result: Record<string, unknown>, key = "doctors") {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}

/** The clinic-local day the flow settles on, taken from the tool's own answer. */
function firstDay(days: Array<{ date: string; slotCount: number }>): string {
  const day = days[0];
  if (!day) throw new Error("the fixture must produce at least one bookable day");
  return day.date;
}

describe("P9B · Dermatology → Dr Ahmed Nabil, end to end", () => {
  it("recovers instead of dead-ending when the model invents a service id", async () => {
    // The exact production call: no prepare_booking has ever run on this
    // conversation, and the model supplies a uuid nothing issued.
    const result = await call("list_available_days", {
      service_id: randomUUID(),
      duration_minutes: 30,
    });

    expect(result.technical_error).toBeUndefined();
    expect(result.ok).not.toBe(false);
    expect(result).toMatchObject({ needs_selection: true, field: "department" });
    expect(names(result, "departments")).toContain("الجلدية");
    expect(typeof result.guidance).toBe("string");
  });

  it("recovers instead of dead-ending when the model invents a doctor id", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const result = await call("list_available_days", { doctor_id: randomUUID() });

    expect(result.technical_error).toBeUndefined();
    expect(result).toMatchObject({
      needs_selection: true,
      field: "doctor",
      reason: "doctor_not_recognized",
    });
    // The truth the patient can act on: the real Dermatology roster.
    expect(names(result).sort()).toEqual(["أحمد نبيل", "سارة علي"].sort());
    // And nothing invented was written down.
    // `set_conversation_ai_state` clears by writing an empty value, which
    // `parseCollectedData` then discards on read. Either way: not the invention.
    expect((await conversationRow()).collected.doctor_id ?? "").toBe("");
  });

  it("persists the department and the doctor the moment they are chosen", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const chosen = await call("prepare_booking", { doctor: "احمد نبيل" });
    expect(chosen).toMatchObject({ resolved: true, doctor: { id: nabilId } });

    const { collected } = await conversationRow();
    expect(collected).toMatchObject({ department_id: dermId, doctor_id: nabilId });
  });

  it("walks the whole flow to a pending appointment", async () => {
    // 1. "اي العيادات الموجودة"
    const departments = await call("prepare_booking", {});
    expect(names(departments, "departments")).toContain("الجلدية");

    // 2. "جلدية" — the complete roster, not one arbitrary doctor.
    const roster = await call("prepare_booking", { department: "جلدية" });
    expect(roster).toMatchObject({ field: "doctor", doctor_count: 2 });
    expect(names(roster)).toContain("أحمد نبيل");

    // 3. "احمد نبيل" — the step the production conversation never got past.
    const doctor = await call("prepare_booking", { doctor: "احمد نبيل" });
    expect(doctor).toMatchObject({ resolved: true, doctor: { id: nabilId } });

    // 4. Days. No ids passed at all: the conversation's own state must carry it.
    const days = await call("list_available_days", { duration_minutes: 30 });
    expect(days.technical_error).toBeUndefined();
    expect(days).toMatchObject({ ok: true, doctorId: nabilId });
    const availableDays = days.availableDays as Array<{ date: string; slotCount: number }>;
    expect(availableDays.length).toBeGreaterThan(0);
    const day = firstDay(availableDays);

    // 5. Times for the chosen day.
    const slots = await call("check_availability", { date: day, duration_minutes: 30 });
    expect(slots.technical_error).toBeUndefined();
    expect(slots).toMatchObject({ ok: true, doctorId: nabilId, date: day });
    const times = slots.availableSlots as string[];
    expect(times.length).toBeGreaterThan(0);

    // 6. The pending appointment.
    const booked = await call("create_preliminary_booking", {
      date: day,
      time: times[0]!,
      duration_minutes: 30,
    });
    expect(booked.technical_error).toBeUndefined();
    expect(booked).toMatchObject({
      created: true,
      status: "pending",
      requires_staff_confirmation: true,
    });

    // 7. The row the clinic will confirm, with the doctor the patient chose.
    const appointments = await service
      .from("appointments")
      .select("id, doctor_id, patient_id, status, scheduled_at")
      .eq("clinic_id", clinicId);
    if (appointments.error) throw appointments.error;
    expect(appointments.data).toHaveLength(1);
    expect(appointments.data[0]).toMatchObject({
      doctor_id: nabilId,
      patient_id: patientId,
      status: "pending",
    });
    expect(
      formatInTimeZone(
        new Date(appointments.data[0]!.scheduled_at),
        TIMEZONE,
        "yyyy-MM-dd HH:mm",
      ),
    ).toBe(`${day} ${times[0]}`);

    // 8. The stage machine followed the same path rather than losing it.
    //
    // The collected pair is the load-bearing half and holds in every mode. The
    // stage record is what `AI_PATIENT_STAGE_ORCHESTRATION=off` deliberately
    // stops writing, so asserting it unconditionally would test the switch
    // rather than the booking.
    const { collected, stage } = await conversationRow();
    expect(collected).toMatchObject({ department_id: dermId, doctor_id: nabilId });
    if (TRACKING_ENABLED) {
      expect(stage).toMatchObject({ stage: "submitted", submitted: true });
      expect(stage.illegalTransitions).toBe(0);
    } else {
      expect(stage).toEqual({});
    }
  }, 60_000);

  it("still lists days when the model attaches an invented service id to a real doctor", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "احمد نبيل" });
    const days = await call("list_available_days", { service_id: randomUUID() });

    expect(days.technical_error).toBeUndefined();
    expect(days).toMatchObject({ ok: true, doctorId: nabilId, service_ignored: true });
  });

  it("keeps a doctor selection alive across the tools that follow it", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "احمد نبيل" });
    // `check_availability` reached for directly, with no ids, exactly as a model
    // that skipped `list_available_days` would call it.
    const slots = await call("check_availability", { date: "بكرا" });
    expect(slots.technical_error).toBeUndefined();
    expect(slots).toMatchObject({ ok: true, doctorId: nabilId });

    const { collected } = await conversationRow();
    expect(collected).toMatchObject({ doctor_id: nabilId, department_id: dermId });
  });
});

/**
 * P9C — the same conversation, one deployment later, still answering "there is a
 * technical problem".
 *
 * The audit trail for turns 6 to 8 shows model steps with *no* `agent_tool:` row
 * at all. That is not a tool failing; it is a tool call that never reached
 * `execute`, because `doctor_id` was declared `z.string().uuid()` and the model
 * — replying to a patient who had just said "احمد نبيل" — sent the name. Zod
 * refused it inside the SDK, so none of the recovery proven above could run.
 *
 * These cases are the same flow driven the way the model actually drives it:
 * with words.
 */
describe("P9C · the model names the doctor in words, not in uuids", () => {
  it('"احمد نبيل" passed as doctor_id resolves to the real doctor', async () => {
    await call("prepare_booking", { department: "جلدية" });

    const days = await call("list_available_days", {
      doctor_id: "احمد نبيل",
      duration_minutes: 30,
    });

    expect(days.technical_error).toBeUndefined();
    expect(days).toMatchObject({ ok: true, doctorId: nabilId });
    expect((await conversationRow()).collected).toMatchObject({ doctor_id: nabilId });
  });

  it('"طيب يوم 24؟" — a bare day answers the days that were just offered', async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "احمد نبيل" });
    const days = await call("list_available_days", { duration_minutes: 30 });
    const availableDays = days.availableDays as Array<{ date: string; slotCount: number }>;
    const day = firstDay(availableDays);
    const dayNumber = String(Number(day.slice(8, 10)));

    const slots = await call("check_availability", {
      date: dayNumber,
      duration_minutes: 30,
    });

    expect(slots.technical_error).toBeUndefined();
    expect(slots.needs_clarification).toBeUndefined();
    expect(slots).toMatchObject({ ok: true, date: day, doctorId: nabilId });
  }, 60_000);

  it("a name this clinic does not have is the roster, not an error", async () => {
    await call("prepare_booking", { department: "جلدية" });
    const days = await call("list_available_days", { doctor_id: "دكتور مينا سمير" });

    expect(days.technical_error).toBeUndefined();
    expect(days).toMatchObject({ needs_selection: true, field: "doctor" });
    expect(names(days).sort()).toEqual(["أحمد نبيل", "سارة علي"].sort());
  });

  it("a service named in words is dropped, never a dead end", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "احمد نبيل" });
    const days = await call("list_available_days", { service_id: "كشف جلدية" });

    expect(days.technical_error).toBeUndefined();
    expect(days).toMatchObject({ ok: true, doctorId: nabilId, service_ignored: true });
  });
});

/**
 * P9C — "ممكن احجز موعد لصاحبي", on the linked conversation it was actually said
 * on.
 *
 * The conversation this fixture builds is linked to محمد حسن. Everything below
 * is about the friend, على النجار, and the one outcome that must never occur is
 * an appointment on محمد's record.
 */
describe("P9C · booking for somebody else", () => {
  const friend = {
    full_name: "على النجار",
    date_of_birth: "3 February 2001",
    email: `friend-${suffix}@example.com`,
    phone: "+20123456789",
  };

  function friendDetails() {
    return { ...friend, national_id: `${Date.now()}`.slice(-11) };
  }

  it("refuses to book for a friend nobody has staged", async () => {
    await call("prepare_booking", {
      department: "جلدية",
      doctor: "احمد نبيل",
      for_someone_else: true,
    });
    const days = await call("list_available_days", { duration_minutes: 30 });
    const day = firstDay(days.availableDays as Array<{ date: string; slotCount: number }>);
    const slots = await call("check_availability", { date: day, duration_minutes: 30 });
    const times = slots.availableSlots as string[];

    const booked = await call("create_preliminary_booking", {
      date: day,
      time: times[0]!,
      duration_minutes: 30,
      for_someone_else: true,
    });

    expect(booked.technical_error).toBeUndefined();
    expect(booked).toMatchObject({ created: false, reason: "intake_required" });
    // The whole point: nothing landed on the sender's file.
    const appointments = await service
      .from("appointments")
      .select("id")
      .eq("clinic_id", clinicId);
    if (appointments.error) throw appointments.error;
    expect(appointments.data).toHaveLength(0);
  }, 60_000);

  it("stages the friend on a linked conversation and books against their file", async () => {
    // "ممكن احجز موعد لصاحبي" → department and doctor first, exactly as the
    // intake order has always required.
    await call("prepare_booking", { for_someone_else: true, department: "جلدية" });
    const chosen = await call("prepare_booking", { doctor: "احمد نبيل" });
    expect(chosen).toMatchObject({ resolved: true, doctor: { id: nabilId } });

    // The friend's own details. On a linked conversation this used to be
    // `already_linked` and nothing else.
    //
    // P10: "النجار" has no curated Latin reading, so the first attempt asks the
    // patient to confirm the spelling before it becomes a medical record, and
    // stages nothing.
    const details = friendDetails();
    const unconfirmed = await call("register_patient", {
      ...details,
      for_someone_else: true,
    });
    expect(unconfirmed).toMatchObject({
      registered: false,
      reason: "name_spelling_confirmation_required",
      proposed_name: "Ali Alngar",
      original_name: "على النجار",
    });
    const stagedYet = await service
      .from("ai_patient_intakes")
      .select("id")
      .eq("clinic_id", clinicId);
    if (stagedYet.error) throw stagedYet.error;
    expect(stagedYet.data).toHaveLength(0);

    // They confirm, and the file is staged under the spelling they saw.
    const registered = await call("register_patient", {
      ...details,
      for_someone_else: true,
      name_spelling_confirmed: true,
    });
    expect(registered.technical_error).toBeUndefined();
    expect(registered).toMatchObject({
      registered: false,
      intake_staged: true,
      awaiting_staff_review: true,
    });

    // Staged as the friend, for staff to approve, with the sender recorded as
    // the person who asked.
    const intakes = await service
      .from("ai_patient_intakes")
      .select(
        "id, full_name, full_name_original, review_status, is_third_party, requested_by_patient_id",
      )
      .eq("clinic_id", clinicId);
    if (intakes.error) throw intakes.error;
    expect(intakes.data).toHaveLength(1);
    expect(intakes.data[0]).toMatchObject({
      // Filed in the Latin-script convention the patient files use…
      full_name: "Ali Alngar",
      // …and never at the cost of what the patient actually typed.
      full_name_original: "على النجار",
      review_status: "pending_review",
      is_third_party: true,
      requested_by_patient_id: patientId,
    });

    // Then the ordinary rest of the flow: day → time → pending.
    const days = await call("list_available_days", { duration_minutes: 30 });
    expect(days).toMatchObject({ ok: true, doctorId: nabilId });
    const day = firstDay(days.availableDays as Array<{ date: string; slotCount: number }>);
    const slots = await call("check_availability", { date: day, duration_minutes: 30 });
    const times = slots.availableSlots as string[];

    const booked = await call("create_preliminary_booking", {
      date: day,
      time: times[0]!,
      duration_minutes: 30,
      for_someone_else: true,
    });
    expect(booked.technical_error).toBeUndefined();
    expect(booked).toMatchObject({
      created: true,
      provisional_intake: true,
      booked_for_other_person: true,
      // The name the booking is confirmed back under is the one on the staged
      // file, which is the one the patient confirmed.
      booked_for_name: "Ali Alngar",
      requires_staff_confirmation: true,
    });

    // The request belongs to the friend's staged file...
    const requests = await service
      .from("ai_appointment_requests")
      .select("id, intake_id, doctor_id, status")
      .eq("clinic_id", clinicId);
    if (requests.error) throw requests.error;
    expect(requests.data).toHaveLength(1);
    expect(requests.data[0]).toMatchObject({
      intake_id: intakes.data[0]!.id,
      doctor_id: nabilId,
      status: "pending",
    });

    // ...and no appointment was created on the sender's record. This is the
    // assertion the whole feature exists for.
    const appointments = await service
      .from("appointments")
      .select("id, patient_id")
      .eq("clinic_id", clinicId);
    if (appointments.error) throw appointments.error;
    expect(appointments.data).toHaveLength(0);
  }, 90_000);

  it("still refuses to open a second file for the sender themselves", async () => {
    await call("prepare_booking", { department: "جلدية", doctor: "احمد نبيل" });
    const registered = await call("register_patient", friendDetails());

    expect(registered).toMatchObject({ registered: false, reason: "already_linked" });
    const intakes = await service
      .from("ai_patient_intakes")
      .select("id")
      .eq("clinic_id", clinicId);
    if (intakes.error) throw intakes.error;
    expect(intakes.data).toHaveLength(0);
  }, 60_000);
});
