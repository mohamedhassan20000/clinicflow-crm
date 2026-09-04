import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11B — the phantom-doctor reproduction, over a real local Postgres.
 *
 * The mocked suite (`tests/unit/ai/p11b-authoritative-doctor-roster.test.ts`)
 * proves the *rules*; this one proves the **query boundaries**, because the
 * only way to know that `role = 'doctor'`, `department_id`, `is_active`,
 * `is_deleted`, `deleted_at` and the leave window actually filter is to put
 * rows that violate each of them into a real table and ask the production path
 * what it returns.
 *
 * Structure of the fixture, and why each row is here:
 *
 *   * two eligible doctors in the department under test — the answer;
 *   * a **receptionist** of the same department — the exact non-doctor from the
 *     reported clinic, and the one a `role` filter regression would surface;
 *   * a deactivated doctor, a soft-deleted doctor, and a doctor on leave that
 *     is in force *now*;
 *   * a doctor of a second department, for leakage;
 *   * a second department with its own doctors, and a third created *after* the
 *     clinic is already running, to show a new department needs no code.
 *
 * Every name is generated per run. Nothing in this file is asserted against a
 * literal it also planted: the expected roster is computed from the fixture's
 * eligibility predicates, so adding a row changes both sides at once while
 * dropping a filter in `lib/` changes only one.
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

const suffix = `p11b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const clinicId = randomUUID();
const adminId = randomUUID();

/** Departments. None of these words exists in any lexicon or any source file. */
const UNDER_TEST = { id: randomUUID(), name: `Qorvex Wing ${suffix.slice(-6)}` };
const NEIGHBOUR = { id: randomUUID(), name: `جناح زِلبار ${suffix.slice(-6)}` };
/** Created mid-suite, to prove a new department needs zero code changes. */
const FRESH = { id: randomUUID(), name: `Newly Opened ${suffix.slice(-6)}` };

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

const ELIGIBLE_A = staff({ name: `Vaneth Korrily ${suffix.slice(-4)}`, dept: UNDER_TEST.id });
const ELIGIBLE_B = staff({ name: `مهند الزُبيري ${suffix.slice(-4)}`, dept: UNDER_TEST.id });
const RECEPTIONIST = staff({
  name: `Pella Quorwin ${suffix.slice(-4)}`,
  dept: UNDER_TEST.id,
  role: "receptionist",
});
const DEACTIVATED = staff({
  name: `Ordric Vellum ${suffix.slice(-4)}`,
  dept: UNDER_TEST.id,
  active: false,
});
const SOFT_DELETED = staff({
  name: `Threnna Balix ${suffix.slice(-4)}`,
  dept: UNDER_TEST.id,
  deleted: true,
});
const ON_LEAVE_NOW = staff({
  name: `Cassim Duvrey ${suffix.slice(-4)}`,
  dept: UNDER_TEST.id,
  onLeaveNow: true,
});
const NEIGHBOURING = staff({ name: `Ilvara Nooshan ${suffix.slice(-4)}`, dept: NEIGHBOUR.id });
const FRESH_DOCTOR = staff({ name: `Berenn Oxwald ${suffix.slice(-4)}`, dept: FRESH.id });

const ALL_STAFF = [
  ELIGIBLE_A,
  ELIGIBLE_B,
  RECEPTIONIST,
  DEACTIVATED,
  SOFT_DELETED,
  ON_LEAVE_NOW,
  NEIGHBOURING,
];
const authUserIds = [adminId, ...ALL_STAFF.map((item) => item.id), FRESH_DOCTOR.id];
let conversationId = "";

/**
 * The roster, restated as the *eligibility rule* rather than as a list.
 *
 * This is what keeps the suite from asserting its own fixture: the expectation
 * is derived from the same row properties the database filters on, so it moves
 * when the fixture moves and stands still when `lib/` regresses.
 */
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
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("doctor_unavailability").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", authUserIds);
  await service
    .from("departments")
    .delete()
    .in("id", [UNDER_TEST.id, NEIGHBOUR.id, FRESH.id]);
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
        password: "AuthoritativeRoster123!",
        email_confirm: true,
      }),
    ),
  );

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Roster Authority Clinic ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: "+20 2 5555 1212",
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

  // FRESH is created mid-suite, deliberately.
  const departments = await service.from("departments").insert(
    [UNDER_TEST, NEIGHBOUR].map((item) => ({
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
      full_name: `Clinic Admin ${suffix.slice(-4)}`,
      role: "admin" as const,
      is_active: true,
      // Stated explicitly: PostgREST unifies the column set across a multi-row
      // insert, so a row that omits a key its siblings set gets NULL rather
      // than the column default.
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
    doctor_id: ON_LEAVE_NOW.id,
    kind: "leave",
    starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    is_active: true,
  });
  if (leave.error) throw leave.error;

  const schedules = await service.from("doctor_schedules").insert(
    [ELIGIBLE_A, ELIGIBLE_B, NEIGHBOURING].flatMap((doctor) =>
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
}, 90_000);

afterAll(cleanup, 60_000);

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
async function resetCollected() {
  await service
    .from("conversations")
    .update({ ai_collected_data: {}, ai_booking_stage: null })
    .eq("id", conversationId);
}
const directory = async () =>
  (await import("@/lib/ai/doctor-directory")).loadDoctorDirectory(clinicId);

// ---------------------------------------------------------------------------

describe("P11B §1 · the query boundaries, against real rows", () => {
  it("returns exactly the eligible staff of the department", async () => {
    const { availableDoctorsInDepartment } = await import("@/lib/ai/doctor-directory");
    const roster = availableDoctorsInDepartment(await directory(), UNDER_TEST.id);
    expect(roster.map((item) => item.name).sort()).toEqual(
      eligibleIn(UNDER_TEST.id)
        .map((item) => item.name)
        .sort(),
    );
    // Not vacuous: the table really does hold rows that must be filtered out.
    expect(roster.length).toBeLessThan(
      ALL_STAFF.filter((item) => item.dept === UNDER_TEST.id).length,
    );
  });

  it.each([
    ["a receptionist of the same department", () => RECEPTIONIST],
    ["a deactivated doctor", () => DEACTIVATED],
    ["a soft-deleted doctor", () => SOFT_DELETED],
    ["a doctor on leave in force right now", () => ON_LEAVE_NOW],
    ["a doctor of another department", () => NEIGHBOURING],
  ])("never offers %s", async (_label, person) => {
    await resetCollected();
    const result = await call("prepare_booking", { department: UNDER_TEST.name });
    const body = JSON.stringify(result);
    expect(body).not.toContain(person().name);
    expect(body).not.toContain(person().id);
  });

  it("keeps the receptionist out even when asked for by name", async () => {
    await resetCollected();
    const result = await call("prepare_booking", {
      department: UNDER_TEST.name,
      doctor: RECEPTIONIST.name,
    });
    // Whatever it says about the name, it can never resolve one: a receptionist
    // is not in `profiles where role = 'doctor'` and so is not in the directory
    // at all. What comes back is the department's real roster.
    const offered = ((result.doctors ?? []) as Array<{ id: string }>).map((i) => i.id);
    for (const id of offered) {
      expect(eligibleIn(UNDER_TEST.id).map((item) => item.id)).toContain(id);
    }
    expect(JSON.stringify(result)).not.toContain(RECEPTIONIST.id);
  });

  it("the read-only roster tool agrees with the booking tool, exactly", async () => {
    await resetCollected();
    const viaPrepare = await call("prepare_booking", { department: UNDER_TEST.name });
    const viaList = await call("list_doctors", { department: UNDER_TEST.name });
    const idsOf = (r: Record<string, unknown>) =>
      ((r.doctors ?? []) as Array<{ id: string }>).map((i) => i.id).sort();
    expect(idsOf(viaList)).toEqual(idsOf(viaPrepare));
    expect(idsOf(viaList)).toEqual(eligibleIn(UNDER_TEST.id).map((i) => i.id).sort());
  });

  it("follows a doctor who is reassigned, in both directions", async () => {
    const { availableDoctorsInDepartment } = await import("@/lib/ai/doctor-directory");
    await service
      .from("profiles")
      .update({ department_id: NEIGHBOUR.id })
      .eq("id", ELIGIBLE_A.id);
    let loaded = await directory();
    expect(
      availableDoctorsInDepartment(loaded, UNDER_TEST.id).map((i) => i.id),
    ).not.toContain(ELIGIBLE_A.id);
    expect(availableDoctorsInDepartment(loaded, NEIGHBOUR.id).map((i) => i.id)).toContain(
      ELIGIBLE_A.id,
    );

    await service
      .from("profiles")
      .update({ department_id: UNDER_TEST.id })
      .eq("id", ELIGIBLE_A.id);
    loaded = await directory();
    expect(availableDoctorsInDepartment(loaded, UNDER_TEST.id).map((i) => i.id)).toContain(
      ELIGIBLE_A.id,
    );
  });

  it("drops a doctor deactivated while the clinic is running", async () => {
    const { availableDoctorsInDepartment } = await import("@/lib/ai/doctor-directory");
    await service.from("profiles").update({ is_active: false }).eq("id", ELIGIBLE_B.id);
    expect(
      availableDoctorsInDepartment(await directory(), UNDER_TEST.id).map((i) => i.id),
    ).not.toContain(ELIGIBLE_B.id);
    await service.from("profiles").update({ is_active: true }).eq("id", ELIGIBLE_B.id);
    expect(
      availableDoctorsInDepartment(await directory(), UNDER_TEST.id).map((i) => i.id),
    ).toContain(ELIGIBLE_B.id);
  });
});

describe("P11B §2 · a department created mid-flight needs no code change", () => {
  it("serves a roster for a department that did not exist at boot", async () => {
    const created = await service
      .from("departments")
      .insert({ id: FRESH.id, clinic_id: clinicId, name: FRESH.name });
    if (created.error) throw created.error;
    const profile = await service.from("profiles").insert({
      id: FRESH_DOCTOR.id,
      clinic_id: clinicId,
      department_id: FRESH.id,
      full_name: FRESH_DOCTOR.name,
      role: "doctor",
      is_active: true,
    });
    if (profile.error) throw profile.error;

    await resetCollected();
    const result = await call("prepare_booking", { department: FRESH.name });
    expect((result.department as { id: string }).id).toBe(FRESH.id);
    expect(((result.doctors ?? []) as Array<{ id: string }>).map((i) => i.id)).toEqual([
      FRESH_DOCTOR.id,
    ]);
  });
});

describe("P11B §3 · the presentation contract, over real data", () => {
  /**
   * The reproduction, replayed at the seam that actually sends the message.
   *
   * The two names are pushed *in* as model output. Nothing in `lib/` knows
   * them; what rejects them is that they are not in the roster this clinic's
   * own rows produce.
   */
  const PHANTOMS = ["Mehmet Yilmaz", "Ayşe Demir"];
  const INVENTED = "Zephyrine Quillbottom";

  async function enforce(text: string, roster: Array<{ id: string; name: string }>) {
    const { enforcePatientReplyGrounding } = await import(
      "@/lib/ai/patient-reply-grounding"
    );
    const { createGroundingLedger } = await import("@/lib/ai/patient-grounding");
    const ledger = createGroundingLedger();
    if (roster.length > 0) {
      ledger.record("list_doctors", { department: UNDER_TEST, doctors: roster });
    }
    return enforcePatientReplyGrounding({
      clinicId,
      conversationId,
      locale: "ar",
      text,
      ledger,
      latestPatientText: "عايز اعرف مين الدكاترة المتاحين الاول",
      regenerate: async () => text,
    });
  }

  async function realRoster() {
    const { availableDoctorsInDepartment } = await import("@/lib/ai/doctor-directory");
    return availableDoctorsInDepartment(await directory(), UNDER_TEST.id).map((item) => ({
      id: item.id,
      name: item.name,
    }));
  }

  it("replaces the exact message that was sent with the real roster", async () => {
    await service
      .from("conversations")
      .update({ ai_collected_data: { department_id: UNDER_TEST.id } })
      .eq("id", conversationId);

    const result = await enforce(
      "تمام! 👍\n\n**الدكاترة المتاحين:**\n\n1. **Dr. Mehmet Yilmaz**\n" +
        "2. **Dr. Ayşe Demir**\n\n**عايز يحجز مع مين منهم؟**",
      [],
    );
    expect(result.rosterBearing).toBe(true);
    expect(result.outcome).toBe("deterministic");
    for (const phantom of PHANTOMS) expect(result.text).not.toContain(phantom);
    for (const doctor of await realRoster()) expect(result.text).toContain(doctor.name);
  });

  it("rejects a wholly invented name even beside a correct one", async () => {
    const roster = await realRoster();
    const result = await enforce(
      `الدكاترة المتاحين:\n1. Dr. ${roster[0]!.name}\n2. Dr. ${INVENTED}`,
      roster,
    );
    expect(result.text).not.toContain(INVENTED);
    expect(result.outcome).toBe("deterministic");
  });

  it("rejects a real staff member the server did not offer this turn", async () => {
    const roster = await realRoster();
    const result = await enforce(
      `الدكاترة المتاحين:\n1. Dr. ${roster[0]!.name}\n2. Dr. ${NEIGHBOURING.name}`,
      roster,
    );
    expect(result.text).not.toContain(NEIGHBOURING.name);
  });

  it("leaves a truthful roster reply untouched", async () => {
    const roster = await realRoster();
    const good =
      "الدكاترة المتاحين:\n" +
      roster.map((item, index) => `${index + 1}. Dr. ${item.name}`).join("\n") +
      "\nتحب تحجز مع مين؟";
    const result = await enforce(good, roster);
    expect(result.outcome).toBe("grounded");
    expect(result.text).toBe(good);
  });
});

describe("P11B §4 · a handed-back conversation regains its booking tools", () => {
  it("releases a stale escalated latch and mounts the roster tool again", async () => {
    const { openBookingStageTurn } = await import("@/lib/ai/booking-stage-store");
    const { allowedToolsForStage } = await import("@/lib/ai/booking-stage");
    const { PATIENT_TOOL_NAMES } = await import("@/lib/ai/patient-tools");

    // The exact shape found on the reported conversation: the stage latched
    // `escalated` from a previous session, while `ai_escalated_at` is null
    // because staff returned the thread to the assistant.
    await service
      .from("conversations")
      .update({
        ai_escalated_at: null,
        ai_collected_data: { department_id: UNDER_TEST.id },
        ai_booking_stage: {
          stage: "escalated",
          escalated: true,
          submitted: false,
          turnCount: 27,
          intakeStaged: false,
          bookingForOther: false,
          offeredDoctorIds: [],
          offeredDays: [],
          offeredSlots: [],
          lastToolOutcome: null,
          illegalTransitions: 0,
          stageEnteredAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      })
      .eq("id", conversationId);

    // Before the fix this stayed `escalated`, whose workflow mount is empty.
    const before = allowedToolsForStage("escalated", [...PATIENT_TOOL_NAMES]);
    expect(before).not.toContain("list_doctors");
    expect(before).not.toContain("prepare_booking");

    const turn = await openBookingStageTurn(
      { clinicId, conversationId, locale: "ar" },
      "patient_booking",
      { latestPatientText: "مين الدكاترة المتاحين؟", conversationEscalated: false },
    );

    expect(turn.stage).not.toBe("escalated");
    const mounted = allowedToolsForStage(turn.stage!, [...PATIENT_TOOL_NAMES]);
    expect(mounted).toContain("list_doctors");

    const row = await service
      .from("conversations")
      .select("ai_booking_stage")
      .eq("id", conversationId)
      .single();
    expect(
      (row.data!.ai_booking_stage as { escalated: boolean }).escalated,
    ).toBe(false);
  });

  it("does not release the latch for a conversation that is genuinely escalated", async () => {
    const { openBookingStageTurn } = await import("@/lib/ai/booking-stage-store");
    await service
      .from("conversations")
      .update({
        ai_booking_stage: {
          stage: "escalated",
          escalated: true,
          submitted: false,
          turnCount: 3,
          intakeStaged: false,
          bookingForOther: false,
          offeredDoctorIds: [],
          offeredDays: [],
          offeredSlots: [],
          lastToolOutcome: null,
          illegalTransitions: 0,
          stageEnteredAt: new Date().toISOString(),
        },
      })
      .eq("id", conversationId);

    // No `conversationEscalated` argument: a caller that has not read the
    // conversation's own state must not be able to lift an escalation.
    const turn = await openBookingStageTurn(
      { clinicId, conversationId, locale: "ar" },
      "patient_booking",
      { latestPatientText: "مين الدكاترة المتاحين؟" },
    );
    expect(turn.stage).toBe("escalated");
  });
});
