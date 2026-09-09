/**
 * D3 — one WhatsApp thread, many sequential beneficiaries, proved against a
 * live PostgreSQL.
 *
 * A family shares a phone. Requester A owns the thread and uses it to register
 * his wife B, then his son C, then his daughter D. Each is a separate patient
 * identity; the thread stays A's throughout.
 *
 * `ai_patient_intakes_conversation_unique (clinic_id, conversation_id)` made
 * that impossible — one intake row per conversation, ever — so once B's intake
 * was approved the staging of C silently did nothing and returned
 * `already_reviewed`. The migration replaces it with
 * `ai_patient_intakes_one_pending_per_conversation`, a partial unique index on
 * `review_status = 'pending_review'`.
 *
 * What is proved here:
 *
 *   1. the sequential lifecycle A -> B -> C -> D, with each approval producing
 *      that beneficiary's own file and that beneficiary's own appointment;
 *   2. `conversations.patient_id` is A at every single step;
 *   3. a historical intake — approved, rejected or dismissed — is never
 *      touched, never reused, and never authorizes a later beneficiary;
 *   4. the pending row is reused for a retry (same folded national id) and
 *      superseded, never overwritten, for a different beneficiary;
 *   5. a superseded intake's own pending appointment request is dismissed with
 *      it, and no other request on the thread is;
 *   6. at most one `pending_review` intake exists per conversation, including
 *      under concurrent staging;
 *   7. a shared phone collapses no identity — the national id is the boundary;
 *   8. both staging functions behave identically.
 *
 * Run against the local stack (`supabase start`), never against Production.
 */

import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");

type Client = SupabaseClient<Database>;
const suffix = `d3-seq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "SequentialIntake12345";

const ids = {
  clinic: randomUUID(),
  department: randomUUID(),
  /** Requester A — the owner of every thread in this file. */
  requester: randomUUID(),
};

/**
 * The one number the whole family uses.
 *
 * Every beneficiary staged here is given it deliberately: phone must be
 * contact data and must never decide that two people are the same person.
 */
const SHARED_PHONE = `9066${`${Date.now()}`.slice(-7)}`;

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

const userIds: string[] = [];
async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("No user");
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

function mustSucceed(result: { error: { message: string } | null }, label: string) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

let receptionist: Awaited<ReturnType<typeof createUser>>;
let doctor: Awaited<ReturnType<typeof createUser>>;

let counter = 0;
const nationalId = () => `${Date.now()}${(counter += 1)}`.slice(-11);
const phone = () => `9077${`${Date.now()}${(counter += 1)}`.slice(-7)}`;

/**
 * A bookable instant three days out, at a distinct hour per case.
 *
 * Three days clears the 24-hour minimum notice, and a distinct hour keeps the
 * per-doctor slot cap out of every assertion in this file.
 */
function futureSlot(hourUtc: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

async function openConversation(patientId: string | null) {
  const id = randomUUID();
  mustSucceed(
    await service.from("conversations").insert({
      id,
      clinic_id: ids.clinic,
      channel: "whatsapp",
      // A distinct address per thread: `conversations` carries a legacy unique
      // index on it, and these cases each stand for a different clinic's
      // thread. The number that matters to this file is the one on the
      // *patient* rows, which is deliberately shared.
      participant_address: phone(),
      status: "open",
      patient_id: patientId,
      patient_link_status: patientId ? "automatic" : "unlinked",
      ai_paused_at: null,
    }),
    "conversation",
  );
  return id;
}

/** One beneficiary's details, stable across a retry. */
type Beneficiary = {
  fullName: string;
  nationalId: string;
  dateOfBirth: string;
  email: string;
};

function beneficiary(name: string, dateOfBirth: string): Beneficiary {
  return {
    fullName: name,
    nationalId: nationalId(),
    dateOfBirth,
    email: `${suffix}-${(counter += 1)}@example.com`,
  };
}

/**
 * Stage a third-party intake for `who` on `conversationId`.
 *
 * Always on the shared family number, so every staging in this file is one
 * where a phone-based identity rule would have collapsed two people.
 */
async function stageThirdParty(conversationId: string, who: Beneficiary) {
  const result = await service.rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_full_name: who.fullName,
    p_national_id: who.nationalId,
    p_date_of_birth: who.dateOfBirth,
    p_email: who.email,
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
    p_for_third_party: true,
    p_phone: SHARED_PHONE,
  });
  mustSucceed(result, `stage ${who.fullName}`);
  return result.data![0]!;
}

async function requestSlot(conversationId: string, slot: Date) {
  const result = await service.rpc("create_provisional_ai_appointment_request", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_doctor_id: doctor.id,
    p_scheduled_at: slot.toISOString(),
    p_duration_minutes: 30,
  });
  mustSucceed(result, "provisional request");
  return result.data![0]!.request_id;
}

async function approve(intakeId: string) {
  return receptionist.client.rpc("approve_ai_patient_intake", {
    p_intake_id: intakeId,
    p_actor_id: receptionist.id,
  });
}

async function intakeRow(intakeId: string) {
  const read = await service
    .from("ai_patient_intakes")
    .select(
      "id, review_status, reviewed_at, reviewed_by, review_reason, approved_patient_id, requested_by_patient_id, is_third_party, full_name, national_id, date_of_birth, conversation_id, created_at",
    )
    .eq("id", intakeId)
    .single();
  mustSucceed(read, "intake read");
  return read.data!;
}

async function intakesOn(conversationId: string) {
  const read = await service
    .from("ai_patient_intakes")
    .select("id, review_status, full_name, approved_patient_id")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  mustSucceed(read, "intakes read");
  return read.data!;
}

async function pendingCount(conversationId: string) {
  const read = await service
    .from("ai_patient_intakes")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("review_status", "pending_review");
  mustSucceed(read, "pending count");
  return read.count ?? 0;
}

async function requestRow(requestId: string) {
  const read = await service
    .from("ai_appointment_requests")
    .select("status, appointment_id, intake_id")
    .eq("id", requestId)
    .single();
  mustSucceed(read, "request read");
  return read.data!;
}

async function conversationPatient(conversationId: string) {
  const read = await service
    .from("conversations")
    .select("patient_id, patient_link_status")
    .eq("id", conversationId)
    .single();
  mustSucceed(read, "conversation read");
  return read.data!;
}

async function appointmentPatient(appointmentId: string) {
  const read = await service
    .from("appointments")
    .select("patient_id, ai_patient_conversation_id")
    .eq("id", appointmentId)
    .single();
  mustSucceed(read, "appointment read");
  return read.data!;
}

/** The booking-authorization helper, as the roles that hold EXECUTE on it. */
async function helperSays(conversationId: string, patientId: string) {
  const result = await service.rpc("ai_conversation_booking_beneficiary_matches", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_patient_id: patientId,
  });
  mustSucceed(result, "helper");
  return result.data;
}

/** The assistant's own booking surface: a service-role AI-provenance insert. */
async function serviceRoleBooking(input: {
  conversationId: string;
  patientId: string;
  slot: Date;
}) {
  return service.from("appointments").insert({
    clinic_id: ids.clinic,
    patient_id: input.patientId,
    doctor_id: doctor.id,
    department_id: ids.department,
    scheduled_at: input.slot.toISOString(),
    duration_minutes: 30,
    status: "pending",
    created_by: null,
    ai_patient_conversation_id: input.conversationId,
  });
}

beforeAll(async () => {
  [receptionist, doctor] = await Promise.all([
    createUser("receptionist"),
    createUser("doctor"),
  ]);
  mustSucceed(
    await service.from("clinics").insert({
      id: ids.clinic,
      name: `D3 sequential ${suffix}`,
      country: "KW",
      timezone: "Asia/Kuwait",
      ai_pending_booking_ttl_minutes: 60,
      ai_pending_slot_cap: 2,
    }),
    "clinic",
  );
  mustSucceed(
    await service.from("departments").insert({
      id: ids.department,
      clinic_id: ids.clinic,
      name: `Dept ${suffix}`,
      color: "#0891b2",
    }),
    "department",
  );
  mustSucceed(
    await service.from("profiles").insert([
      {
        id: receptionist.id,
        clinic_id: ids.clinic,
        full_name: "Reviewing Receptionist",
        role: "receptionist",
      },
      {
        id: doctor.id,
        clinic_id: ids.clinic,
        full_name: "Assigned Doctor",
        role: "doctor",
        department_id: ids.department,
      },
    ]),
    "profiles",
  );
  // Every day of the week, so no assertion in this file depends on which day
  // "three days from now" happens to land on.
  mustSucceed(
    await service.from("doctor_schedules").insert(
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        clinic_id: ids.clinic,
        doctor_id: doctor.id,
        day_of_week: day,
        start_time: "06:00:00",
        end_time: "22:00:00",
        is_enabled: true,
      })),
    ),
    "schedules",
  );
  // Requester A, on the family's shared number.
  mustSucceed(
    await service.from("patients").insert({
      id: ids.requester,
      clinic_id: ids.clinic,
      full_name: "Adel Fouad",
      phone: SHARED_PHONE,
      date_of_birth: "1982-02-09",
      email: `${suffix}-requester@example.com`,
      national_id: nationalId(),
      file_number: `${suffix}-A1`,
      department_id: ids.department,
      created_by: receptionist.id,
    }),
    "requester",
  );
}, 60_000);

afterAll(async () => {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", ids.clinic);
  await service.from("appointments").delete().eq("clinic_id", ids.clinic);
  await service.from("ai_patient_intakes").delete().eq("clinic_id", ids.clinic);
  await service.from("conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.clinic);
  await service.from("doctor_schedules").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("departments").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  for (const id of userIds) await service.auth.admin.deleteUser(id);
  await receptionist?.client.auth.signOut();
  await doctor?.client.auth.signOut();
}, 60_000);

describe("one thread, three sequential beneficiaries", () => {
  it("registers and books B, then C, then D, with the thread staying A's", async () => {
    const conversationId = await openConversation(ids.requester);

    // ---------------------------------------------------------------- wife B
    const wife = beneficiary("Soad Ibrahim", "1986-05-14");
    const stagedB = await stageThirdParty(conversationId, wife);
    expect(stagedB.status).toBe("staged");
    const intakeB = stagedB.intake_id!;
    const requestB = await requestSlot(conversationId, futureSlot(7));

    const approvedB = await approve(intakeB);
    mustSucceed(approvedB, "approve B");
    const patientB = approvedB.data![0]!.patient_id!;
    const appointmentB = approvedB.data![0]!.appointment_id!;
    expect(patientB).toBeTruthy();
    expect(appointmentB).toBeTruthy();

    expect(await appointmentPatient(appointmentB)).toMatchObject({
      patient_id: patientB,
      ai_patient_conversation_id: conversationId,
    });
    expect(await requestRow(requestB)).toMatchObject({
      status: "linked",
      appointment_id: appointmentB,
      intake_id: intakeB,
    });
    // The thread did not move onto the wife.
    expect(await conversationPatient(conversationId)).toMatchObject({
      patient_id: ids.requester,
    });
    const rowB = await intakeRow(intakeB);
    expect(rowB.review_status).toBe("approved");
    expect(rowB.approved_patient_id).toBe(patientB);
    expect(rowB.requested_by_patient_id).toBe(ids.requester);

    // ----------------------------------------------------------------- son C
    // The exact case the lifetime index refused: a second beneficiary on a
    // thread whose only intake had already been approved.
    const son = beneficiary("Nour Mohamad Ali", "2015-04-02");
    const stagedC = await stageThirdParty(conversationId, son);
    expect(stagedC.status).toBe("staged");
    const intakeC = stagedC.intake_id!;
    expect(intakeC).not.toBe(intakeB);

    // B's row is byte-for-byte what it was.
    expect(await intakeRow(intakeB)).toEqual(rowB);

    const requestC = await requestSlot(conversationId, futureSlot(9));
    expect(await requestRow(requestC)).toMatchObject({
      status: "pending",
      intake_id: intakeC,
    });
    // Approving C must not consume the request that belongs to B.
    expect(await requestRow(requestB)).toMatchObject({
      status: "linked",
      appointment_id: appointmentB,
    });

    const approvedC = await approve(intakeC);
    mustSucceed(approvedC, "approve C");
    const patientC = approvedC.data![0]!.patient_id!;
    const appointmentC = approvedC.data![0]!.appointment_id!;
    expect(patientC).not.toBe(patientB);
    expect(patientC).not.toBe(ids.requester);
    expect(appointmentC).not.toBe(appointmentB);

    expect(await appointmentPatient(appointmentC)).toMatchObject({
      patient_id: patientC,
    });
    expect(await requestRow(requestC)).toMatchObject({
      status: "linked",
      appointment_id: appointmentC,
      intake_id: intakeC,
    });
    // B's appointment is still B's.
    expect(await appointmentPatient(appointmentB)).toMatchObject({
      patient_id: patientB,
    });
    expect(await conversationPatient(conversationId)).toMatchObject({
      patient_id: ids.requester,
    });
    expect(await intakeRow(intakeB)).toEqual(rowB);

    // ------------------------------------------------------------ daughter D
    const daughter = beneficiary("Malak Mohamad Ali", "2018-09-30");
    const stagedD = await stageThirdParty(conversationId, daughter);
    expect(stagedD.status).toBe("staged");
    const intakeD = stagedD.intake_id!;
    expect(new Set([intakeB, intakeC, intakeD]).size).toBe(3);

    const approvedD = await approve(intakeD);
    mustSucceed(approvedD, "approve D");
    const patientD = approvedD.data![0]!.patient_id!;
    expect(new Set([ids.requester, patientB, patientC, patientD]).size).toBe(4);

    // Three independent historical records on one thread.
    const all = await intakesOn(conversationId);
    expect(all).toHaveLength(3);
    expect(all.map((row) => row.review_status)).toEqual([
      "approved",
      "approved",
      "approved",
    ]);
    expect(all.map((row) => row.full_name)).toEqual([
      wife.fullName,
      son.fullName,
      daughter.fullName,
    ]);
    expect(await conversationPatient(conversationId)).toMatchObject({
      patient_id: ids.requester,
      patient_link_status: "automatic",
    });
    // A never acquired an appointment of his own.
    const adelAppointments = await service
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", ids.clinic)
      .eq("patient_id", ids.requester);
    expect(adelAppointments.count ?? 0).toBe(0);
  }, 60_000);

  it("stages a new beneficiary after a rejected one", async () => {
    const conversationId = await openConversation(ids.requester);
    const first = beneficiary("Hala Rejected", "1990-01-11");
    const intakeFirst = (await stageThirdParty(conversationId, first)).intake_id!;

    const rejected = await receptionist.client.rpc("reject_ai_patient_intake", {
      p_intake_id: intakeFirst,
      p_actor_id: receptionist.id,
      p_reason: "not a real request",
    });
    mustSucceed(rejected, "reject");
    expect(rejected.data).toBe(true);
    const rejectedRow = await intakeRow(intakeFirst);
    expect(rejectedRow.review_status).toBe("rejected");

    const second = beneficiary("Yasmin Second", "1994-06-06");
    const staged = await stageThirdParty(conversationId, second);
    expect(staged.status).toBe("staged");
    expect(staged.intake_id).not.toBe(intakeFirst);
    // The rejection is untouched.
    expect(await intakeRow(intakeFirst)).toEqual(rejectedRow);
    expect(await pendingCount(conversationId)).toBe(1);
  }, 60_000);
});

describe("a pending intake is reused for a retry and superseded for a stranger", () => {
  it("reuses the same pending row when the same beneficiary is re-staged", async () => {
    const conversationId = await openConversation(ids.requester);
    const who = beneficiary("Retry Beneficiary", "1988-03-03");

    const first = await stageThirdParty(conversationId, who);
    expect(first.status).toBe("staged");

    // A redelivered webhook, or a corrected turn restating the same person.
    const second = await stageThirdParty(conversationId, who);
    expect(second.status).toBe("staged");
    expect(second.intake_id).toBe(first.intake_id);

    const third = await stageThirdParty(conversationId, {
      ...who,
      // A display correction on the same identity is still the same person.
      fullName: "Retry Beneficiary Corrected",
    });
    expect(third.intake_id).toBe(first.intake_id);

    expect(await intakesOn(conversationId)).toHaveLength(1);
    expect(await pendingCount(conversationId)).toBe(1);
    const row = await intakeRow(first.intake_id!);
    expect(row.review_status).toBe("pending_review");
    expect(row.full_name).toBe("Retry Beneficiary Corrected");
  }, 60_000);

  it("supersedes a pending intake staged for a different beneficiary", async () => {
    const conversationId = await openConversation(ids.requester);
    const wife = beneficiary("Pending Wife", "1987-07-07");
    const intakeWife = (await stageThirdParty(conversationId, wife)).intake_id!;
    const requestWife = await requestSlot(conversationId, futureSlot(11));
    expect(await requestRow(requestWife)).toMatchObject({ status: "pending" });

    // The requester turns to a different child before anyone reviewed the wife.
    const son = beneficiary("Pending Son", "2016-02-02");
    const stagedSon = await stageThirdParty(conversationId, son);
    expect(stagedSon.status).toBe("staged");
    const intakeSon = stagedSon.intake_id!;
    expect(intakeSon).not.toBe(intakeWife);

    // The wife's row is preserved as history, not rewritten into the son.
    const supersededRow = await intakeRow(intakeWife);
    expect(supersededRow.review_status).toBe("dismissed");
    expect(supersededRow.review_reason).toBe("superseded_by_new_beneficiary");
    expect(supersededRow.reviewed_at).not.toBeNull();
    expect(supersededRow.reviewed_by).toBeNull();
    expect(supersededRow.approved_patient_id).toBeNull();
    expect(supersededRow.full_name).toBe(wife.fullName);
    expect(supersededRow.national_id).toBe(wife.nationalId);
    expect(supersededRow.date_of_birth).toBe(wife.dateOfBirth);

    // Her provisional booking went with her intake, and only hers.
    expect(await requestRow(requestWife)).toMatchObject({
      status: "dismissed",
      intake_id: intakeWife,
      appointment_id: null,
    });

    // The supersession is on the record.
    const audit = await service
      .from("audit_logs")
      .select("action, record_id, new_data")
      .eq("clinic_id", ids.clinic)
      .eq("action", "AI_PATIENT_INTAKE_SUPERSEDED")
      .eq("record_id", intakeWife);
    mustSucceed(audit, "audit read");
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0]!.new_data).toMatchObject({
      review_status: "dismissed",
      review_reason: "superseded_by_new_beneficiary",
      conversation_id: conversationId,
      dismissed_appointment_requests: 1,
    });

    expect(await pendingCount(conversationId)).toBe(1);

    // And a third beneficiary stages cleanly after the dismissed one.
    const daughter = beneficiary("Pending Daughter", "2019-12-12");
    const stagedDaughter = await stageThirdParty(conversationId, daughter);
    expect(stagedDaughter.status).toBe("staged");
    expect(await intakeRow(intakeWife)).toEqual(supersededRow);
    expect(await intakesOn(conversationId)).toHaveLength(3);
    expect(await pendingCount(conversationId)).toBe(1);

    // The son's superseded row is itself preserved.
    const sonRow = await intakeRow(intakeSon);
    expect(sonRow.review_status).toBe("dismissed");
    expect(sonRow.full_name).toBe(son.fullName);
  }, 60_000);

  it("keeps at most one pending intake under concurrent staging", async () => {
    const conversationId = await openConversation(ids.requester);
    const one = beneficiary("Race One", "1991-01-01");
    const two = beneficiary("Race Two", "1992-02-02");
    const three = beneficiary("Race Three", "1993-03-03");

    const results = await Promise.all([
      stageThirdParty(conversationId, one),
      stageThirdParty(conversationId, two),
      stageThirdParty(conversationId, three),
    ]);
    for (const result of results) expect(result.status).toBe("staged");

    // The conversation's FOR UPDATE serializes them; the partial index is the
    // backstop. Either way exactly one row may be pending.
    expect(await pendingCount(conversationId)).toBe(1);
    const rows = await intakesOn(conversationId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.review_status === "dismissed")).toHaveLength(2);
  }, 60_000);

  it("stages concurrent identical retries as one row", async () => {
    const conversationId = await openConversation(ids.requester);
    const who = beneficiary("Concurrent Retry", "1995-05-05");
    const results = await Promise.all([
      stageThirdParty(conversationId, who),
      stageThirdParty(conversationId, who),
      stageThirdParty(conversationId, who),
    ]);
    const distinct = new Set(results.map((result) => result.intake_id));
    expect(distinct.size).toBe(1);
    expect(await intakesOn(conversationId)).toHaveLength(1);
  }, 60_000);
});

describe("history never authorizes a later beneficiary", () => {
  it("refuses a booking for an unapproved beneficiary on a thread that holds an approved one", async () => {
    const conversationId = await openConversation(ids.requester);
    const wife = beneficiary("Authorized Wife", "1985-08-08");
    const intakeWife = (await stageThirdParty(conversationId, wife)).intake_id!;
    const approvedWife = await approve(intakeWife);
    mustSucceed(approvedWife, "approve wife");
    const patientWife = approvedWife.data![0]!.patient_id!;

    // The durable exemption names her, and only her.
    expect(await helperSays(conversationId, patientWife)).toBe(true);
    expect(await helperSays(conversationId, ids.requester)).toBe(false);

    // A second beneficiary, staged but not yet reviewed.
    const son = beneficiary("Unapproved Son", "2017-10-10");
    const intakeSon = (await stageThirdParty(conversationId, son)).intake_id!;
    const sonRow = await intakeRow(intakeSon);
    expect(sonRow.review_status).toBe("pending_review");
    expect(sonRow.approved_patient_id).toBeNull();

    // His file does not exist yet, so the sharpest available proof is that the
    // wife's approved row authorizes nobody but the wife: the helper is false
    // for A, and a service-role AI booking naming A on this thread is refused
    // even though the thread is A's own — because A is not the beneficiary of
    // any third-party intake here.
    const refused = await serviceRoleBooking({
      conversationId,
      patientId: patientWife,
      slot: futureSlot(13),
    });
    // The wife *is* authorized, so this one is allowed — the control that the
    // exemption still works at all.
    mustSucceed(refused, "authorized booking");

    // Now approve the son and prove the two beneficiaries stayed separate.
    const approvedSon = await approve(intakeSon);
    mustSucceed(approvedSon, "approve son");
    const patientSon = approvedSon.data![0]!.patient_id!;
    expect(patientSon).not.toBe(patientWife);
    expect(await helperSays(conversationId, patientSon)).toBe(true);
    expect(await helperSays(conversationId, ids.requester)).toBe(false);
    expect(await conversationPatient(conversationId)).toMatchObject({
      patient_id: ids.requester,
    });
  }, 60_000);

  it("refuses an AI booking for a patient no intake on the thread names", async () => {
    const conversationId = await openConversation(ids.requester);
    const wife = beneficiary("Boundary Wife", "1984-04-04");
    const intakeWife = (await stageThirdParty(conversationId, wife)).intake_id!;
    const approved = await approve(intakeWife);
    mustSucceed(approved, "approve");

    // A patient of this clinic who is not a beneficiary of anything on this
    // thread. The approved historical row must not admit them.
    const strangerId = randomUUID();
    mustSucceed(
      await service.from("patients").insert({
        id: strangerId,
        clinic_id: ids.clinic,
        full_name: "Unrelated Patient",
        phone: phone(),
        date_of_birth: "1975-05-15",
        email: `${suffix}-stranger@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-S1`,
        department_id: ids.department,
        created_by: receptionist.id,
      }),
      "stranger",
    );

    expect(await helperSays(conversationId, strangerId)).toBe(false);
    const refused = await serviceRoleBooking({
      conversationId,
      patientId: strangerId,
      slot: futureSlot(15),
    });
    expect(refused.error?.message ?? "").toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
  }, 60_000);
});

describe("the matched-existing stager behaves identically", () => {
  it("supersedes a pending intake staged for somebody else", async () => {
    const conversationId = await openConversation(ids.requester);

    // A beneficiary who already has a file here.
    const existingId = randomUUID();
    const existing = {
      fullName: "Laila Existing",
      nationalId: nationalId(),
    };
    mustSucceed(
      await service.from("patients").insert({
        id: existingId,
        clinic_id: ids.clinic,
        full_name: existing.fullName,
        phone: SHARED_PHONE,
        date_of_birth: "1996-07-21",
        email: `${suffix}-existing@example.com`,
        national_id: existing.nationalId,
        file_number: `${suffix}-E1`,
        department_id: ids.department,
        created_by: receptionist.id,
      }),
      "existing patient",
    );

    // First, a pending intake for a different, brand-new beneficiary.
    const other = beneficiary("Matched Displaced", "2014-01-01");
    const intakeOther = (await stageThirdParty(conversationId, other)).intake_id!;

    const matched = await service.rpc("stage_matched_third_party_intake", {
      p_clinic_id: ids.clinic,
      p_conversation_id: conversationId,
      p_full_name: existing.fullName,
      p_national_id: existing.nationalId,
      p_phone: SHARED_PHONE,
      p_department_id: ids.department,
      p_doctor_id: doctor.id,
    });
    mustSucceed(matched, "matched stage");
    expect(matched.data![0]!.status).toBe("staged_existing");
    const intakeMatched = matched.data![0]!.intake_id!;
    expect(intakeMatched).not.toBe(intakeOther);

    const displaced = await intakeRow(intakeOther);
    expect(displaced.review_status).toBe("dismissed");
    expect(displaced.review_reason).toBe("superseded_by_new_beneficiary");
    expect(displaced.reviewed_by).toBeNull();
    expect(displaced.full_name).toBe(other.fullName);
    expect(await pendingCount(conversationId)).toBe(1);

    // Re-running the same matched staging reuses its own pending row.
    const again = await service.rpc("stage_matched_third_party_intake", {
      p_clinic_id: ids.clinic,
      p_conversation_id: conversationId,
      p_full_name: existing.fullName,
      p_national_id: existing.nationalId,
      p_phone: SHARED_PHONE,
      p_department_id: ids.department,
      p_doctor_id: doctor.id,
    });
    mustSucceed(again, "matched restage");
    expect(again.data![0]!.intake_id).toBe(intakeMatched);
    expect(await intakesOn(conversationId)).toHaveLength(2);
  }, 60_000);
});

describe("the shared family number is contact data, never identity", () => {
  it("keeps four people on one number as four distinct files", async () => {
    const conversationId = await openConversation(ids.requester);
    const first = beneficiary("Shared Phone One", "1989-09-09");
    const second = beneficiary("Shared Phone Two", "2011-11-11");

    const intakeFirst = (await stageThirdParty(conversationId, first)).intake_id!;
    const approvedFirst = await approve(intakeFirst);
    mustSucceed(approvedFirst, "approve first");
    const patientFirst = approvedFirst.data![0]!.patient_id!;

    const intakeSecond = (await stageThirdParty(conversationId, second)).intake_id!;
    const approvedSecond = await approve(intakeSecond);
    mustSucceed(approvedSecond, "approve second");
    const patientSecond = approvedSecond.data![0]!.patient_id!;

    expect(patientFirst).not.toBe(patientSecond);
    expect(new Set([ids.requester, patientFirst, patientSecond]).size).toBe(3);

    // All three really do share the one number.
    const onNumber = await service
      .from("patients")
      .select("id")
      .eq("clinic_id", ids.clinic)
      .eq("phone", SHARED_PHONE);
    mustSucceed(onNumber, "phone read");
    const onNumberIds = new Set(onNumber.data!.map((row) => row.id));
    expect(onNumberIds.has(ids.requester)).toBe(true);
    expect(onNumberIds.has(patientFirst)).toBe(true);
    expect(onNumberIds.has(patientSecond)).toBe(true);

    expect(await conversationPatient(conversationId)).toMatchObject({
      patient_id: ids.requester,
    });
  }, 60_000);
});

describe("the database refuses a second pending intake outright", () => {
  it("rejects a direct insert that would create one", async () => {
    const conversationId = await openConversation(ids.requester);
    const who = beneficiary("Index Guard", "1993-04-04");
    await stageThirdParty(conversationId, who);

    const second = await service.from("ai_patient_intakes").insert({
      clinic_id: ids.clinic,
      conversation_id: conversationId,
      full_name: "Second Pending",
      date_of_birth: "1999-09-09",
      phone: SHARED_PHONE,
      email: `${suffix}-second@example.com`,
      national_id: nationalId(),
      department_id: ids.department,
      doctor_id: doctor.id,
      is_third_party: true,
      requested_by_patient_id: ids.requester,
    });
    expect(second.error?.message ?? "").toContain(
      "ai_patient_intakes_one_pending_per_conversation",
    );
  }, 60_000);

  it("allows a historical row beside a pending one", async () => {
    const conversationId = await openConversation(ids.requester);
    const first = beneficiary("History Beside", "1981-01-01");
    const intakeFirst = (await stageThirdParty(conversationId, first)).intake_id!;
    mustSucceed(await approve(intakeFirst), "approve");

    const second = beneficiary("Pending Beside", "2012-02-02");
    const staged = await stageThirdParty(conversationId, second);
    expect(staged.status).toBe("staged");

    const rows = await intakesOn(conversationId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.review_status).sort()).toEqual([
      "approved",
      "pending_review",
    ]);
  }, 60_000);
});
