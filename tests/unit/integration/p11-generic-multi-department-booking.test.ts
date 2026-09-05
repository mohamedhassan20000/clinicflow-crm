import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11 — the generic booking engine, over a real local Postgres.
 *
 * Every department in this file is invented, and none of them appears anywhere
 * in the source tree, the prompt, the concept lexicon or any other test. That
 * is the entire point: a suite built around Dermatology and Physical Therapy
 * would pass against a hard-coded Dermatology branch, and the defect being
 * fixed is precisely that a department outside the recognised set could fail to
 * enter the flow. Departments here are created, renamed, populated, emptied,
 * added mid-suite and deactivated mid-suite, and the *same* production tool
 * path is asked to cope with all of it without a code change.
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

const suffix = `p11-generic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const adminId = randomUUID();

/**
 * Three arbitrary departments plus one created after the clinic is already
 * running, and one deactivated while it is running.
 */
const ALPHA = { id: randomUUID(), name: `Wing Alpha ${suffix.slice(-6)}` };
const BETA = { id: randomUUID(), name: `جناح بيتا ${suffix.slice(-6)}` };
const GAMMA = { id: randomUUID(), name: `Gamma Suite ${suffix.slice(-6)}` };
const DELTA = { id: randomUUID(), name: `Delta Annexe ${suffix.slice(-6)}` };

const A1 = { id: randomUUID(), name: "Rana Wasfy", dept: ALPHA.id };
const A2 = { id: randomUUID(), name: "Tarek Sobhy", dept: ALPHA.id };
const B1 = { id: randomUUID(), name: "بسمة راغب", dept: BETA.id };
const G1 = { id: randomUUID(), name: "Hoda Fahmy", dept: GAMMA.id };
const G2 = { id: randomUUID(), name: "Selim Adly", dept: GAMMA.id };
const G3 = { id: randomUUID(), name: "Yara Mounir", dept: GAMMA.id };
const D1 = { id: randomUUID(), name: "Ziad Nour", dept: DELTA.id };
const INACTIVE = { id: randomUUID(), name: "Nagwa Helmy", dept: GAMMA.id };
const ON_LEAVE = { id: randomUUID(), name: "Karim Fouad", dept: ALPHA.id };

const DOCTORS = [A1, A2, B1, G1, G2, G3, D1, INACTIVE, ON_LEAVE];
const authUserIds = [adminId, ...DOCTORS.map((item) => item.id)];
let conversationId = "";
/**
 * A second thread, linked to a real patient file and date-of-birth verified,
 * used only by §J. The booking end of the flow needs a patient to file the
 * request against; keeping it on its own conversation means the roster tests
 * above still exercise the ordinary stranger path.
 */
let bookingConversationId = "";
const patientId = randomUUID();

async function cleanup() {
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("doctor_unavailability").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("services").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", authUserIds);
  await service
    .from("departments")
    .delete()
    .in("id", [ALPHA.id, BETA.id, GAMMA.id, DELTA.id]);
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
        password: "GenericBooking123!",
        email_confirm: true,
      }),
    ),
  );

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Generic Booking Clinic ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: "+20 2 5555 4444",
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

  // DELTA is deliberately not created here: §E creates it mid-suite.
  const departments = await service.from("departments").insert(
    [ALPHA, BETA, GAMMA].map((item) => ({
      id: item.id,
      clinic_id: clinicId,
      name: item.name,
    })),
  );
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
    ...DOCTORS.filter((item) => item.dept !== DELTA.id).map((item) => ({
      id: item.id,
      clinic_id: clinicId,
      department_id: item.dept,
      full_name: item.name,
      role: "doctor" as const,
      is_active: item.id !== INACTIVE.id,
    })),
  ]);
  if (profiles.error) throw profiles.error;

  const leave = await service.from("doctor_unavailability").insert({
    clinic_id: clinicId,
    doctor_id: ON_LEAVE.id,
    kind: "leave",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    is_active: true,
  });
  if (leave.error) throw leave.error;

  // Every bookable doctor in every department gets a real, wide schedule, so
  // "book into an arbitrary department" has something true to return in all of
  // them rather than only in a favoured one.
  const bookable = [A1, A2, B1, G1, G2, G3];
  const schedules = await service.from("doctor_schedules").insert(
    bookable.flatMap((doctor) =>
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

  const patientPhone = `+2011${Date.now().toString().slice(-8)}`;
  const patient = await service.from("patients").insert({
    id: patientId,
    clinic_id: clinicId,
    full_name: "Sara Kamal Ibrahim",
    phone: patientPhone,
    email: `${suffix}-patient@example.com`,
    date_of_birth: "1990-04-11",
    national_id: `2990101${Date.now().toString().slice(-7)}`,
    created_by: adminId,
    file_number: `P11-${Date.now().toString().slice(-8)}`,
  });
  if (patient.error) throw patient.error;

  const linked = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: patientPhone,
      status: "open",
      patient_id: patientId,
      patient_link_status: "automatic",
      identity_verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (linked.error) throw linked.error;
  bookingConversationId = linked.data.id;
}, 90_000);

afterAll(cleanup, 60_000);

async function call(
  name: string,
  input: Record<string, unknown> = {},
  thread = conversationId,
) {
  const { buildPatientTools } = await import("@/lib/ai/patient-tools");
  const mounted = buildPatientTools(
    { clinicId, conversationId: thread, locale: "ar" },
    "patient_booking",
  );
  return (await mounted[name]!.execute!(input as never, {} as never)) as Record<
    string,
    unknown
  >;
}

function names(result: Record<string, unknown>, key = "doctors") {
  return ((result[key] ?? []) as Array<{ name: string }>).map((item) => item.name);
}
function ids(result: Record<string, unknown>, key = "doctors") {
  return ((result[key] ?? []) as Array<{ id: string }>).map((item) => item.id);
}
async function resetCollected(thread = conversationId) {
  await service
    .from("conversations")
    .update({ ai_collected_data: {}, ai_booking_stage: null })
    .eq("id", thread);
}

// ---------------------------------------------------------------------------

describe("P11 §A-D · one code path, every configured department", () => {
  it.each([
    ["Wing Alpha", () => ALPHA, () => [A1.name, A2.name]],
    ["جناح بيتا", () => BETA, () => [B1.name]],
    ["Gamma Suite", () => GAMMA, () => [G1.name, G2.name, G3.name]],
  ])("returns exactly the authoritative roster for %s", async (_label, dept, expected) => {
    await resetCollected();
    const result = await call("prepare_booking", { department: dept().name });
    expect(result.field).toBe("doctor");
    expect((result.department as { id: string }).id).toBe(dept().id);
    expect(names(result).sort()).toEqual(expected().sort());
  });

  it("§I displayable doctor ids and names ⊆ the authoritative roster", async () => {
    const { loadDoctorDirectory, availableDoctorsInDepartment } = await import(
      "@/lib/ai/doctor-directory"
    );
    const directory = await loadDoctorDirectory(clinicId);
    for (const department of directory.departments) {
      const authoritative = availableDoctorsInDepartment(directory, department.id);
      await resetCollected();
      const offered = await call("prepare_booking", { department: department.name });
      for (const id of ids(offered)) {
        expect(authoritative.map((item) => item.id)).toContain(id);
      }
      for (const name of names(offered)) {
        expect(authoritative.map((item) => item.name)).toContain(name);
      }
    }
  });

  it("§H never offers a deactivated doctor or one on current leave", async () => {
    await resetCollected();
    const gamma = await call("prepare_booking", { department: GAMMA.name });
    expect(names(gamma)).not.toContain(INACTIVE.name);
    await resetCollected();
    const alpha = await call("prepare_booking", { department: ALPHA.name });
    expect(names(alpha)).not.toContain(ON_LEAVE.name);
  });
});

describe("P11 §J-K · a complete booking, in each arbitrary department", () => {
  it.each([
    ["Wing Alpha", () => ALPHA, () => A1],
    ["جناح بيتا", () => BETA, () => B1],
    ["Gamma Suite", () => GAMMA, () => G1],
  ])(
    "department → doctor → day → time → pending request, for %s",
    async (_label, dept, doctor) => {
      const thread = bookingConversationId;
      await resetCollected(thread);
      await service.from("appointments").delete().eq("clinic_id", clinicId);

      const roster = await call("prepare_booking", { department: dept().name }, thread);
      expect(names(roster)).toContain(doctor().name);

      const chosen = await call(
        "prepare_booking",
        { department: dept().name, doctor: doctor().name },
        thread,
      );
      expect(chosen.resolved).toBe(true);
      expect((chosen.doctor as { id: string }).id).toBe(doctor().id);

      const days = await call("list_available_days", {}, thread);
      const dayList = (days.availableDays ?? []) as Array<{ date: string }>;
      expect(dayList.length, JSON.stringify(days)).toBeGreaterThan(0);
      // The last offered day, so the 24-hour notice rule is never the reason a
      // department "fails" — that rule is real and is tested elsewhere.
      const day = dayList[dayList.length - 1]!.date;

      const slots = await call("check_availability", { date: day }, thread);
      const times = (slots.availableSlots ?? []) as string[];
      expect(times.length, JSON.stringify(slots)).toBeGreaterThan(0);
      const time = times[0]!;

      // `duration_minutes` is supplied explicitly because these tests invoke
      // `execute` directly; in production the SDK applies the schema's default
      // before the tool ever runs.
      const booking = await call(
        "create_preliminary_booking",
        { date: day, time, duration_minutes: 30 },
        thread,
      );
      expect(booking.technical_error).toBeUndefined();
      expect(booking.created, JSON.stringify(booking)).toBe(true);

      // The pending request exists, against this department's doctor and no
      // other, and it is pending rather than confirmed.
      const rows = await service
        .from("appointments")
        .select("doctor_id, status, patient_id")
        .eq("clinic_id", clinicId);
      expect(rows.data).toHaveLength(1);
      expect(rows.data![0]!.doctor_id).toBe(doctor().id);
      expect(rows.data![0]!.patient_id).toBe(patientId);
      expect(String(rows.data![0]!.status)).toContain("pending");
    },
    60_000,
  );
});

describe("P11 §E-G · configuration changes take effect with no code change", () => {
  it("§E a department created now is bookable now", async () => {
    await resetCollected();
    const before = await call("prepare_booking", { department: DELTA.name });
    expect(before.department).toBeUndefined();

    const created = await service
      .from("departments")
      .insert({ id: DELTA.id, clinic_id: clinicId, name: DELTA.name });
    if (created.error) throw created.error;
    await service.auth.admin.createUser({
      id: D1.id,
      email: `${suffix}-delta@example.com`,
      password: "GenericBooking123!",
      email_confirm: true,
    });
    const doctor = await service.from("profiles").insert({
      id: D1.id,
      clinic_id: clinicId,
      department_id: DELTA.id,
      full_name: D1.name,
      role: "doctor",
      is_active: true,
    });
    if (doctor.error) throw doctor.error;

    await resetCollected();
    const after = await call("prepare_booking", { department: DELTA.name });
    expect((after.department as { id: string }).id).toBe(DELTA.id);
    expect(names(after)).toEqual([D1.name]);
  }, 60_000);

  it("§E a renamed department answers to its new name", async () => {
    const renamed = `${DELTA.name} Renamed`;
    const update = await service
      .from("departments")
      .update({ name: renamed })
      .eq("id", DELTA.id);
    if (update.error) throw update.error;
    await resetCollected();
    const result = await call("prepare_booking", { department: renamed });
    expect((result.department as { id: string }).id).toBe(DELTA.id);
    await service.from("departments").update({ name: DELTA.name }).eq("id", DELTA.id);
  });

  it("§G moving a doctor between departments moves them in the roster", async () => {
    const move = await service
      .from("profiles")
      .update({ department_id: GAMMA.id })
      .eq("id", A2.id);
    if (move.error) throw move.error;

    await resetCollected();
    expect(names(await call("prepare_booking", { department: ALPHA.name }))).toEqual([
      A1.name,
    ]);
    await resetCollected();
    expect(
      names(await call("prepare_booking", { department: GAMMA.name })).sort(),
    ).toEqual([A2.name, G1.name, G2.name, G3.name].sort());

    await service.from("profiles").update({ department_id: ALPHA.id }).eq("id", A2.id);
  });

  it("§H deactivating a doctor removes them immediately", async () => {
    await service.from("profiles").update({ is_active: false }).eq("id", G2.id);
    await resetCollected();
    expect(names(await call("prepare_booking", { department: GAMMA.name }))).not.toContain(
      G2.name,
    );
    await service.from("profiles").update({ is_active: true }).eq("id", G2.id);
  });

  it("§F deactivating a department removes it from every answer", async () => {
    await service.from("departments").update({ is_active: false }).eq("id", DELTA.id);
    await resetCollected();
    const result = await call("prepare_booking", {});
    expect(
      (result.departments as Array<{ id: string }>).map((item) => item.id),
    ).not.toContain(DELTA.id);
    const attempt = await call("prepare_booking", { department: DELTA.name });
    expect(attempt.department).toBeUndefined();
    await service.from("departments").update({ is_active: true }).eq("id", DELTA.id);
  });

  it("§F a department with no doctors is a domain outcome, not an error", async () => {
    await service.from("profiles").update({ is_active: false }).eq("id", B1.id);
    await resetCollected();
    const result = await call("prepare_booking", { department: BETA.name });
    expect(result.doctor_count).toBe(0);
    expect(result.technical_error).toBeUndefined();
    expect(String(result.guidance)).toContain("no bookable doctors");
    await service.from("profiles").update({ is_active: true }).eq("id", B1.id);
  });
});

describe("P11 §7-8 · booking state survives the questions people actually ask", () => {
  it("answers a service question without silently selecting its department for booking", async () => {
    await resetCollected();
    const priced = await service.from("services").insert({
      clinic_id: clinicId,
      department_id: GAMMA.id,
      name: "Initial Consultation",
      price: 450,
      is_active: true,
    });
    if (priced.error) throw priced.error;

    const asked = await call("list_department_services", { department: GAMMA.name });
    expect(asked.found).toBe(true);
    expect(
      (asked.services as Array<{ name: string }>).map((item) => item.name),
    ).toEqual(["Initial Consultation"]);

    // A named service lookup is read-only. A later booking must make its own
    // explicit department selection rather than inheriting an FAQ argument.
    const resumed = await call("prepare_booking", {});
    expect(resumed.department).toBeUndefined();
    expect((resumed.departments as Array<{ id: string }>).map((item) => item.id)).toContain(
      GAMMA.id,
    );
  });

  it("answers 'مين تاني؟' from the settled department instead of restarting", async () => {
    await resetCollected();
    await call("prepare_booking", { department: GAMMA.name, doctor: G1.name });
    const others = await call("list_doctors", { exclude_doctor_id: G1.id });
    expect(others.department_already_selected).toBe(true);
    expect(names(others)).not.toContain(G1.name);
    expect(names(others).length).toBeGreaterThan(0);
  });

  it("clears the day and time when the patient switches department", async () => {
    await resetCollected();
    await call("prepare_booking", { department: ALPHA.name, doctor: A1.name });
    await service
      .from("conversations")
      .update({
        ai_collected_data: {
          department_id: ALPHA.id,
          doctor_id: A1.id,
          appointment_date: "2035-01-01",
          appointment_time: 600,
        },
      })
      .eq("id", conversationId);

    await call("prepare_booking", { department: GAMMA.name });
    const row = await service
      .from("conversations")
      .select("ai_collected_data")
      .eq("id", conversationId)
      .single();
    const collected = (row.data?.ai_collected_data ?? {}) as Record<string, unknown>;
    expect(collected.department_id).toBe(GAMMA.id);
    expect(collected.doctor_id).toBe("");
    expect(collected.appointment_date).toBe("");
    expect(collected.appointment_time).toBe("");
  });
});

/**
 * P11D — a doctor reply continues the booking; it never restarts it.
 *
 * Exercises `continuePatientBookingFromRoster` against the same live Postgres
 * as everything above: real departments, a real roster read through
 * `loadDoctorDirectory`, and the real `set_conversation_ai_state` write path.
 *
 * The production defect was that the deterministic fallback resolved the
 * department from the *current message only* and persisted nothing, so the turn
 * after a roster was offered fell back to listing departments. These tests
 * assert the two halves of the fix: the offer is persisted, and the next reply
 * resolves against it.
 */
describe("P11D · deterministic continuation persists what it offers", () => {
  async function continueTurn(patientText: string, thread = conversationId) {
    const [{ continuePatientBookingFromRoster }, { loadDoctorDirectory }, auth] =
      await Promise.all([
        import("@/lib/ai/patient-roster-continuation"),
        import("@/lib/ai/doctor-directory"),
        import("@/lib/ai/patient-authorization"),
      ]);
    const identity = await auth.authorizePatientConversation({
      clinicId,
      conversationId: thread,
      locale: "ar",
    });
    return continuePatientBookingFromRoster({
      identity,
      directory: await loadDoctorDirectory(clinicId),
      locale: "ar",
      patientText,
    });
  }

  async function collectedOf(thread = conversationId) {
    const row = await service
      .from("conversations")
      .select("ai_collected_data, ai_booking_stage")
      .eq("id", thread)
      .single();
    return {
      collected: (row.data?.ai_collected_data ?? {}) as Record<string, unknown>,
      stage: (row.data?.ai_booking_stage ?? {}) as Record<string, unknown>,
    };
  }

  it("persists the department and the offered roster when it names one", async () => {
    await resetCollected();
    const offered = await continueTurn(`عايز احجز في ${GAMMA.name}`);
    expect(offered.committed).toBe("department");
    expect(offered.outcome).toBe("roster_offered");

    const { collected, stage } = await collectedOf();
    expect(collected.department_id).toBe(GAMMA.id);
    // The roster is now an offer of record, which is what the next turn reads.
    expect(stage.offeredDoctorIds).toEqual(
      expect.arrayContaining([G1.id, G2.id, G3.id]),
    );
  });

  it("resolves a bare first name against that roster and moves to days", async () => {
    await resetCollected();
    await continueTurn(`عايز احجز في ${GAMMA.name}`);

    const firstName = G1.name.split(" ")[0]!;
    const picked = await continueTurn(firstName);
    expect(picked.outcome).toBe("doctor_selected");
    expect(picked.committed).toBe("doctor");

    const { collected } = await collectedOf();
    expect(collected.department_id).toBe(GAMMA.id);
    expect(collected.doctor_id).toBe(G1.id);

    // The regression itself: the department list must not reappear.
    expect(picked.text).not.toContain(ALPHA.name);
    expect(picked.text).not.toContain("الأقسام المتاحة");
  });

  it("resolves an ordinal against the roster in the order it was offered", async () => {
    await resetCollected();
    const offered = await continueTurn(`عايز احجز في ${GAMMA.name}`);
    expect(offered.committed).toBe("department");

    const stageBefore = (await collectedOf()).stage;
    const firstOffered = (stageBefore.offeredDoctorIds as string[])[0]!;

    const picked = await continueTurn("الأول");
    expect(picked.outcome).toBe("doctor_selected");
    expect((await collectedOf()).collected.doctor_id).toBe(firstOffered);
  });

  it("re-offers the same roster when the reply matches nobody on it", async () => {
    await resetCollected();
    await continueTurn(`عايز احجز في ${GAMMA.name}`);
    const again = await continueTurn("مش عارف بصراحة");
    expect(again.outcome).toBe("roster_offered");
    const { collected } = await collectedOf();
    // Still in the same department. No backward transition.
    expect(collected.department_id).toBe(GAMMA.id);
  });

  it("returns to department selection only on an explicit change", async () => {
    await resetCollected();
    await continueTurn(`عايز احجز في ${GAMMA.name}`);
    const switched = await continueTurn(`لا، عايز ${ALPHA.name}`);
    expect(switched.outcome).toBe("department_changed");
    const { collected } = await collectedOf();
    expect(collected.department_id).toBe(ALPHA.id);
    expect(collected.doctor_id).toBe("");
  });

  it("never offers a doctor the directory no longer lists as available", async () => {
    await resetCollected();
    const offered = await continueTurn(`عايز احجز في ${GAMMA.name}`);
    expect(offered.text).not.toContain(INACTIVE.name);
    const { stage } = await collectedOf();
    expect(stage.offeredDoctorIds).not.toContain(INACTIVE.id);
  });
});
