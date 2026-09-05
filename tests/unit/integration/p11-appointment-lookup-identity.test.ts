import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

/**
 * P11 — appointment lookup by name and national id, over real Postgres.
 *
 * The properties under test are security properties, and none of them can be
 * proved against a mock: the folding, the rate limit, the single generic
 * `no_match`, and — most importantly — the *absence* of any read of
 * `conversations.patient_id`. That last one is proved the only way it can be:
 * by having sender A, who is themselves a linked patient with their own
 * appointment, look up patient B, and asserting that what comes back is B's
 * appointment and that A's thread is unchanged afterwards.
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

const suffix = `p11-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID();
const adminId = randomUUID();
const doctorId = randomUUID();
const departmentId = randomUUID();

const stamp = Date.now().toString().slice(-7);
/** The patient whose appointment is being looked up. */
const B = {
  id: randomUUID(),
  name: "سارة كمال إبراهيم",
  nationalId: `29901011${stamp}`,
  phone: `+2012${stamp}1`,
};
/** The sender: a different, *linked* patient with their own appointment. */
const A = {
  id: randomUUID(),
  name: "Omar Adel Fathy",
  nationalId: `28805052${stamp}`,
  phone: `+2012${stamp}2`,
};

let senderConversationId = "";
let strangerConversationId = "";
let futureIso = "";
let secondFutureIso = "";

async function cleanup() {
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("conversations").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("doctor_schedules").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().in("id", [adminId, doctorId]);
  await service.from("departments").delete().eq("id", departmentId);
  await service.from("audit_logs").delete().eq("clinic_id", clinicId);
  await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
  await Promise.all(
    [adminId, doctorId].map((id) => service.auth.admin.deleteUser(id).catch(() => null)),
  );
}

beforeAll(async () => {
  await cleanup();
  await Promise.all(
    [adminId, doctorId].map((id, index) =>
      service.auth.admin.createUser({
        id,
        email: `${suffix}-${index}@example.com`,
        password: "AppointmentLookup123!",
        email_confirm: true,
      }),
    ),
  );

  const clinic = await service.from("clinics").insert({
    id: clinicId,
    name: `Lookup Clinic ${suffix}`,
    country: "EG",
    timezone: "Africa/Cairo",
    phone: "+20 2 7777 6666",
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

  const department = await service
    .from("departments")
    .insert({ id: departmentId, clinic_id: clinicId, name: `Lookup Wing ${stamp}` });
  if (department.error) throw department.error;

  const profiles = await service.from("profiles").insert([
    {
      id: adminId,
      clinic_id: clinicId,
      full_name: "Clinic Admin",
      role: "admin",
      is_active: true,
    },
    {
      id: doctorId,
      clinic_id: clinicId,
      department_id: departmentId,
      full_name: "Rana Wasfy",
      role: "doctor",
      is_active: true,
    },
  ]);
  if (profiles.error) throw profiles.error;

  const patients = await service.from("patients").insert(
    [B, A].map((person, index) => ({
      id: person.id,
      clinic_id: clinicId,
      full_name: person.name,
      phone: person.phone,
      email: `${suffix}-${index}@patients.example.com`,
      national_id: person.nationalId,
      date_of_birth: "1990-04-11",
      created_by: adminId,
      file_number: `LK-${stamp}-${index}`,
    })),
  );
  if (patients.error) throw patients.error;

  futureIso = new Date(Date.now() + 5 * 86_400_000).toISOString();
  secondFutureIso = new Date(Date.now() + 9 * 86_400_000).toISOString();
  const appointments = await service.from("appointments").insert([
    {
      clinic_id: clinicId,
      patient_id: B.id,
      doctor_id: doctorId,
      department_id: departmentId,
      scheduled_at: futureIso,
      duration_minutes: 30,
      status: "pending",
      created_by: adminId,
    },
    {
      clinic_id: clinicId,
      patient_id: A.id,
      doctor_id: doctorId,
      department_id: departmentId,
      scheduled_at: secondFutureIso,
      duration_minutes: 30,
      status: "confirmed",
      created_by: adminId,
    },
  ]);
  if (appointments.error) throw appointments.error;

  // The sender's own thread: linked to A, and date-of-birth verified. If any
  // fallback to `conversations.patient_id` existed, this is the thread that
  // would expose it.
  const sender = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: A.phone,
      status: "open",
      patient_id: A.id,
      patient_link_status: "automatic",
      identity_verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (sender.error) throw sender.error;
  senderConversationId = sender.data.id;

  const stranger = await service
    .from("conversations")
    .insert({
      clinic_id: clinicId,
      channel: "whatsapp",
      participant_address: `+2019${stamp}`,
      status: "open",
    })
    .select("id")
    .single();
  if (stranger.error) throw stranger.error;
  strangerConversationId = stranger.data.id;
}, 90_000);

afterAll(cleanup, 60_000);

beforeEach(async () => {
  await service
    .from("conversations")
    .update({
      identity_verification_failures: 0,
      identity_verification_locked_until: null,
    })
    .in("id", [senderConversationId, strangerConversationId]);
});

async function lookup(
  input: { full_name: string; national_id: string },
  thread = strangerConversationId,
) {
  const { buildPatientTools } = await import("@/lib/ai/patient-tools");
  const mounted = buildPatientTools(
    { clinicId, conversationId: thread, locale: "ar" },
    "patient_booking",
  );
  return (await mounted.lookup_appointment!.execute!(
    input as never,
    {} as never,
  )) as Record<string, unknown>;
}

type Row = { doctor_name: string; department_name: string; scheduled_at: string };

// ---------------------------------------------------------------------------

describe("P11 §10-11 · the happy path asks for two fields and finds one file", () => {
  it("finds the upcoming appointment from an exact Arabic name and id", async () => {
    const result = await lookup({ full_name: B.name, national_id: B.nationalId });
    expect(result.found).toBe(true);
    const rows = result.appointments as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doctor_name).toBe("Rana Wasfy");
    expect(new Date(rows[0]!.scheduled_at).toISOString()).toBe(futureIso);
  });

  it("normalizes the name the way a patient actually types it", async () => {
    for (const typed of [
      "  سارة كمال إبراهيم ",
      "سارة  كمال  ابراهيم",
      "ساره كمال ابراهيم",
    ]) {
      const result = await lookup({ full_name: typed, national_id: B.nationalId });
      expect(result.found, typed).toBe(true);
    }
  });

  it("accepts Arabic-digit national ids", async () => {
    const arabicDigits = B.nationalId.replace(/[0-9]/g, (d) =>
      String.fromCharCode(0x0660 + Number(d)),
    );
    const result = await lookup({ full_name: B.name, national_id: arabicDigits });
    expect(result.found).toBe(true);
  });

  it("returns several upcoming appointments, soonest first", async () => {
    const extra = new Date(Date.now() + 12 * 86_400_000).toISOString();
    const inserted = await service.from("appointments").insert({
      clinic_id: clinicId,
      patient_id: B.id,
      doctor_id: doctorId,
      department_id: departmentId,
      scheduled_at: extra,
      duration_minutes: 30,
      status: "pending",
      created_by: adminId,
    });
    if (inserted.error) throw inserted.error;

    const result = await lookup({ full_name: B.name, national_id: B.nationalId });
    const rows = result.appointments as Row[];
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0]!.scheduled_at).getTime()).toBeLessThan(
      new Date(rows[1]!.scheduled_at).getTime(),
    );

    await service.from("appointments").delete().eq("scheduled_at", extra);
  });

  it("says there is no upcoming appointment without saying why", async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await service
      .from("appointments")
      .update({ scheduled_at: past })
      .eq("patient_id", B.id);

    const result = await lookup({ full_name: B.name, national_id: B.nationalId });
    expect(result.found).toBe(true);
    expect(result.appointment_count).toBe(0);

    await service
      .from("appointments")
      .update({ scheduled_at: futureIso })
      .eq("patient_id", B.id);
  });
});

describe("P11 §11 · one indistinguishable answer for every failure", () => {
  it.each([
    ["wrong name, right id", "Someone Else Entirely", () => B.nationalId],
    ["right name, wrong id", () => B.name, "19999999999999"],
    ["both wrong", "Nobody At All", "19999999999998"],
    ["another patient's id with this name", () => B.name, () => A.nationalId],
  ])("%s → no_match", async (_label, name, id) => {
    const result = await lookup({
      full_name: typeof name === "function" ? name() : name,
      national_id: typeof id === "function" ? id() : id,
    });
    expect(result.found).toBe(false);
    expect(result.reason).toBe("no_match");
  });

  it("is not an existence oracle: every failure guidance is identical", async () => {
    const guidances = new Set<string>();
    for (const [name, id] of [
      ["Someone Else Entirely", B.nationalId],
      [B.name, "19999999999999"],
      ["Nobody At All", "19999999999998"],
    ] as const) {
      const result = await lookup({ full_name: name, national_id: id });
      guidances.add(String(result.guidance));
    }
    expect(guidances.size).toBe(1);
  });

  it("locks the conversation after five failures, on the shared counter", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await lookup({ full_name: "Nobody At All", national_id: `1999999999999${attempt}` });
    }
    const locked = await lookup({ full_name: B.name, national_id: B.nationalId });
    expect(locked.reason).toBe("identity_verification_locked");

    const row = await service
      .from("conversations")
      .select("identity_verification_locked_until")
      .eq("id", strangerConversationId)
      .single();
    expect(row.data?.identity_verification_locked_until).not.toBeNull();
  });

  it("a successful lookup restores the attempt budget", async () => {
    await lookup({ full_name: "Nobody At All", national_id: "19999999999997" });
    await lookup({ full_name: B.name, national_id: B.nationalId });
    const row = await service
      .from("conversations")
      .select("identity_verification_failures")
      .eq("id", strangerConversationId)
      .single();
    expect(row.data?.identity_verification_failures).toBe(0);
  });
});

describe("P11 §12 · no cross-patient leak, in either direction", () => {
  it("returns B's appointment when A's thread supplies B's identity", async () => {
    const result = await lookup(
      { full_name: B.name, national_id: B.nationalId },
      senderConversationId,
    );
    expect(result.found).toBe(true);
    const rows = result.appointments as Row[];
    expect(rows).toHaveLength(1);
    // B's appointment, not A's — and A's own is at a different instant, so the
    // assertion cannot pass by accident.
    expect(new Date(rows[0]!.scheduled_at).toISOString()).toBe(futureIso);
    expect(new Date(rows[0]!.scheduled_at).toISOString()).not.toBe(secondFutureIso);
  });

  it("never falls back to the thread's own patient when the identity misses", async () => {
    const result = await lookup(
      { full_name: "Nobody At All", national_id: "19999999999996" },
      senderConversationId,
    );
    expect(result.found).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secondFutureIso);
    expect(JSON.stringify(result)).not.toContain("Omar");
  });

  it("changes nothing about who the conversation is", async () => {
    const before = await service
      .from("conversations")
      .select("patient_id, patient_link_status, identity_verified_at, booking_identity_confirmed_at")
      .eq("id", strangerConversationId)
      .single();
    await lookup({ full_name: B.name, national_id: B.nationalId });
    const after = await service
      .from("conversations")
      .select("patient_id, patient_link_status, identity_verified_at, booking_identity_confirmed_at")
      .eq("id", strangerConversationId)
      .single();
    expect(after.data).toEqual(before.data);
    // Specifically: an unlinked thread stays unlinked and unverified, so this
    // path cannot be used as a step towards clinical disclosure.
    expect(after.data?.patient_id).toBeNull();
    expect(after.data?.identity_verified_at).toBeNull();
  });
});

describe("P11 §13 · booking identity is not clinical identity", () => {
  it("a successful lookup does not unlock list_my_appointments", async () => {
    await lookup({ full_name: B.name, national_id: B.nationalId });
    const { buildPatientTools } = await import("@/lib/ai/patient-tools");
    const mounted = buildPatientTools(
      { clinicId, conversationId: strangerConversationId, locale: "ar" },
      "patient_booking",
    );
    const result = (await mounted.list_my_appointments!.execute!(
      {} as never,
      {} as never,
    )) as Record<string, unknown>;
    expect(result.permission_denied).toBe(true);
    expect(result.appointments).toBeUndefined();
  });

  it("discloses appointment logistics and no clinical field", async () => {
    const result = await lookup({ full_name: B.name, national_id: B.nationalId });
    const rows = result.appointments as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "date",
      "department_name",
      "doctor_name",
      "duration_minutes",
      "scheduled_at",
      "service_name",
      "status",
      "time",
    ]);
    expect(result.clinical_disclosure_allowed).toBe(false);
  });

  it("audits the lookup as booking scope", async () => {
    await service.from("audit_logs").delete().eq("clinic_id", clinicId);
    await lookup({ full_name: B.name, national_id: B.nationalId });
    const logs = await service
      .from("audit_logs")
      .select("action, new_data")
      .eq("clinic_id", clinicId);
    const actions = (logs.data ?? []).map((row) => row.action);
    expect(actions).toContain("AI_APPOINTMENT_LOOKUP_MATCHED");
    for (const row of logs.data ?? []) {
      if (!String(row.action).startsWith("AI_APPOINTMENT_LOOKUP")) continue;
      expect((row.new_data as Record<string, unknown>).clinical_disclosure).toBe(false);
    }
  });
});
