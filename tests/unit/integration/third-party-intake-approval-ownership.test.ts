/**
 * Approving a third-party intake must not hand the sender's thread to the
 * beneficiary — proved against a live PostgreSQL.
 *
 * A WhatsApp thread's `patient_id` settles exactly one question: **who the
 * sender is**. Who the appointment is *for* is a separate fact, established
 * separately (`lib/ai/booking-beneficiary.ts`). The deployed
 * `approve_ai_patient_intake` collapsed the two at review time: it wrote the
 * approved patient into `conversations.patient_id`, restated the conversation's
 * identity-verification state, and handed every unattributed inbound message
 * and attachment to that patient — correct for a self-intake, and for a
 * third-party intake a silent transfer of a father's thread onto his
 * daughter's record.
 *
 * The contract proved here, for the shape the migration establishes:
 *
 *   1. father A is linked to the thread and stages child B;
 *   2. approval creates (or reuses) B's file;
 *   3. `appointments.patient_id` is B — the booking is the beneficiary's;
 *   4. `ai_patient_intakes.approved_patient_id` is B;
 *   5. `ai_patient_intakes.requested_by_patient_id` is still A;
 *   6. `conversations.patient_id` is still A, and so is every other
 *      requester-scoped column: `patient_link_status`, `identity_verified_at`,
 *      `identity_verification_failures`, `identity_verification_locked_until`;
 *   7. A's messages and attachments are not reassigned to B;
 *   8. **self-intake is unchanged** — it still links the thread, stamps the
 *      verification and claims the unattributed messages;
 *   9. a repeated approval is idempotent and preserves all of the above.
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
const suffix = `tp-own-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "ThirdPartyOwn12345";

const ids = {
  clinic: randomUUID(),
  department: randomUUID(),
  /** Father A — linked to the thread, and the requester of every staging here. */
  requester: randomUUID(),
  /** A patient the thread is re-linked to, to prove the drift case. */
  otherLinked: randomUUID(),
  /** A beneficiary who already has a file, for the matched path. */
  matchedBeneficiary: randomUUID(),
  /** A second such file, used only by the authorization tests below. */
  unapprovedBeneficiary: randomUUID(),
};

const MATCHED = {
  fullName: "Laila Mostafa",
  nationalId: `27${`${Date.now()}`.slice(-9)}`,
};

/** The beneficiary of the intakes that are never approved. */
const UNAPPROVED = {
  fullName: "Mariam Salah",
  nationalId: `28${`${Date.now()}`.slice(-9)}`,
};

/**
 * The verification state stamped on A's thread, and expected to survive.
 *
 * Written in PostgREST's own rendering of a `timestamptz`, so the value written
 * and the value read back compare without a format conversion in the way.
 */
const REQUESTER_IDENTITY = {
  verifiedAt: "2026-01-05T08:30:00+00:00",
  failures: 2,
  lockedUntil: "2036-01-05T08:30:00+00:00",
};

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

/** A slot the fixture doctor works, distinct per case so no cap is shared. */
function futureSlot(hourUtc: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 3);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}
const slotDay = futureSlot(9).getUTCDay();

async function openConversation(patientId: string | null) {
  const id = randomUUID();
  mustSucceed(
    await service.from("conversations").insert({
      id,
      clinic_id: ids.clinic,
      channel: "whatsapp",
      participant_address: phone(),
      status: "open",
      patient_id: patientId,
      patient_link_status: patientId ? "automatic" : "unlinked",
      identity_verified_at: patientId ? REQUESTER_IDENTITY.verifiedAt : null,
      identity_verification_failures: patientId ? REQUESTER_IDENTITY.failures : 0,
      identity_verification_locked_until: patientId
        ? REQUESTER_IDENTITY.lockedUntil
        : null,
      ai_paused_at: null,
    }),
    "conversation",
  );
  return id;
}

/**
 * One inbound message and one attachment on the thread with a null
 * `patient_id` — the exact rows the deployed approval reassigned.
 */
async function unattributedInbound(conversationId: string) {
  const messageId = randomUUID();
  const attachmentId = randomUUID();
  mustSucceed(
    await service.from("inbound_messages").insert({
      id: messageId,
      clinic_id: ids.clinic,
      conversation_id: conversationId,
      channel: "whatsapp",
      sender: phone(),
      body: "عايز أحجز",
      patient_id: null,
    }),
    "inbound message",
  );
  mustSucceed(
    await service.from("inbound_message_attachments").insert({
      id: attachmentId,
      clinic_id: ids.clinic,
      conversation_id: conversationId,
      inbound_message_id: messageId,
      media_kind: "image",
      mime_type: "image/jpeg",
      byte_size: 1024,
      status: "stored",
      storage_path: `${ids.clinic}/${conversationId}/${attachmentId}.jpg`,
      patient_id: null,
    }),
    "inbound attachment",
  );
  return { messageId, attachmentId };
}

async function inboundOwners(conversationId: string) {
  const [message, attachment] = await Promise.all([
    service
      .from("inbound_messages")
      .select("patient_id")
      .eq("conversation_id", conversationId)
      .single(),
    service
      .from("inbound_message_attachments")
      .select("patient_id")
      .eq("conversation_id", conversationId)
      .single(),
  ]);
  mustSucceed(message, "inbound message read");
  mustSucceed(attachment, "inbound attachment read");
  return {
    message: message.data!.patient_id,
    attachment: attachment.data!.patient_id,
  };
}

async function conversationState(conversationId: string) {
  const read = await service
    .from("conversations")
    .select(
      "patient_id, patient_link_status, identity_verified_at, identity_verification_failures, identity_verification_locked_until",
    )
    .eq("id", conversationId)
    .single();
  mustSucceed(read, "conversation read");
  return read.data!;
}

async function stage(input: {
  conversationId: string;
  fullName: string;
  forThirdParty?: boolean;
}) {
  const result = await service.rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: ids.clinic,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: nationalId(),
    p_date_of_birth: "2015-04-02",
    p_email: `${suffix}-${(counter += 1)}@example.com`,
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
    p_for_third_party: input.forThirdParty ?? false,
    p_phone: input.forThirdParty ? phone() : undefined,
  });
  mustSucceed(result, "stage");
  expect(result.data?.[0]?.status).toBe("staged");
  return result.data![0]!.intake_id!;
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
    .select("review_status, approved_patient_id, requested_by_patient_id, is_third_party")
    .eq("id", intakeId)
    .single();
  mustSucceed(read, "intake read");
  return read.data!;
}

async function requestRow(requestId: string) {
  const read = await service
    .from("ai_appointment_requests")
    .select("status, appointment_id")
    .eq("id", requestId)
    .single();
  mustSucceed(read, "request read");
  return read.data!;
}

/** A matched third-party staging for the beneficiary that is never approved. */
async function stageUnapproved(conversationId: string) {
  const result = await service.rpc("stage_matched_third_party_intake", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_full_name: UNAPPROVED.fullName,
    p_national_id: UNAPPROVED.nationalId,
    p_phone: phone(),
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
  });
  mustSucceed(result, "matched stage");
  expect(result.data?.[0]?.status).toBe("staged_existing");
  return result.data![0]!.intake_id!;
}

/**
 * What the assistant's own booking path can do: a service-role insert of an
 * AI-provenance pending appointment. This is the surface the exemption widens,
 * so it is the surface the negative controls push on.
 */
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

/** The helper itself, called as the two roles that hold EXECUTE on it. */
async function helperSays(client: Client, conversationId: string, patientId: string) {
  const result = await client.rpc("ai_conversation_booking_beneficiary_matches", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_patient_id: patientId,
  });
  mustSucceed(result, "helper");
  return result.data;
}

beforeAll(async () => {
  [receptionist, doctor] = await Promise.all([
    createUser("receptionist"),
    createUser("doctor"),
  ]);
  mustSucceed(
    await service.from("clinics").insert({
      id: ids.clinic,
      name: `TP ownership ${suffix}`,
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
  mustSucceed(
    await service.from("doctor_schedules").insert({
      clinic_id: ids.clinic,
      doctor_id: doctor.id,
      day_of_week: slotDay,
      start_time: "08:00:00",
      end_time: "18:00:00",
      is_enabled: true,
    }),
    "schedule",
  );
  mustSucceed(
    await service.from("patients").insert([
      {
        id: ids.requester,
        clinic_id: ids.clinic,
        full_name: "Adel Fouad",
        phone: phone(),
        date_of_birth: "1982-02-09",
        email: `${suffix}-requester@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-A1`,
        department_id: ids.department,
        created_by: receptionist.id,
      },
      {
        id: ids.otherLinked,
        clinic_id: ids.clinic,
        full_name: "Re-linked Sender",
        phone: phone(),
        date_of_birth: "1979-11-30",
        email: `${suffix}-other@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-C1`,
        department_id: ids.department,
        created_by: receptionist.id,
      },
      {
        id: ids.matchedBeneficiary,
        clinic_id: ids.clinic,
        full_name: MATCHED.fullName,
        phone: phone(),
        date_of_birth: "1996-07-21",
        email: `${suffix}-matched@example.com`,
        national_id: MATCHED.nationalId,
        file_number: `${suffix}-B1`,
        department_id: ids.department,
        created_by: receptionist.id,
      },
      {
        id: ids.unapprovedBeneficiary,
        clinic_id: ids.clinic,
        full_name: UNAPPROVED.fullName,
        phone: phone(),
        date_of_birth: "1993-03-14",
        email: `${suffix}-unapproved@example.com`,
        national_id: UNAPPROVED.nationalId,
        file_number: `${suffix}-B2`,
        department_id: ids.department,
        created_by: receptionist.id,
      },
    ]),
    "patients",
  );
}, 60_000);

afterAll(async () => {
  await service.from("ai_appointment_requests").delete().eq("clinic_id", ids.clinic);
  await service.from("appointments").delete().eq("clinic_id", ids.clinic);
  await service.from("inbound_message_attachments").delete().eq("clinic_id", ids.clinic);
  await service.from("inbound_messages").delete().eq("clinic_id", ids.clinic);
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

describe("approving a third-party intake leaves the thread with its sender", () => {
  it("books the child while the father keeps the conversation", async () => {
    const conversationId = await openConversation(ids.requester);
    const inbound = await unattributedInbound(conversationId);
    const intakeId = await stage({
      conversationId,
      fullName: "Hana Adel",
      forThirdParty: true,
    });
    const requestId = await requestSlot(conversationId, futureSlot(9));

    const approval = await approve(intakeId);
    mustSucceed(approval, "approval");
    const row = approval.data![0]!;
    expect(row.already_processed).toBe(false);

    // The beneficiary is a new file, and it is not the requester's.
    const beneficiaryId = row.patient_id!;
    expect(beneficiaryId).toBeTruthy();
    expect(beneficiaryId).not.toBe(ids.requester);

    // Beneficiary-scoped writes: the appointment and the approval record.
    expect(row.appointment_id).toBeTruthy();
    const appointment = await service
      .from("appointments")
      .select("patient_id, ai_patient_conversation_id")
      .eq("id", row.appointment_id!)
      .single();
    mustSucceed(appointment, "appointment read");
    expect(appointment.data!.patient_id).toBe(beneficiaryId);
    expect(appointment.data!.ai_patient_conversation_id).toBe(conversationId);
    expect(await requestRow(requestId)).toEqual({
      status: "linked",
      appointment_id: row.appointment_id,
    });
    expect(await intakeRow(intakeId)).toEqual({
      review_status: "approved",
      approved_patient_id: beneficiaryId,
      requested_by_patient_id: ids.requester,
      is_third_party: true,
    });

    // Requester-scoped state: untouched, to the column.
    expect(await conversationState(conversationId)).toEqual({
      patient_id: ids.requester,
      patient_link_status: "automatic",
      identity_verified_at: REQUESTER_IDENTITY.verifiedAt,
      identity_verification_failures: REQUESTER_IDENTITY.failures,
      identity_verification_locked_until: REQUESTER_IDENTITY.lockedUntil,
    });
    expect(await inboundOwners(conversationId)).toEqual({
      message: null,
      attachment: null,
    });
    expect(inbound.messageId).toBeTruthy();

    // And a repeated approval changes none of it.
    const repeated = await approve(intakeId);
    mustSucceed(repeated, "repeated approval");
    expect(repeated.data![0]).toEqual({
      patient_id: beneficiaryId,
      appointment_id: row.appointment_id,
      already_processed: true,
    });
    expect(await conversationState(conversationId)).toEqual({
      patient_id: ids.requester,
      patient_link_status: "automatic",
      identity_verified_at: REQUESTER_IDENTITY.verifiedAt,
      identity_verification_failures: REQUESTER_IDENTITY.failures,
      identity_verification_locked_until: REQUESTER_IDENTITY.lockedUntil,
    });
    expect(await inboundOwners(conversationId)).toEqual({
      message: null,
      attachment: null,
    });
    const appointments = await service
      .from("appointments")
      .select("id")
      .eq("ai_patient_conversation_id", conversationId);
    mustSucceed(appointments, "appointment count");
    expect(appointments.data).toHaveLength(1);
  });

  it("reuses an existing beneficiary file without moving the thread onto it", async () => {
    const conversationId = await openConversation(ids.requester);
    await unattributedInbound(conversationId);
    const staged = await service.rpc("stage_matched_third_party_intake", {
      p_clinic_id: ids.clinic,
      p_conversation_id: conversationId,
      p_full_name: MATCHED.fullName,
      p_national_id: MATCHED.nationalId,
      p_phone: phone(),
      p_department_id: ids.department,
      p_doctor_id: doctor.id,
    });
    mustSucceed(staged, "matched stage");
    expect(staged.data?.[0]?.status).toBe("staged_existing");
    const intakeId = staged.data![0]!.intake_id!;
    const requestId = await requestSlot(conversationId, futureSlot(10));

    const approval = await approve(intakeId);
    mustSucceed(approval, "approval");
    expect(approval.data![0]!.patient_id).toBe(ids.matchedBeneficiary);

    const appointment = await service
      .from("appointments")
      .select("patient_id")
      .eq("id", approval.data![0]!.appointment_id!)
      .single();
    mustSucceed(appointment, "appointment read");
    expect(appointment.data!.patient_id).toBe(ids.matchedBeneficiary);
    expect((await requestRow(requestId)).status).toBe("linked");
    expect(await intakeRow(intakeId)).toEqual({
      review_status: "approved",
      approved_patient_id: ids.matchedBeneficiary,
      requested_by_patient_id: ids.requester,
      is_third_party: true,
    });
    expect(await conversationState(conversationId)).toEqual({
      patient_id: ids.requester,
      patient_link_status: "automatic",
      identity_verified_at: REQUESTER_IDENTITY.verifiedAt,
      identity_verification_failures: REQUESTER_IDENTITY.failures,
      identity_verification_locked_until: REQUESTER_IDENTITY.lockedUntil,
    });
    expect(await inboundOwners(conversationId)).toEqual({
      message: null,
      attachment: null,
    });
  });

  it("approves the file but dismisses the booking when the thread was re-linked", async () => {
    // The requester recorded on the intake is no longer the patient this thread
    // belongs to, so the booking has no provenance. The file is still the
    // review's subject and is still created; the request is dismissed, and the
    // thread is left exactly as the re-link left it.
    const conversationId = await openConversation(ids.requester);
    const intakeId = await stage({
      conversationId,
      fullName: "Drifted Beneficiary",
      forThirdParty: true,
    });
    const requestId = await requestSlot(conversationId, futureSlot(11));
    mustSucceed(
      await service
        .from("conversations")
        .update({ patient_id: ids.otherLinked })
        .eq("id", conversationId),
      "re-link",
    );

    const approval = await approve(intakeId);
    mustSucceed(approval, "approval");
    const row = approval.data![0]!;
    expect(row.patient_id).toBeTruthy();
    expect(row.patient_id).not.toBe(ids.otherLinked);
    expect(row.appointment_id).toBeNull();
    expect(await requestRow(requestId)).toEqual({
      status: "dismissed",
      appointment_id: null,
    });
    expect((await conversationState(conversationId)).patient_id).toBe(ids.otherLinked);
    expect(await intakeRow(intakeId)).toMatchObject({
      approved_patient_id: row.patient_id,
      requested_by_patient_id: ids.requester,
    });
  });

  it("leaves a self-intake approval exactly as it was", async () => {
    const conversationId = await openConversation(null);
    await unattributedInbound(conversationId);
    const intakeId = await stage({ conversationId, fullName: "Stranger Himself" });
    const requestId = await requestSlot(conversationId, futureSlot(12));

    const approval = await approve(intakeId);
    mustSucceed(approval, "approval");
    const row = approval.data![0]!;
    const patientId = row.patient_id!;
    expect(row.appointment_id).toBeTruthy();

    const appointment = await service
      .from("appointments")
      .select("patient_id")
      .eq("id", row.appointment_id!)
      .single();
    mustSucceed(appointment, "appointment read");
    expect(appointment.data!.patient_id).toBe(patientId);
    expect((await requestRow(requestId)).status).toBe("linked");

    // The self path still claims the thread, the verification and the messages.
    const conversation = await conversationState(conversationId);
    expect(conversation.patient_id).toBe(patientId);
    expect(conversation.patient_link_status).toBe("manual");
    expect(conversation.identity_verified_at).not.toBeNull();
    expect(conversation.identity_verification_failures).toBe(0);
    expect(conversation.identity_verification_locked_until).toBeNull();
    expect(await inboundOwners(conversationId)).toEqual({
      message: patientId,
      attachment: patientId,
    });
    expect(await intakeRow(intakeId)).toEqual({
      review_status: "approved",
      approved_patient_id: patientId,
      requested_by_patient_id: null,
      is_third_party: false,
    });
  });

  it("lets the approved booking be rescheduled afterwards", async () => {
    // The durable clause has to keep working long after the approval
    // transaction is gone: a reschedule leaves the row `pending`, so the guard
    // runs again with no approval context anywhere.
    const conversationId = await openConversation(ids.requester);
    const intakeId = await stage({
      conversationId,
      fullName: "Reschedulable Child",
      forThirdParty: true,
    });
    await requestSlot(conversationId, futureSlot(13));
    const approval = await approve(intakeId);
    mustSucceed(approval, "approval");
    const appointmentId = approval.data![0]!.appointment_id!;
    expect(appointmentId).toBeTruthy();

    const moved = await service
      .from("appointments")
      .update({ scheduled_at: futureSlot(14).toISOString() })
      .eq("id", appointmentId)
      .select("patient_id, scheduled_at")
      .single();
    mustSucceed(moved, "reschedule");
    expect(moved.data!.patient_id).toBe(approval.data![0]!.patient_id);
    expect((await conversationState(conversationId)).patient_id).toBe(ids.requester);
    expect(await helperSays(service, conversationId, approval.data![0]!.patient_id!)).toBe(
      true,
    );
  });

  it("refuses a pending third-party intake outside the approval transaction", async () => {
    // Everything the old predicate asked for is true here: a third-party intake
    // on this thread, `pending_review`, requester = the conversation's patient,
    // and a live patient whose folded national id is the intake's. No staff has
    // approved anything, so it authorises nothing.
    const conversationId = await openConversation(ids.requester);
    const intakeId = await stageUnapproved(conversationId);
    expect(await intakeRow(intakeId)).toMatchObject({
      review_status: "pending_review",
      approved_patient_id: null,
      requested_by_patient_id: ids.requester,
      is_third_party: true,
    });

    expect(await helperSays(service, conversationId, ids.unapprovedBeneficiary)).toBe(
      false,
    );
    expect(
      await helperSays(receptionist.client, conversationId, ids.unapprovedBeneficiary),
    ).toBe(false);

    const booking = await serviceRoleBooking({
      conversationId,
      patientId: ids.unapprovedBeneficiary,
      slot: futureSlot(15),
    });
    expect(booking.error?.message).toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
    const written = await service
      .from("appointments")
      .select("id")
      .eq("ai_patient_conversation_id", conversationId);
    mustSucceed(written, "appointments after refusal");
    expect(written.data).toHaveLength(0);
  });

  it("refuses a rejected intake, which can never gain an approved beneficiary", async () => {
    const conversationId = await openConversation(ids.requester);
    const intakeId = await stageUnapproved(conversationId);
    const rejected = await receptionist.client.rpc("reject_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: receptionist.id,
      p_reason: "not this one",
    });
    mustSucceed(rejected, "rejection");
    expect((await intakeRow(intakeId)).approved_patient_id).toBeNull();

    expect(await helperSays(service, conversationId, ids.unapprovedBeneficiary)).toBe(
      false,
    );
    const booking = await serviceRoleBooking({
      conversationId,
      patientId: ids.unapprovedBeneficiary,
      slot: futureSlot(16),
    });
    expect(booking.error?.message).toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
  });

  it("does not let one thread's approval authorise another thread's booking", async () => {
    // An approved third-party intake is scoped to the conversation it was
    // staged on. A second thread of the same requester, naming the same
    // beneficiary, is a different booking and is refused.
    const approvedThread = await openConversation(ids.requester);
    const intakeId = await stageUnapproved(approvedThread);
    await requestSlot(approvedThread, futureSlot(7)); // inside the doctor's day
    mustSucceed(await approve(intakeId), "approval");
    expect(await helperSays(service, approvedThread, ids.unapprovedBeneficiary)).toBe(
      true,
    );

    const otherThread = await openConversation(ids.requester);
    expect(await helperSays(service, otherThread, ids.unapprovedBeneficiary)).toBe(false);
    const booking = await serviceRoleBooking({
      conversationId: otherThread,
      patientId: ids.unapprovedBeneficiary,
      slot: futureSlot(18),
    });
    expect(booking.error?.message).toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
  });

  it("still refuses an ordinary booking for a patient who is not the sender", async () => {
    // The rule the exemption is carved out of, unchanged: no intake, no
    // exemption. Also the self-booking shape — a linked sender booking for
    // themself — which must keep working.
    const conversationId = await openConversation(ids.requester);
    const stranger = await serviceRoleBooking({
      conversationId,
      patientId: ids.otherLinked,
      slot: futureSlot(19),
    });
    expect(stranger.error?.message).toContain(
      "AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH",
    );
    const own = await serviceRoleBooking({
      conversationId,
      patientId: ids.requester,
      slot: futureSlot(20),
    });
    mustSucceed(own, "sender booking for themself");
  });
});
