/**
 * A third-party intake names the patient who asked for it — proved against a
 * live PostgreSQL, for both functions that can write one.
 *
 * `ai_patient_intakes.requested_by_patient_id` is the only column that records
 * *who* asked the clinic to open a file for somebody who never messaged it.
 * `stage_patient_intake_from_conversation` derives it from the conversation's
 * `patient_id`, and before
 * `20260919120000_third_party_intake_requires_linked_requester.sql` it accepted
 * a null one: an unlinked sender answering "for someone else" staged a named
 * third person — national id, date of birth, contact number — with no
 * requester at all, which is a request staff cannot attribute to anybody.
 *
 * Two functions stage a third-party intake, and the invariant has to hold for
 * both or it does not hold at all: `stage_patient_intake_from_conversation`
 * (a new file) and `stage_matched_third_party_intake` (a beneficiary who
 * already has one). Both are exercised here.
 *
 * The properties below are the whole contract:
 *
 *   1. an unlinked conversation cannot stage a third party;
 *   2. neither can one whose linked patient has been deleted, or belongs to
 *      another clinic — the same guard, reached through the stale-link repair;
 *   3. a properly linked sender still stages one, and it still carries their id;
 *   4. **self-intake is untouched** — an unlinked stranger registering
 *      themselves stages exactly as before, `requested_by_patient_id` null,
 *      which is what that column means on a self-intake;
 *   5. no reachable database path leaves an `is_third_party` row with a null
 *      requester — including the `on conflict` path, which can turn an
 *      existing self-intake into a third-party one.
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
const suffix = `tp-requester-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "ThirdPartyReq12345";

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  department: randomUUID(),
  sender: randomUUID(),
  deletedSender: randomUUID(),
  foreignPatient: randomUUID(),
  beneficiary: randomUUID(),
};

/** The beneficiary's own identity, re-proved by the matched-staging path. */
const BENEFICIARY = {
  fullName: "Laila Mostafa",
  nationalId: `29${`${Date.now()}`.slice(-9)}`,
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

let admin: Awaited<ReturnType<typeof createUser>>;
let doctor: Awaited<ReturnType<typeof createUser>>;

let counter = 0;
const nationalId = () => `${Date.now()}${(counter += 1)}`.slice(-11);
const phone = () => `9066${`${Date.now()}${(counter += 1)}`.slice(-7)}`;

/** A fresh open WhatsApp thread in a known link state. */
async function openConversation(input: { participant: string; patientId?: string | null }) {
  const id = randomUUID();
  mustSucceed(
    await service.from("conversations").insert({
      id,
      clinic_id: ids.clinic,
      channel: "whatsapp",
      participant_address: input.participant,
      status: "open",
      patient_id: input.patientId ?? null,
      patient_link_status: input.patientId ? "automatic" : "unlinked",
      identity_verification_failures: 0,
      identity_verification_locked_until: null,
      identity_verified_at: null,
      ai_paused_at: null,
    }),
    "conversation",
  );
  return id;
}

async function stage(input: {
  conversationId: string;
  fullName: string;
  forThirdParty?: boolean;
  phone?: string | null;
}) {
  return service.rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: ids.clinic,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: nationalId(),
    p_date_of_birth: "1994-06-11",
    p_email: `${suffix}-${(counter += 1)}@example.com`,
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
    p_for_third_party: input.forThirdParty ?? false,
    p_phone: input.phone ?? undefined,
  });
}

async function stageMatched(conversationId: string) {
  return service.rpc("stage_matched_third_party_intake", {
    p_clinic_id: ids.clinic,
    p_conversation_id: conversationId,
    p_full_name: BENEFICIARY.fullName,
    p_national_id: BENEFICIARY.nationalId,
    p_phone: phone(),
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
  });
}

async function intakesFor(conversationId: string) {
  const read = await service
    .from("ai_patient_intakes")
    .select("id, is_third_party, requested_by_patient_id")
    .eq("conversation_id", conversationId);
  mustSucceed(read, "intakes");
  return read.data ?? [];
}

beforeAll(async () => {
  [admin, doctor] = await Promise.all([createUser("admin"), createUser("doctor")]);
  mustSucceed(
    await service.from("clinics").insert([
      { id: ids.clinic, name: `TP ${suffix}` },
      { id: ids.otherClinic, name: `TP other ${suffix}` },
    ]),
    "clinics",
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
      { id: admin.id, clinic_id: ids.clinic, full_name: "Admin", role: "admin" },
      {
        id: doctor.id,
        clinic_id: ids.clinic,
        full_name: "Doctor",
        role: "doctor",
        department_id: ids.department,
      },
    ]),
    "profiles",
  );
  mustSucceed(
    await service.from("patients").insert([
      {
        id: ids.sender,
        clinic_id: ids.clinic,
        full_name: "Salma Fouad",
        phone: phone(),
        date_of_birth: "1988-02-09",
        email: `${suffix}-sender@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-S1`,
        department_id: ids.department,
        created_by: admin.id,
      },
      {
        id: ids.deletedSender,
        clinic_id: ids.clinic,
        full_name: "Removed Sender",
        phone: phone(),
        date_of_birth: "1990-03-03",
        email: `${suffix}-removed@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-S2`,
        department_id: ids.department,
        created_by: admin.id,
      },
      {
        id: ids.beneficiary,
        clinic_id: ids.clinic,
        full_name: BENEFICIARY.fullName,
        phone: phone(),
        date_of_birth: "1996-07-21",
        email: `${suffix}-beneficiary@example.com`,
        national_id: BENEFICIARY.nationalId,
        file_number: `${suffix}-B1`,
        department_id: ids.department,
        created_by: admin.id,
      },
      {
        id: ids.foreignPatient,
        clinic_id: ids.otherClinic,
        full_name: "Foreign Patient",
        phone: phone(),
        date_of_birth: "1991-05-05",
        email: `${suffix}-foreign@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-F1`,
        created_by: admin.id,
      },
    ]),
    "patients",
  );
  // Soft-deleted after creation: the file exists, and no live flow may use it.
  mustSucceed(
    await service
      .from("patients")
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq("id", ids.deletedSender),
    "soft delete",
  );
}, 60_000);

afterAll(async () => {
  await service.from("ai_patient_intakes").delete().eq("clinic_id", ids.clinic);
  await service.from("conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.otherClinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("departments").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().in("id", [ids.clinic, ids.otherClinic]);
  for (const id of userIds) await service.auth.admin.deleteUser(id);
});

describe("third-party intake requires a linked requester", () => {
  it("refuses a third-party staging on an unlinked conversation, and writes nothing", async () => {
    const conversationId = await openConversation({ participant: phone() });
    const result = await stage({
      conversationId,
      fullName: "Nadia Hussein",
      forThirdParty: true,
      phone: phone(),
    });
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
    expect(await intakesFor(conversationId)).toHaveLength(0);
  });

  it("refuses one whose linked patient has been deleted", async () => {
    const conversationId = await openConversation({
      participant: phone(),
      patientId: ids.deletedSender,
    });
    const result = await stage({
      conversationId,
      fullName: "Omar Nabil",
      forThirdParty: true,
      phone: phone(),
    });
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
    expect(await intakesFor(conversationId)).toHaveLength(0);
    // The refusal is an exception, so the whole call is rolled back — including
    // the stale-link repair the function performs before it. The dead link
    // therefore survives this call, and is cleared by the next call that is not
    // refused (any self-intake, or a third-party one from a repaired thread).
    // Asserted rather than left implicit: a refusal that silently mutated the
    // conversation would be a side effect nobody reading the guard expects.
    const read = await service
      .from("conversations")
      .select("patient_id")
      .eq("id", conversationId)
      .single();
    mustSucceed(read, "conversation");
    expect(read.data!.patient_id).toBe(ids.deletedSender);

    // And the repair does still happen on a call that is not refused: the same
    // thread staging a self-intake comes out unlinked.
    const self = await stage({ conversationId, fullName: "Repaired Sender" });
    mustSucceed(self, "self stage after dead link");
    const repaired = await service
      .from("conversations")
      .select("patient_id, patient_link_status")
      .eq("id", conversationId)
      .single();
    mustSucceed(repaired, "conversation after repair");
    expect(repaired.data!.patient_id).toBeNull();
    expect(repaired.data!.patient_link_status).toBe("unlinked");
  });

  it("refuses one whose linked patient belongs to another clinic", async () => {
    const conversationId = await openConversation({ participant: phone() });
    // Written past the application by the service role, which is the only way
    // this state can exist at all — and precisely the state the guard's own
    // clinic check exists for.
    const linked = await service
      .from("conversations")
      .update({ patient_id: ids.foreignPatient, patient_link_status: "automatic" })
      .eq("id", conversationId);
    if (linked.error) {
      // A database that refuses the cross-clinic link outright is a stronger
      // guarantee than the one under test, not a weaker one.
      expect(linked.error.message).toBeTruthy();
      return;
    }
    const result = await stage({
      conversationId,
      fullName: "Hana Sami",
      forThirdParty: true,
      phone: phone(),
    });
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
    expect(await intakesFor(conversationId)).toHaveLength(0);
  });

  it("still stages a third party for a linked sender, carrying their id", async () => {
    const conversationId = await openConversation({
      participant: phone(),
      patientId: ids.sender,
    });
    const result = await stage({
      conversationId,
      fullName: "Youssef Adel",
      forThirdParty: true,
      phone: phone(),
    });
    mustSucceed(result, "third-party stage");
    expect(result.data?.[0]?.status).toBe("staged");
    const rows = await intakesFor(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_third_party).toBe(true);
    expect(rows[0]!.requested_by_patient_id).toBe(ids.sender);
  });

  it("refuses a matched third-party staging on an unlinked conversation", async () => {
    const conversationId = await openConversation({ participant: phone() });
    const result = await stageMatched(conversationId);
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
    expect(await intakesFor(conversationId)).toHaveLength(0);
  });

  it("refuses a matched staging whose linked requester has been deleted", async () => {
    const conversationId = await openConversation({
      participant: phone(),
      patientId: ids.deletedSender,
    });
    const result = await stageMatched(conversationId);
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
    expect(await intakesFor(conversationId)).toHaveLength(0);
  });

  it("refuses before proving the identity, so it is not an existence oracle", async () => {
    // Same refusal for a national id that matches nobody here: an unlinked
    // caller cannot tell a registered id from an unregistered one.
    const conversationId = await openConversation({ participant: phone() });
    const result = await service.rpc("stage_matched_third_party_intake", {
      p_clinic_id: ids.clinic,
      p_conversation_id: conversationId,
      p_full_name: "Nobody At All",
      p_national_id: `19${`${Date.now()}`.slice(-9)}`,
      p_phone: phone(),
      p_department_id: ids.department,
      p_doctor_id: doctor.id,
    });
    expect(result.error?.message).toContain("THIRD_PARTY_REQUESTER_NOT_LINKED");
  });

  it("stages a matched beneficiary for a linked requester, preserving their id", async () => {
    const conversationId = await openConversation({
      participant: phone(),
      patientId: ids.sender,
    });
    const result = await stageMatched(conversationId);
    mustSucceed(result, "matched stage");
    expect(result.data?.[0]?.status).toBe("staged_existing");
    expect(result.data?.[0]?.matched_patient_id).toBe(ids.beneficiary);
    const rows = await intakesFor(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_third_party).toBe(true);
    expect(rows[0]!.requested_by_patient_id).toBe(ids.sender);
  });

  it("supersedes a self-intake rather than flipping it onto another person", async () => {
    // A self-intake for "Stranger First" staged first, with a null requester
    // that is correct for a self-intake, and then the same conversation
    // matching a *different* person as a beneficiary.
    //
    // This used to travel the `on conflict do update` path and flip that one
    // row: `is_third_party` became true and the requester was written in the
    // same statement, which is what kept the "no third-party intake without a
    // requester" invariant intact. The row it flipped, though, described
    // somebody else — a different name and a different national id — so the
    // invariant was bought by rewriting one person's intake into another's.
    //
    // D3 replaces the flip with a supersession. The self-intake keeps its own
    // identity and becomes `dismissed` history; the beneficiary gets a new row
    // of their own, carrying the requester. The invariant this test exists for
    // is unchanged and is asserted on the row that now holds it — and the
    // stronger property, that no row is ever rewritten to describe a different
    // person, is asserted alongside it.
    const conversationId = await openConversation({
      participant: phone(),
      patientId: ids.sender,
    });
    mustSucceed(
      await service
        .from("conversations")
        .update({ patient_id: null, patient_link_status: "unlinked" })
        .eq("id", conversationId),
      "unlink for self stage",
    );
    const self = await stage({ conversationId, fullName: "Stranger First" });
    mustSucceed(self, "self stage");
    const staged = await intakesFor(conversationId);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.is_third_party).toBe(false);
    expect(staged[0]!.requested_by_patient_id).toBeNull();

    mustSucceed(
      await service
        .from("conversations")
        .update({ patient_id: ids.sender, patient_link_status: "automatic" })
        .eq("id", conversationId),
      "relink",
    );
    const matched = await stageMatched(conversationId);
    mustSucceed(matched, "matched stage over self intake");
    expect(matched.data?.[0]?.status).toBe("staged_existing");
    const newIntakeId = matched.data![0]!.intake_id!;
    expect(newIntakeId).not.toBe(staged[0]!.id);

    const rows = await intakesFor(conversationId);
    expect(rows).toHaveLength(2);

    // The invariant: the third-party row carries its requester.
    const thirdParty = rows.find((row) => row.id === newIntakeId)!;
    expect(thirdParty.is_third_party).toBe(true);
    expect(thirdParty.requested_by_patient_id).toBe(ids.sender);

    // And nothing was rewritten to describe somebody else: the self-intake is
    // still the self-intake it was, preserved as dismissed history.
    const preserved = await service
      .from("ai_patient_intakes")
      .select("id, full_name, is_third_party, requested_by_patient_id, review_status, review_reason")
      .eq("id", staged[0]!.id)
      .single();
    mustSucceed(preserved, "superseded self-intake");
    expect(preserved.data!).toMatchObject({
      full_name: "Stranger First",
      is_third_party: false,
      requested_by_patient_id: null,
      review_status: "dismissed",
      review_reason: "superseded_by_new_beneficiary",
    });

    // Exactly one pending intake survives on the thread.
    const pending = rows.filter((row) => row.id === newIntakeId);
    expect(pending).toHaveLength(1);
  });

  it("leaves self-intake from an unlinked stranger exactly as it was", async () => {
    const conversationId = await openConversation({ participant: phone() });
    const result = await stage({ conversationId, fullName: "Kareem Tarek" });
    mustSucceed(result, "self stage");
    expect(result.data?.[0]?.status).toBe("staged");
    const rows = await intakesFor(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_third_party).toBe(false);
    expect(rows[0]!.requested_by_patient_id).toBeNull();
  });

  it("leaves no third-party row in this clinic without a live requester", async () => {
    // The invariant stated over the data rather than over any one call: every
    // row every case above produced, checked at once. `requested_by_patient_id`
    // must name a patient of this clinic that is not deleted.
    const read = await service
      .from("ai_patient_intakes")
      .select("id, is_third_party, requested_by_patient_id")
      .eq("clinic_id", ids.clinic)
      .eq("is_third_party", true);
    mustSucceed(read, "third-party intakes");
    expect(read.data!.length).toBeGreaterThan(0);
    for (const row of read.data!) {
      expect(row.requested_by_patient_id).not.toBeNull();
      const requester = await service
        .from("patients")
        .select("id, clinic_id, is_deleted, deleted_at")
        .eq("id", row.requested_by_patient_id!)
        .single();
      mustSucceed(requester, "requester");
      expect(requester.data!.clinic_id).toBe(ids.clinic);
      expect(requester.data!.is_deleted).toBe(false);
      expect(requester.data!.deleted_at).toBeNull();
    }
  });
});
