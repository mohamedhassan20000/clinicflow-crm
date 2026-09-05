import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11C — the third-party booking continuation, over a real local Postgres.
 *
 * The mocked suite proves the *rules*. This one proves the two things only real
 * rows can answer:
 *
 *   1. `loadClinicDepartmentNames` really applies `is_active` and `deleted_at`,
 *      so the vocabulary the escalation classifier reads is the clinic's live
 *      configuration and not everything the table has ever held; and
 *   2. a booking made for somebody who is not the sender lands on the staged
 *      third-party file and never on the sender's patient record — asserted by
 *      reading the rows afterwards, not by trusting the return value.
 *
 * Every department here is generated per run. The one exception is the Arabic
 * phrase the patient actually typed, which is stored as a department *name* in
 * the fixture precisely so that the resolution being tested is "patient words →
 * live row" rather than "patient words → constant in a source file".
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.LOCAL_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "anon";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let adminViewer: SupabaseClient<Database>;

const suffix = `p11c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/**
 * A letters-only tag for *person* names. `register_patient` normalizes the
 * spelling it files (P10), so a name carrying digits comes back changed and the
 * test would be asserting the normalizer rather than the isolation.
 */
const rawTag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 5).padEnd(5, "x");
const nameTag = `${rawTag[0]!.toUpperCase()}${rawTag.slice(1)}`;
const clinicId = randomUUID();
const adminId = randomUUID();

/** The message, byte for byte, as `inbound_messages` stored it on 2026-08-24. */
const REPRODUCED = "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي";

/**
 * The department the patient named. Its *name* is the Arabic words, so nothing
 * in `lib/` can pass this by recognising an English constant.
 */
const NAMED = { id: randomUUID(), name: `علاج طبيعي ${suffix.slice(-6)}` };
/** Two departments in no lexicon, to show the path is not about this one. */
const ARBITRARY = { id: randomUUID(), name: `Qorvex Wing ${suffix.slice(-6)}` };
const NEIGHBOUR = { id: randomUUID(), name: `جناح زِلبار ${suffix.slice(-6)}` };
/** Created mid-suite. */
const FRESH = { id: randomUUID(), name: `Zelbar Annexe ${suffix.slice(-6)}` };
/** Deactivated and soft-deleted, to prove the vocabulary read is filtered. */
const RETIRED = { id: randomUUID(), name: `Retired Ward ${suffix.slice(-6)}` };
const ERASED = { id: randomUUID(), name: `Erased Ward ${suffix.slice(-6)}` };

type Staff = {
  id: string;
  name: string;
  dept: string;
  role: "doctor" | "receptionist";
  active: boolean;
  deleted: boolean;
  onLeaveNow: boolean;
};
const staff = (over: Partial<Staff> & { name: string; dept: string }): Staff => ({
  id: randomUUID(),
  role: "doctor",
  active: true,
  deleted: false,
  onLeaveNow: false,
  ...over,
});

const NAMED_DOCTOR = staff({ name: `Vaneth Korrily ${suffix.slice(-4)}`, dept: NAMED.id });
const NAMED_RECEPTION = staff({
  name: `Pella Quorwin ${suffix.slice(-4)}`,
  dept: NAMED.id,
  role: "receptionist",
});
const NAMED_ON_LEAVE = staff({
  name: `Cassim Duvrey ${suffix.slice(-4)}`,
  dept: NAMED.id,
  onLeaveNow: true,
});
const ARBITRARY_DOCTOR = staff({ name: `Ilvara Nooshan ${suffix.slice(-4)}`, dept: ARBITRARY.id });
const NEIGHBOUR_DOCTOR = staff({ name: `مهند الزُبيري ${suffix.slice(-4)}`, dept: NEIGHBOUR.id });
const FRESH_DOCTOR = staff({ name: `Berenn Oxwald ${suffix.slice(-4)}`, dept: FRESH.id });

const ALL_STAFF = [
  NAMED_DOCTOR,
  NAMED_RECEPTION,
  NAMED_ON_LEAVE,
  ARBITRARY_DOCTOR,
  NEIGHBOUR_DOCTOR,
];
const authUserIds = [adminId, ...ALL_STAFF.map((item) => item.id), FRESH_DOCTOR.id];

/** The sender: a registered, identity-verified patient of this clinic. */
const senderPatientId = randomUUID();
const SENDER = {
  name: `Rahim Voskarr ${nameTag}`,
  nationalId: `1${Date.now().toString().slice(-10)}`,
  dob: "1988-04-11",
  email: `sender-${suffix}@example.com`,
};
/** The third party: the sender's child. Nothing about them equals the sender. */
const CHILD = {
  name: `Tomis Voskarr ${nameTag}`,
  nationalId: `3${Date.now().toString().slice(-10)}`,
  dob: "12 May 2015",
  email: `child-${suffix}@example.com`,
  phone: "+20134567890",
  bloodType: "O+",
};

let conversationId = "";

function eligibleIn(departmentId: string): Staff[] {
  return [...ALL_STAFF, FRESH_DOCTOR].filter(
    (person) =>
      person.dept === departmentId &&
      person.role === "doctor" &&
      person.active &&
      !person.deleted &&
      !person.onLeaveNow,
  );
}

async function cleanup() {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("doctor_unavailability").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", authUserIds);
  await service
    .from("departments")
    .delete()
    .in("id", [NAMED.id, ARBITRARY.id, NEIGHBOUR.id, FRESH.id, RETIRED.id, ERASED.id]);
  await service.from("audit_logs").delete().eq("clinic_id", clinicId);
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
        password: "ThirdPartyBooking123!",
        email_confirm: true,
      }),
    ),
  );
  adminViewer = createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p11c-admin-${suffix}`,
    },
  });
  const signedIn = await adminViewer.auth.signInWithPassword({
    email: `${suffix}-0@example.com`,
    password: "ThirdPartyBooking123!",
  });
  if (signedIn.error) throw signedIn.error;

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Continuation Clinic ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: "+20 2 5555 3434",
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

  // PostgREST unifies the column set across a multi-row insert, so every row
  // states `is_active` and `deleted_at` rather than relying on the default.
  const departments = await service.from("departments").insert(
    [
      { id: NAMED.id, name: NAMED.name },
      { id: ARBITRARY.id, name: ARBITRARY.name },
      { id: NEIGHBOUR.id, name: NEIGHBOUR.name },
      { id: RETIRED.id, name: RETIRED.name, is_active: false },
      { id: ERASED.id, name: ERASED.name, deleted_at: new Date().toISOString() },
    ].map((row) => ({
      clinic_id: clinicId,
      is_active: true,
      deleted_at: null as string | null,
      ...row,
    })),
  );
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    {
      id: adminId,
      clinic_id: clinicId,
      department_id: null,
      full_name: `Clinic Admin ${suffix.slice(-4)}`,
      role: "admin" as const,
      is_active: true,
      is_deleted: false,
      deleted_at: null,
    },
    ...ALL_STAFF.map((person) => ({
      id: person.id,
      clinic_id: clinicId,
      department_id: person.dept,
      full_name: person.name,
      role: person.role,
      is_active: person.active,
      is_deleted: person.deleted,
      deleted_at: person.deleted ? new Date().toISOString() : null,
    })),
  ]);
  if (profiles.error) throw profiles.error;

  const leave = await service.from("doctor_unavailability").insert({
    clinic_id: clinicId,
    doctor_id: NAMED_ON_LEAVE.id,
    kind: "leave",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    is_active: true,
  });
  if (leave.error) throw leave.error;

  const schedules = await service.from("doctor_schedules").insert(
    [NAMED_DOCTOR, ARBITRARY_DOCTOR, NEIGHBOUR_DOCTOR].flatMap((doctor) =>
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        clinic_id: clinicId,
        doctor_id: doctor.id,
        day_of_week: day,
        start_time: "08:00:00",
        end_time: "18:00:00",
        is_enabled: true,
      })),
    ),
  );
  if (schedules.error) throw schedules.error;

  const sender = await service.from("patients").insert({
    id: senderPatientId,
    clinic_id: clinicId,
    full_name: SENDER.name,
    national_id: SENDER.nationalId,
    date_of_birth: SENDER.dob,
    email: SENDER.email,
    phone: `+2010${Date.now().toString().slice(-8)}`,
    created_by: adminId,
    file_number: `${suffix}-sender`,
  });
  if (sender.error) throw sender.error;

  const conversation = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: `+2011${Date.now().toString().slice(-8)}`,
      status: "open",
      patient_id: senderPatientId,
      // The sender has already proved who they are. Third-party booking is a
      // step *after* that, never a way around it.
      identity_verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (conversation.error) throw conversation.error;
  conversationId = conversation.data.id;
}, 120_000);

afterAll(async () => {
  await adminViewer?.auth.signOut();
  await cleanup();
}, 60_000);

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
const departmentNames = async () =>
  (await import("@/lib/ai/doctor-directory")).loadClinicDepartmentNames(clinicId);
const classify = async (text: string) => {
  const { detectPatientEscalation } = await import("@/lib/ai/patient-escalation");
  return detectPatientEscalation(text, { clinicDepartmentNames: await departmentNames() });
};
function names(result: Record<string, unknown>, key = "doctors"): string[] {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}

// ---------------------------------------------------------------------------
// §1 · the vocabulary is the clinic's live configuration
// ---------------------------------------------------------------------------

describe("P11C §1 · the department vocabulary comes from live rows", () => {
  it("returns the active, undeleted departments and nothing else", async () => {
    const live = await departmentNames();
    expect([...live].sort()).toEqual(
      [NAMED.name, ARBITRARY.name, NEIGHBOUR.name].sort(),
    );
    expect(live).not.toContain(RETIRED.name);
    expect(live).not.toContain(ERASED.name);
  });

  it("picks up a department created after the clinic is already running", async () => {
    const created = await service
      .from("departments")
      .insert({
        id: FRESH.id,
        clinic_id: clinicId,
        name: FRESH.name,
        is_active: true,
        deleted_at: null,
      });
    expect(created.error).toBeNull();
    const profile = await service.from("profiles").insert({
      id: FRESH_DOCTOR.id,
      clinic_id: clinicId,
      department_id: FRESH.id,
      full_name: FRESH_DOCTOR.name,
      role: "doctor" as const,
      is_active: true,
      is_deleted: false,
      deleted_at: null,
    });
    expect(profile.error).toBeNull();
    expect(await departmentNames()).toContain(FRESH.name);
  });
});

// ---------------------------------------------------------------------------
// §2 · the reproduced message, against this clinic's real configuration
// ---------------------------------------------------------------------------

describe("P11C §2 · the production message is a booking", () => {
  it("does not escalate", async () => {
    expect(await classify(REPRODUCED)).toEqual({
      escalate: false,
      reason: null,
      emergency: false,
    });
  });

  it("does not escalate for any arbitrary department either", async () => {
    for (const department of [ARBITRARY, NEIGHBOUR, FRESH]) {
      expect(
        (await classify(`عايز احجز لابني ${department.name}`)).escalate,
      ).toBe(false);
    }
  });

  it("still escalates a genuine emergency and a genuine judgment request", async () => {
    expect(await classify("عندي ألم في الصدر ولا أستطيع التنفس")).toMatchObject({
      reason: "emergency",
      emergency: true,
    });
    expect(await classify("هل أتوقف عن الدواء؟")).toMatchObject({ reason: "medical" });
    expect(await classify("أريد التحدث مع موظف")).toMatchObject({
      reason: "human_requested",
    });
  });
});

// ---------------------------------------------------------------------------
// §3 · department → roster, from the patient's own words
// ---------------------------------------------------------------------------

describe("P11C §3 · the roster is resolved from live rows", () => {
  it("resolves the department the patient named and offers only its eligible doctors", async () => {
    const result = await call("prepare_booking", { department: NAMED.name });
    expect(result.department).toMatchObject({ id: NAMED.id });
    expect(names(result).sort()).toEqual(eligibleIn(NAMED.id).map((p) => p.name).sort());
    // The receptionist and the doctor on leave are both in this department.
    expect(names(result)).not.toContain(NAMED_RECEPTION.name);
    expect(names(result)).not.toContain(NAMED_ON_LEAVE.name);
  });

  it("does the same for a department in no lexicon, in both scripts", async () => {
    for (const department of [ARBITRARY, NEIGHBOUR, FRESH]) {
      const result = await call("prepare_booking", { department: department.name });
      expect({ id: (result.department as { id?: string } | null)?.id }).toEqual({
        id: department.id,
      });
      expect(names(result).sort()).toEqual(
        eligibleIn(department.id).map((p) => p.name).sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §4 · the third-party booking, end to end, and what it does not touch
// ---------------------------------------------------------------------------

describe("P11C §4 · doctor → day → time → third-party intake → pending booking", () => {
  it("completes, and the appointment is never the sender's", async () => {
    // Doctor.
    const booking = await call("prepare_booking", {
      department: NAMED.name,
      doctor: NAMED_DOCTOR.name,
    });
    expect(booking.doctor).toMatchObject({ id: NAMED_DOCTOR.id });

    // Day.
    const days = await call("list_available_days", { doctor_id: NAMED_DOCTOR.id });
    const offeredDays = (days.availableDays ?? []) as Array<{ date: string }>;
    expect(offeredDays.length).toBeGreaterThan(0);
    // The first day at least 24h out — the booking RPC's minimum notice.
    const cutoff = new Date(Date.now() + 26 * 3_600_000).toISOString().slice(0, 10);
    const day = offeredDays.map((item) => item.date).find((date) => date >= cutoff);
    expect(day).toBeTruthy();

    // Time.
    const slots = await call("check_availability", {
      doctor_id: NAMED_DOCTOR.id,
      date: day!,
    });
    const times = (slots.availableSlots ?? []) as string[];
    expect(times.length).toBeGreaterThan(0);

    // Booking before staging: a recoverable "stage them first", never a write.
    const premature = await call("create_preliminary_booking", {
      doctor_id: NAMED_DOCTOR.id,
      date: day!,
      time: times[0]!,
      duration_minutes: 30,
      for_someone_else: true,
    });
    expect(premature).toMatchObject({ created: false, reason: "intake_required" });

    // Third-party intake. The identifying fields are complete, so the last
    // thing standing between them and a staged file is the optional blood-type
    // question — asked once, before anything is written.
    const details = {
      for_someone_else: true,
      full_name: CHILD.name,
      national_id: CHILD.nationalId,
      date_of_birth: CHILD.dob,
      email: CHILD.email,
      phone: CHILD.phone,
    };
    const bloodTypeGate = await call("register_patient", details);
    expect(bloodTypeGate).toMatchObject({
      registered: false,
      needs_clarification: true,
      reason: "blood_type_required",
    });

    // They answer it, and only now is the file staged.
    const registered = await call("register_patient", {
      ...details,
      blood_type: CHILD.bloodType,
    });
    // Staged, never registered: a third party's file is a proposal for staff.
    expect(registered).toMatchObject({
      registered: false,
      intake_staged: true,
      intake_status: "pending_review",
      awaiting_staff_review: true,
      can_request_appointment: true,
    });
    expect(registered.intake_id).toMatch(/^[0-9a-f-]{36}$/i);

    // Authenticated staff can read the exact row the Patients intake-review UI
    // queries; this is an RLS visibility assertion, not a service-role proxy.
    const intake = await adminViewer
      .from("ai_patient_intakes")
      .select(
        "full_name, national_id, date_of_birth, email, is_third_party, review_status, approved_patient_id, requested_by_patient_id",
      )
      .eq("clinic_id", clinicId)
      .eq("conversation_id", conversationId)
      .maybeSingle();
    expect(intake.error).toBeNull();
    expect(intake.data).toMatchObject({
      full_name: CHILD.name,
      national_id: CHILD.nationalId,
      email: CHILD.email,
      is_third_party: true,
      review_status: "pending_review",
      // Nothing is a patient yet. The file is a proposal, not a record.
      approved_patient_id: null,
    });
    expect(registered.intake_id).toBe(
      (await service
        .from("ai_patient_intakes")
        .select("id")
        .eq("clinic_id", clinicId)
        .eq("conversation_id", conversationId)
        .single()).data?.id,
    );
    // The sender appears in exactly one place — as the person who asked — and
    // in no field that describes the subject of the booking.
    expect(intake.data!.requested_by_patient_id).toBe(senderPatientId);
    expect(intake.data!.full_name).not.toBe(SENDER.name);
    expect(intake.data!.national_id).not.toBe(SENDER.nationalId);
    expect(intake.data!.email).not.toBe(SENDER.email);
    expect(intake.data!.date_of_birth).not.toBe(SENDER.dob);

    // Pending booking.
    const created = await call("create_preliminary_booking", {
      doctor_id: NAMED_DOCTOR.id,
      date: day!,
      time: times[0]!,
      duration_minutes: 30,
      for_someone_else: true,
    });
    expect(created).toMatchObject({
      created: true,
      provisional_intake: true,
      status: "pending",
      requires_staff_confirmation: true,
      created_entity: {
        entity: "ai_appointment_request",
        status: "pending",
      },
    });
    expect(created.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    const requestId = String(created.request_id);

    // The provisional path is the one that ran: the request carries the
    // conversation and the doctor, and there is no appointment on the sender's
    // patient record at all.
    const requests = await service
      .from("ai_appointment_requests")
      .select("id, doctor_id, status")
      .eq("clinic_id", clinicId)
      .eq("conversation_id", conversationId);
    expect(requests.error).toBeNull();
    expect(requests.data).toHaveLength(1);
    expect(requests.data![0]).toMatchObject({ doctor_id: NAMED_DOCTOR.id });
    expect(requests.data![0]!.id).toBe(requestId);

    // The dashboard-equivalent visibility query must include the provisional
    // entity; querying only `appointments` is the P11H regression.
    const dashboardVisible = await adminViewer
      .from("ai_appointment_requests")
      .select("id, status, expires_at")
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString());
    expect(dashboardVisible.error).toBeNull();
    expect(dashboardVisible.data).toEqual([
      expect.objectContaining({ id: requestId, status: "pending" }),
    ]);

    // The notification is inserted transactionally by the same authoritative
    // entity insert, once for every active admin/receptionist in the clinic.
    const notifications = await service
      .from("notifications")
      .select("recipient_id, type, link, data")
      .eq("clinic_id", clinicId)
      .eq("type", "ai_booking_request");
    expect(notifications.error).toBeNull();
    expect(notifications.data).toHaveLength(2);
    expect(notifications.data!.map((row) => row.recipient_id).sort()).toEqual(
      [adminId, NAMED_RECEPTION.id].sort(),
    );
    for (const notification of notifications.data!) {
      expect(notification.link).toBe(
        `/patients?review=1&intake=${registered.intake_id as string}#ai-intakes`,
      );
      expect(notification.data).toMatchObject({
        source: "ai_appointment_request",
        recordId: requestId,
      });
    }
    const adminNotification = await adminViewer
      .from("notifications")
      .select("recipient_id, type")
      .eq("type", "ai_booking_request")
      .maybeSingle();
    expect(adminNotification.error).toBeNull();
    expect(adminNotification.data).toEqual({
      recipient_id: adminId,
      type: "ai_booking_request",
    });

    const event = await service
      .from("audit_logs")
      .select("record_id, action, table_name")
      .eq("clinic_id", clinicId)
      .eq("action", "AI_APPOINTMENT_REQUEST_STAGED")
      .eq("record_id", requestId)
      .maybeSingle();
    expect(event.error).toBeNull();
    expect(event.data).toMatchObject({
      record_id: requestId,
      table_name: "ai_appointment_requests",
    });

    const senderAppointments = await service
      .from("appointments")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("patient_id", senderPatientId);
    expect(senderAppointments.error).toBeNull();
    expect(senderAppointments.data).toEqual([]);
  }, 60_000);

  it("leaves the sender's own patient row byte-for-byte unchanged", async () => {
    const row = await service
      .from("patients")
      .select("full_name, national_id, date_of_birth, email")
      .eq("id", senderPatientId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      full_name: SENDER.name,
      national_id: SENDER.nationalId,
      date_of_birth: SENDER.dob,
      email: SENDER.email,
    });
  });

  it("created no second patient record for the child", async () => {
    // A staged intake is a *proposal*. Nothing exists as a patient until staff
    // approve it, which is the whole point of the staging table.
    const patients = await service
      .from("patients")
      .select("id, full_name")
      .eq("clinic_id", clinicId);
    expect(patients.error).toBeNull();
    expect(patients.data!.map((item) => item.full_name)).toEqual([SENDER.name]);
  });
});
