/**
 * Whose phone number is it, and whose name — proved against a live PostgreSQL.
 *
 * Two things this migration corrects are only observable by running the
 * functions, so they are run here.
 *
 * ## Phone is a contact detail
 *
 * `patients.phone` has never been unique, and families share a number: a parent
 * books for a child, a husband for a wife. Two patient records on one number are
 * two people, and the schema has always been right to permit that. Two places
 * disagreed with the schema:
 *
 *   * `approve_ai_patient_intake` counted the patients on the intake's phone
 *     and at a count of one **reused that patient's file** when the national id
 *     and date of birth agreed — with no name check — and raised otherwise.
 *     The refusal made a third-party intake impossible to approve at all,
 *     because a third-party intake only exists on a conversation whose sender
 *     is already a linked patient, so the sender's own file was always on that
 *     number.
 *   * `stage_patient_intake_from_conversation` treated a non-matching patient
 *     on the sender's number as a failed identity verification, and five of
 *     those lock the conversation for half an hour — a lockout a new patient
 *     messaging from a relative's phone could never get past.
 *
 * Both are exercised below, together with the guards that must survive: a
 * third-party intake is never *linked* by phone, and a caller who really is
 * claiming an existing patient's identity still fails verification.
 *
 * ## A name in two languages is a display name
 *
 * The bilingual pair travels intake -> review -> new patient file, and is never
 * an argument to an identity comparison. A matched existing file is never
 * silently renamed.
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
const suffix = `intake-phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "IntakePhone12345";
/** One number, shared by a family — which is the whole point of this file. */
const FAMILY_PHONE = `9055${Date.now().toString().slice(-7)}`;

const ids = {
  clinic: randomUUID(),
  department: randomUUID(),
  parent: randomUUID(),
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

/** A digit run unique to this run, so national ids never collide across runs. */
let counter = 0;
const nationalId = () => `${Date.now()}${(counter += 1)}`.slice(-11);

/**
 * An open WhatsApp conversation on a given number, reset to a known state.
 *
 * One thread per number per clinic is a real rule here
 * (`conversations_participant_legacy_unique_idx`), and it is exactly the rule
 * that makes a shared family number interesting — so these tests reuse the
 * thread rather than pretending each case gets its own. Any intake staged by a
 * previous case is cleared first: `ai_patient_intakes` references the
 * conversation `on delete restrict`, and a stale pending intake would make the
 * next `stage` call return `already_reviewed` instead of doing its work.
 */
async function openConversation(input: {
  participant: string;
  patientId?: string | null;
}) {
  const existing = await service
    .from("conversations")
    .select("id")
    .eq("clinic_id", ids.clinic)
    .eq("participant_address", input.participant)
    .maybeSingle();
  mustSucceed(existing, "find conversation");
  const fresh = {
    status: "open" as const,
    patient_id: input.patientId ?? null,
    patient_link_status: input.patientId ? "automatic" : "unlinked",
    identity_verification_failures: 0,
    identity_verification_locked_until: null,
    identity_verified_at: null,
    ai_paused_at: null,
  };
  if (existing.data) {
    mustSucceed(
      await service.from("ai_patient_intakes").delete().eq("conversation_id", existing.data.id),
      "clear intakes",
    );
    mustSucceed(
      await service.from("conversations").update(fresh).eq("id", existing.data.id),
      "reset conversation",
    );
    return existing.data.id;
  }
  const id = randomUUID();
  mustSucceed(
    await service.from("conversations").insert({
      id,
      clinic_id: ids.clinic,
      channel: "whatsapp",
      participant_address: input.participant,
      ...fresh,
    }),
    "conversation",
  );
  return id;
}

async function stage(input: {
  conversationId: string;
  fullName: string;
  nationalId: string;
  dateOfBirth: string;
  email: string;
  forThirdParty?: boolean;
  phone?: string | null;
  fullNameAr?: string | null;
  fullNameEn?: string | null;
}) {
  return service.rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: ids.clinic,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: input.nationalId,
    p_date_of_birth: input.dateOfBirth,
    p_email: input.email,
    p_department_id: ids.department,
    p_doctor_id: doctor.id,
    p_for_third_party: input.forThirdParty ?? false,
    p_phone: input.phone ?? undefined,
    p_full_name_ar: input.fullNameAr ?? undefined,
    p_full_name_en: input.fullNameEn ?? undefined,
  });
}

beforeAll(async () => {
  [admin, doctor] = await Promise.all([createUser("admin"), createUser("doctor")]);
  mustSucceed(
    await service.from("clinics").insert({ id: ids.clinic, name: `Intake ${suffix}` }),
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
  // The parent: an existing patient whose file sits on the family number.
  mustSucceed(
    await service.from("patients").insert({
      id: ids.parent,
      clinic_id: ids.clinic,
      full_name: "Mahmoud Alzanaty",
      phone: FAMILY_PHONE,
      date_of_birth: "1975-04-02",
      email: `${suffix}-parent@example.com`,
      national_id: nationalId(),
      file_number: `${suffix}-P1`,
      department_id: ids.department,
      created_by: admin.id,
    }),
    "parent patient",
  );
}, 60_000);

afterAll(async () => {
  await service.from("ai_patient_intakes").delete().eq("clinic_id", ids.clinic);
  await service.from("conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("departments").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  for (const id of userIds) await service.auth.admin.deleteUser(id);
});

async function intakeRow(intakeId: string) {
  const read = await service
    .from("ai_patient_intakes")
    .select("phone, full_name, full_name_ar, full_name_en, is_third_party, requested_by_patient_id")
    .eq("id", intakeId)
    .single();
  mustSucceed(read, "intake row");
  return read.data!;
}

async function patientRow(patientId: string) {
  const read = await service
    .from("patients")
    .select("id, full_name, full_name_ar, full_name_en, phone, national_id")
    .eq("id", patientId)
    .single();
  mustSucceed(read, "patient row");
  return read.data!;
}

describe("a third-party patient's contact phone", () => {
  it("uses the number the requester actually gave, when they gave one", async () => {
    const conversation = await openConversation({
      participant: FAMILY_PHONE,
      patientId: ids.parent,
    });
    const ownPhone = `9066${Date.now().toString().slice(-7)}`;
    const staged = await stage({
      conversationId: conversation,
      fullName: "Yara Alzanaty",
      nationalId: nationalId(),
      dateOfBirth: "2011-06-01",
      email: `${suffix}-yara@example.com`,
      forThirdParty: true,
      phone: ownPhone,
    });
    mustSucceed(staged, "stage third party with own phone");
    expect(staged.data![0].status).toBe("staged");
    const row = await intakeRow(staged.data![0].intake_id!);
    // The explicitly collected number wins outright.
    expect(row.phone).toBe(ownPhone);
    expect(row.is_third_party).toBe(true);
    expect(row.requested_by_patient_id).toBe(ids.parent);
  });

  it("falls back to the conversation's number when no separate one was given", async () => {
    const conversation = await openConversation({
      participant: FAMILY_PHONE,
      patientId: ids.parent,
    });
    const staged = await stage({
      conversationId: conversation,
      fullName: "Omar Alzanaty",
      nationalId: nationalId(),
      dateOfBirth: "2013-02-14",
      email: `${suffix}-omar@example.com`,
      forThirdParty: true,
    });
    mustSucceed(staged, "stage third party on the family number");
    expect(staged.data![0].status).toBe("staged");
    const row = await intakeRow(staged.data![0].intake_id!);
    // A parent booking for a child and giving no separate number: the parent's
    // phone is genuinely how the clinic reaches that child. A contact detail.
    expect(row.phone).toBe(FAMILY_PHONE);
  });

  it("never links a third-party intake to the patient who owns that number", async () => {
    const conversation = await openConversation({
      participant: FAMILY_PHONE,
      patientId: ids.parent,
    });
    const staged = await stage({
      conversationId: conversation,
      fullName: "Salma Alzanaty",
      nationalId: nationalId(),
      dateOfBirth: "2015-09-09",
      email: `${suffix}-salma@example.com`,
      forThirdParty: true,
    });
    mustSucceed(staged, "stage");
    // Not `linked_existing`, and not `identity_mismatch`: the phone-matching
    // block is gated on the intake being for the sender themselves, so a third
    // party is never matched, verified or linked on a number.
    expect(staged.data![0].status).toBe("staged");
    const conversationRow = await service
      .from("conversations")
      .select("patient_id, identity_verification_failures")
      .eq("id", conversation)
      .single();
    mustSucceed(conversationRow, "conversation");
    // Still the requester's own conversation, and no verification was spent.
    expect(conversationRow.data!.patient_id).toBe(ids.parent);
    expect(conversationRow.data!.identity_verification_failures).toBe(0);
  });

  it("approves a third-party intake into its own new patient file", async () => {
    const conversation = await openConversation({
      participant: FAMILY_PHONE,
      patientId: ids.parent,
    });
    const childNationalId = nationalId();
    const staged = await stage({
      conversationId: conversation,
      fullName: "Lina Alzanaty",
      nationalId: childNationalId,
      dateOfBirth: "2016-03-03",
      email: `${suffix}-lina@example.com`,
      forThirdParty: true,
      fullNameAr: "لينا الزناتي",
      fullNameEn: "Lina Alzanaty",
    });
    mustSucceed(staged, "stage");
    const intakeId = staged.data![0].intake_id!;

    const approved = await admin.client.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: admin.id,
    });
    // Before the correction this raised INTAKE_DUPLICATE_REVIEW_REQUIRED every
    // single time: the requester's own file was always on that number.
    mustSucceed(approved, "approve third party");
    const created = approved.data![0].patient_id!;
    expect(created).not.toBe(ids.parent);

    const child = await patientRow(created);
    expect(child.full_name).toBe("Lina Alzanaty");
    expect(child.national_id).toBe(childNationalId);
    // Two people, one number. Permitted, and correct.
    expect(child.phone).toBe(FAMILY_PHONE);
    const parent = await patientRow(ids.parent);
    expect(parent.phone).toBe(FAMILY_PHONE);
    expect(parent.id).not.toBe(child.id);

    // The bilingual pair travelled intake -> review -> file.
    expect(child.full_name_ar).toBe("لينا الزناتي");
    expect(child.full_name_en).toBe("Lina Alzanaty");
  });

  it("never merges two people because they share a number", async () => {
    const onThatNumber = await service
      .from("patients")
      .select("id")
      .eq("clinic_id", ids.clinic)
      .eq("phone", FAMILY_PHONE)
      .eq("is_deleted", false);
    mustSucceed(onThatNumber, "shared number");
    // The parent and at least one child, as separate files.
    expect((onThatNumber.data ?? []).length).toBeGreaterThan(1);
  });
});

describe("a new patient messaging from a relative's phone", () => {
  it("is staged as themselves rather than counted as a failed verification", async () => {
    const conversation = await openConversation({ participant: FAMILY_PHONE });
    const staged = await stage({
      conversationId: conversation,
      fullName: "Hana Alzanaty",
      nationalId: nationalId(),
      dateOfBirth: "1998-11-20",
      email: `${suffix}-hana@example.com`,
    });
    mustSucceed(staged, "stage self on a shared number");
    // Not `identity_mismatch`, and not `duplicate_ambiguous`. This clinic holds
    // no patient under her national id and nobody on the number carries her
    // name, so she is somebody else on a shared phone — which is a new patient.
    expect(staged.data![0].status).toBe("staged");
    const conversationRow = await service
      .from("conversations")
      .select("identity_verification_failures, identity_verification_locked_until")
      .eq("id", conversation)
      .single();
    mustSucceed(conversationRow, "conversation");
    expect(conversationRow.data!.identity_verification_failures).toBe(0);
    expect(conversationRow.data!.identity_verification_locked_until).toBeNull();
  });

  it("still fails verification for someone claiming the number owner's identity", async () => {
    const conversation = await openConversation({ participant: FAMILY_PHONE });
    const parent = await patientRow(ids.parent);
    const staged = await stage({
      conversationId: conversation,
      // The phone owner's own name, with a date of birth that is not theirs.
      // The anti-impersonation guard is exactly what this is for.
      fullName: parent.full_name,
      nationalId: nationalId(),
      dateOfBirth: "1990-01-01",
      email: `${suffix}-impostor@example.com`,
    });
    mustSucceed(staged, "stage impostor");
    expect(staged.data![0].status).toBe("identity_mismatch");
    expect(staged.data![0].attempts_remaining).toBeLessThan(5);
  });

  it("links the number's owner even when several files share that number", async () => {
    // By now the parent and at least one child are both on FAMILY_PHONE. The
    // deployed body answered `duplicate_ambiguous` here and would have gone on
    // answering it for ever: once a family had two files on a number, nobody on
    // it could be linked again — including the number's own owner.
    const onThatNumber = await service
      .from("patients")
      .select("id")
      .eq("clinic_id", ids.clinic)
      .eq("phone", FAMILY_PHONE)
      .eq("is_deleted", false);
    mustSucceed(onThatNumber, "shared number");
    expect((onThatNumber.data ?? []).length).toBeGreaterThan(1);

    const parent = await patientRow(ids.parent);
    const conversation = await openConversation({ participant: FAMILY_PHONE });
    const staged = await stage({
      conversationId: conversation,
      fullName: parent.full_name,
      nationalId: parent.national_id,
      dateOfBirth: "1975-04-02",
      email: `${suffix}-owner-shared@example.com`,
    });
    mustSucceed(staged, "stage the owner on a shared number");
    expect(staged.data![0].status).toBe("linked_existing");
  });

  it("does not link automatically from a number that is not the file's own", async () => {
    // Proven identity is not enough on its own to hand a sender somebody's
    // record: the conversation's verified number must be that patient's
    // registered one. Without it, a person at the clinic decides.
    const parent = await patientRow(ids.parent);
    const strangerPhone = `9033${Date.now().toString().slice(-7)}`;
    const conversation = await openConversation({ participant: strangerPhone });
    const staged = await stage({
      conversationId: conversation,
      fullName: parent.full_name,
      nationalId: parent.national_id,
      dateOfBirth: "1975-04-02",
      email: `${suffix}-elsewhere@example.com`,
    });
    mustSucceed(staged, "stage from another number");
    expect(staged.data![0].status).toBe("duplicate_review");
    const conversationRow = await service
      .from("conversations")
      .select("patient_id")
      .eq("id", conversation)
      .single();
    mustSucceed(conversationRow, "conversation");
    expect(conversationRow.data!.patient_id).toBeNull();
  });

  it("still links the number's owner to their own file when everything agrees", async () => {
    const parent = await patientRow(ids.parent);
    const conversation = await openConversation({ participant: FAMILY_PHONE });
    const staged = await stage({
      conversationId: conversation,
      fullName: parent.full_name,
      nationalId: parent.national_id,
      dateOfBirth: "1975-04-02",
      email: `${suffix}-parent-again@example.com`,
    });
    mustSucceed(staged, "stage the owner");
    // Self semantics preserved: proven identity on the conversation's own
    // verified number links the thread to the file it belongs to.
    expect(staged.data![0].status).toBe("linked_existing");
    const conversationRow = await service
      .from("conversations")
      .select("patient_id")
      .eq("id", conversation)
      .single();
    mustSucceed(conversationRow, "conversation");
    expect(conversationRow.data!.patient_id).toBe(ids.parent);
  });
});

describe("a bilingual name is a display name and never an identity", () => {
  it("carries both names onto a new self-registered patient file", async () => {
    const phone = `9077${Date.now().toString().slice(-7)}`;
    const conversation = await openConversation({ participant: phone });
    const staged = await stage({
      conversationId: conversation,
      fullName: "Ali Alzahrani",
      nationalId: nationalId(),
      dateOfBirth: "1992-07-07",
      email: `${suffix}-ali@example.com`,
      fullNameAr: "علي الزهراني",
      fullNameEn: "Ali Alzahrani",
    });
    mustSucceed(staged, "stage");
    const intakeId = staged.data![0].intake_id!;
    const intake = await intakeRow(intakeId);
    expect(intake.full_name_ar).toBe("علي الزهراني");
    expect(intake.full_name_en).toBe("Ali Alzahrani");
    // The canonical column is untouched by either.
    expect(intake.full_name).toBe("Ali Alzahrani");

    const approved = await admin.client.rpc("approve_ai_patient_intake", {
      p_intake_id: intakeId,
      p_actor_id: admin.id,
    });
    mustSucceed(approved, "approve");
    const created = await patientRow(approved.data![0].patient_id!);
    expect(created.full_name_ar).toBe("علي الزهراني");
    expect(created.full_name_en).toBe("Ali Alzahrani");
    expect(created.full_name).toBe("Ali Alzahrani");
  });

  it("does not erase a display name when a later turn re-stages without one", async () => {
    const phone = `9088${Date.now().toString().slice(-7)}`;
    const conversation = await openConversation({ participant: phone });
    const id = nationalId();
    mustSucceed(
      await stage({
        conversationId: conversation,
        fullName: "Nour Saleh",
        nationalId: id,
        dateOfBirth: "1995-05-05",
        email: `${suffix}-nour@example.com`,
        fullNameAr: "نور صالح",
      }),
      "first stage",
    );
    const restaged = await stage({
      conversationId: conversation,
      fullName: "Nour Saleh",
      nationalId: id,
      dateOfBirth: "1995-05-05",
      email: `${suffix}-nour@example.com`,
    });
    mustSucceed(restaged, "re-stage");
    const row = await intakeRow(restaged.data![0].intake_id!);
    // A turn that carries no display name must not erase one an earlier turn
    // collected.
    expect(row.full_name_ar).toBe("نور صالح");
  });

  it("does not match a patient on a display name", async () => {
    // A file whose *display* name matches what a stranger will type, and whose
    // canonical name and national id do not.
    const displayOnly = randomUUID();
    const phone = `9099${Date.now().toString().slice(-7)}`;
    mustSucceed(
      await service.from("patients").insert({
        id: displayOnly,
        clinic_id: ids.clinic,
        full_name: "Registered Canonical Name",
        full_name_ar: "زائر مجهول",
        full_name_en: "Anonymous Visitor",
        phone,
        date_of_birth: "1980-01-01",
        email: `${suffix}-display@example.com`,
        national_id: nationalId(),
        file_number: `${suffix}-P2`,
        department_id: ids.department,
        created_by: admin.id,
      }),
      "display-name patient",
    );
    const conversation = await openConversation({ participant: phone });
    const staged = await stage({
      conversationId: conversation,
      // Exactly the stored *display* name. If display names were part of
      // identity this would link or verify against that file.
      fullName: "Anonymous Visitor",
      nationalId: nationalId(),
      dateOfBirth: "2000-01-01",
      email: `${suffix}-stranger@example.com`,
    });
    mustSucceed(staged, "stage stranger");
    // Not `linked_existing`: identity folds `full_name` against an exact
    // national id, and a bilingual name is not proof of anything.
    expect(staged.data![0].status).not.toBe("linked_existing");
    const untouched = await patientRow(displayOnly);
    expect(untouched.full_name).toBe("Registered Canonical Name");
    expect(untouched.full_name_en).toBe("Anonymous Visitor");
  });
});
