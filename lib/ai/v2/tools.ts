/**
 * The authoritative tool layer, with preconditions the model cannot influence.
 *
 * ## What changed and what did not
 *
 * Every function here delegates to logic that already existed and is already
 * correct: `getPatientAvailableDays`, `createPatientPendingBooking`,
 * `findClinicPatientByIdentity`, `stagePatientIntakeFromConversation`,
 * `loadDoctorDirectory` and the rest. The domain has not been rewritten and
 * neither have the RPCs behind it. Their ownership checks, identity checks,
 * RLS and audit lines are untouched.
 *
 * What is new is **who may call them and when**. In the old engine these were
 * `tool()` objects mounted into a model's context; the model chose one and the
 * choice was the mutation. Here they are plain functions invoked by a flow step
 * that the deterministic engine has already decided to run, after the engine
 * has already checked the step's declared preconditions against committed slots
 * and proven identity (I-4, I-7).
 *
 * ## The precondition contract
 *
 * Preconditions live on the *step* ({@link StepPrecondition}), not in here, so
 * they are data the engine enforces uniformly rather than a check each function
 * remembers to perform. This file's job is to be a faithful, side-effect-honest
 * adapter: a `read*` function never writes, and the two functions that do write
 * say so in their names and are reachable from exactly one step each.
 *
 * `list_available_days` is the worked example from the brief. It is reachable
 * only from `book_appointment`'s day step, whose precondition is
 * `slots: ["department", "doctor"]` — committed slots on a live frame. A doctor
 * sitting in the patient's appointment history satisfies neither, and there is
 * no other caller.
 */

import "server-only";

import { formatInTimeZone } from "date-fns-tz";
import { addCalendarDays } from "@/lib/appointments/calendar";
import {
  availableDoctorsInDepartment,
  loadClinicDepartments,
  loadDoctorDirectory,
  resolveDoctorName,
  type DirectoryDoctor,
} from "@/lib/ai/doctor-directory";
import {
  getPatientAvailableDays,
  getPatientAvailableSlots,
  createPatientPendingBooking,
} from "@/lib/booking/patient";
import {
  authorizePatientConversation,
  type ResolvedPatientAiContext,
} from "@/lib/ai/patient-authorization";
import {
  cancelPatientAiAppointment,
  createPatientPreliminaryBookingWithPackage,
  findClinicPatientByIdentity,
  listClinicPublicPackages,
  listPatientAiDocuments,
  listPatientAiPackages,
  signClinicDocumentUrl,
  getPatientClinicPublicInfo,
  createClinicScopedAdminClient,
  listPatientAiAppointments,
  preparePatientAiReschedule,
  reschedulePatientAiAppointment,
  searchPatientClinicFaq,
  stagePatientIntakeFromConversation,
} from "@/lib/supabase/admin";
import { discoveryFromRelationships } from "@/lib/ai/existing-patient-discovery";
import type { Candidate } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";

/** How many days of calendar one availability read covers. Unchanged from P9B. */
const AVAILABILITY_WINDOW_DAYS = 7;

/**
 * The legacy identity resolver, reused verbatim.
 *
 * Every read below needs the same thing the old tools needed — the clinic, the
 * timezone, the linkage — and `authorizePatientConversation` is the one place
 * that resolves it from the conversation rather than from an argument. Reusing
 * it keeps a single answer to "who is this thread?" across both engines.
 */
async function identityFor(context: TurnContext): Promise<ResolvedPatientAiContext> {
  return authorizePatientConversation({
    clinicId: context.clinicId,
    conversationId: context.conversationId,
    locale: context.turn.locale,
  });
}

// ---------------------------------------------------------------------------
// Clinic-public reads. No identity, no patient, no flow requirement.
// ---------------------------------------------------------------------------

export async function readDepartments(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  const departments = await loadClinicDepartments(context.clinicId);
  return departments.map((department) => ({
    value: department.id,
    label: department.name,
    source: "clinic_directory" as const,
  }));
}

export async function readDoctors(input: {
  context: TurnContext;
  departmentId: string;
  /** Values the patient has ruled out. The negative constraint, applied. */
  excluding?: readonly string[];
}): Promise<readonly Candidate<string>[]> {
  const directory = await loadDoctorDirectory(input.context.clinicId);
  const excluded = new Set(input.excluding ?? []);
  return availableDoctorsInDepartment(directory, input.departmentId)
    .filter((doctor) => !excluded.has(doctor.id))
    .map((doctor) => ({
      value: doctor.id,
      label: doctor.name,
      source: "clinic_directory" as const,
    }));
}

/**
 * Grounds a spoken doctor name against the roster.
 *
 * Delegates to `resolveDoctorName`, the existing resolver, so "دكتور احم"
 * produces the same two-candidate ambiguity it always did — but the *answer* to
 * that ambiguity is now a server-owned offer rather than the model's judgement.
 */
export async function resolveDoctorSpoken(input: {
  context: TurnContext;
  spoken: string;
  departmentId: string | null;
  excluding?: readonly string[];
}): Promise<
  | { kind: "resolved"; value: string; label: string }
  | { kind: "ambiguous"; options: readonly { value: string; label: string; source: "clinic_directory" }[] }
  | { kind: "unresolved" }
> {
  const directory = await loadDoctorDirectory(input.context.clinicId);
  const excluded = new Set(input.excluding ?? []);
  const resolution = resolveDoctorName(
    input.spoken,
    directory,
    input.departmentId,
  );
  if (resolution.status === "resolved" && !excluded.has(resolution.doctor.id)) {
    return {
      kind: "resolved",
      value: resolution.doctor.id,
      label: resolution.doctor.name,
    };
  }
  if (resolution.status === "ambiguous") {
    const options = resolution.candidates
      .filter((doctor: DirectoryDoctor) => !excluded.has(doctor.id))
      .map((doctor: DirectoryDoctor) => ({
        value: doctor.id,
        label: doctor.name,
        source: "clinic_directory" as const,
      }));
    if (options.length === 1) {
      return { kind: "resolved", value: options[0]!.value, label: options[0]!.label };
    }
    if (options.length === 0) return { kind: "unresolved" };
    return { kind: "ambiguous", options };
  }
  return { kind: "unresolved" };
}

export async function readClinicInfo(context: TurnContext) {
  const result = await getPatientClinicPublicInfo(context.clinicId);
  return result.data;
}

export async function readClinicFaq(input: {
  context: TurnContext;
  question: string;
}) {
  const result = await searchPatientClinicFaq({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    question: input.question,
    language: input.context.turn.locale,
  });
  return result.error ? [] : (result.data ?? []);
}

/**
 * The clinic's package offering, as a stranger may ask about it.
 *
 * Takes no patient and returns none. A member of the public asking "what
 * packages do you have?" is answered from `package_templates`, which is clinic
 * configuration, and there is no branch here that can reach a patient's own
 * packages — that is a different function with a different precondition.
 */
export async function readPublicPackages(input: {
  context: TurnContext;
  departmentId?: string | null;
}): Promise<
  readonly {
    id: string;
    name: string;
    departmentName: string;
    totalSessions: number;
    pricePerSession: number | null;
    totalPrice: number | null;
  }[]
> {
  const result = await listClinicPublicPackages({
    clinicId: input.context.clinicId,
    departmentId: input.departmentId ?? null,
  });
  if (result.error || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[]).map((row) => ({
    id: String(row.template_id),
    name: String(row.name),
    departmentName: String(row.department_name ?? ""),
    totalSessions: Number(row.total_sessions ?? 0),
    pricePerSession:
      row.price_per_session === null ? null : Number(row.price_per_session),
    totalPrice: row.total_price === null ? null : Number(row.total_price),
  }));
}

// ---------------------------------------------------------------------------
// Patient-scoped reads. Reachable only from a step declaring `verified`.
// ---------------------------------------------------------------------------

/**
 * This patient's usable packages.
 *
 * The RPC resolves the patient from the *conversation's* linkage and ignores
 * any id a caller might pass, so there is no argument by which one patient's
 * packages could be read for another. An unlinked thread gets an empty list
 * rather than an error, because an error is itself a disclosure.
 *
 * Returns {@link Candidate}s. A package the patient owns is something the flow
 * may **offer**; it never becomes a decision without an `affirm_offer` (I-5),
 * and a session is never decremented by this read.
 */
export async function readPatientPackages(input: {
  context: TurnContext;
  departmentId?: string | null;
  serviceId?: string | null;
}): Promise<readonly Candidate<string>[]> {
  const result = await listPatientAiPackages({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    departmentId: input.departmentId ?? null,
    serviceId: input.serviceId ?? null,
  });
  if (result.error || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[]).map((row) => ({
    value: String(row.package_id),
    label: `${String(row.name)} · ${Number(row.remaining_sessions ?? 0)}`,
    source: "patient_packages" as const,
  }));
}

/**
 * Documents already issued to this patient.
 *
 * **Retrieval only.** The RPC selects `status = 'issued'` with a non-null
 * `issued_by`, so every row it can return was finalized by an authorized person
 * through the existing document workflow. There is no function in this file
 * that creates, finalizes or alters a document, and the assistant has no other
 * path to the `documents` table — a patient asking to be *issued* something new
 * is a handoff, not a tool call.
 */
export async function readPatientDocuments(input: {
  context: TurnContext;
  docType?: string | null;
}): Promise<readonly Candidate<string>[]> {
  const result = await listPatientAiDocuments({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    docType: input.docType ?? null,
    limit: 10,
  });
  if (result.error || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[]).map((row) => ({
    value: String(row.document_id),
    label: `${String(row.doc_type)} ${String(row.document_number)}`,
    source: "patient_documents" as const,
  }));
}

/**
 * A short-lived link to one issued document the patient owns.
 *
 * Re-reads the patient's own document list and matches by id rather than
 * trusting the id it was handed, so a stale or tampered reference selects
 * nothing. The signed URL is minted from the storage path the RPC returned and
 * expires quickly; the bytes never pass through the model.
 */
export async function readDocumentLink(input: {
  context: TurnContext;
  documentId: string;
}): Promise<{ url: string; label: string } | null> {
  const result = await listPatientAiDocuments({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    docType: null,
    limit: 25,
  });
  if (result.error || !Array.isArray(result.data)) return null;
  const row = (result.data as Record<string, unknown>[]).find(
    (entry) => String(entry.document_id) === input.documentId,
  );
  if (!row || typeof row.pdf_storage_path !== "string") return null;
  const signed = await signClinicDocumentUrl({
    storagePath: row.pdf_storage_path,
  });
  if (signed.error || !signed.data?.signedUrl) return null;
  return {
    url: signed.data.signedUrl,
    label: `${String(row.doc_type)} ${String(row.document_number)}`,
  };
}

export async function readMyAppointments(context: TurnContext) {
  const result = await listPatientAiAppointments({
    clinicId: context.clinicId,
    conversationId: context.conversationId,
  });
  return result.error ? [] : ((result.data ?? []) as Record<string, unknown>[]);
}

/**
 * The doctors this patient has actually been treated by here.
 *
 * The one durable read that names a doctor, and the reason it returns
 * {@link Candidate}s rather than values. This is what `prepare_booking` used to
 * do before writing the answer straight into conversation state; here the
 * return type makes that write unrepresentable.
 */
export async function readTreatingDoctors(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  if (context.identity === "anonymous" || !context.patientId) return [];
  const [patient, directory] = await Promise.all([
    readPatientCareRow(context),
    loadDoctorDirectory(context.clinicId),
  ]);
  const doctorId = patient?.assigned_doctor_id;
  if (!doctorId) return [];
  const doctor = directory.doctors.find(
    (entry) => entry.id === doctorId && entry.state === "available",
  );
  // A doctor who has left or is on leave is not offerable. "Shall we book you
  // with your usual doctor?" is not a question worth asking about somebody who
  // cannot be booked — the same rule `existing-patient-discovery` applies.
  if (!doctor) return [];
  return [{ value: doctor.id, label: doctor.name, source: "patient_history" }];
}

/**
 * The patient's own care row — the assigned doctor and the department they sit
 * in. One read, shared by the two durable facts derived from it.
 */
async function readPatientCareRow(
  context: TurnContext,
): Promise<{ assigned_doctor_id: string | null; department_id: string | null } | null> {
  if (context.identity === "anonymous" || !context.patientId) return null;
  const result = await createClinicScopedAdminClient(context.clinicId)
    .from("patients")
    .select("assigned_doctor_id, department_id")
    .eq("id", context.patientId)
    .maybeSingle();
  return (
    (result.data as { assigned_doctor_id: string | null; department_id: string | null } | null) ??
    null
  );
}

/**
 * The departments this patient is actually known in.
 *
 * Matched on the patient's own `department_id` against the clinic directory.
 * The predicate this replaces — `doctors.some(d => d.label.length > 0 && …)` —
 * never referenced the department at all, so it was true for every row the
 * moment the patient had any treating doctor: the booking step's "known first"
 * ordering was a no-op and `previously_seen` was asserted about departments
 * nobody had ever attended.
 *
 * Returns {@link Candidate}s like every other durable fact: known-in is a
 * suggestion to order a list by, never a selection (I-5).
 */
export async function readKnownDepartments(
  context: TurnContext,
): Promise<readonly Candidate<string>[]> {
  const patient = await readPatientCareRow(context);
  const departmentId = patient?.department_id;
  if (!departmentId) return [];
  const departments = await readDepartments(context);
  return departments
    .filter((department) => department.value === departmentId)
    .map((department) => ({ ...department, source: "patient_history" as const }));
}

// ---------------------------------------------------------------------------
// Availability. The worked precondition example.
// ---------------------------------------------------------------------------

/**
 * Days with at least one bookable slot for a committed doctor.
 *
 * Reachable from exactly one step — `book_appointment`'s day step — whose
 * declared precondition is `slots: ["department", "doctor"]`. The engine checks
 * that against the frame's own committed slots before this runs, so:
 *
 *   * with no active booking frame it cannot run at all;
 *   * with a parked frame it cannot run, because a parked frame is not active;
 *   * with a doctor known only from the patient's history it cannot run,
 *     because durable memory does not produce a committed slot (I-5, I-7).
 *
 * That is the precondition from the brief, enforced by the engine rather than
 * restated here — which is the point: a check inside the tool would be one more
 * thing a future caller could route around.
 */
export async function readAvailableDays(input: {
  context: TurnContext;
  doctorId: string;
  serviceId?: string | null;
  /** A lower bound the patient set — "بعد يوم ٩". A bound, not a choice. */
  after?: string | null;
  durationMinutes?: number;
}): Promise<
  | { ok: true; days: readonly Candidate<string>[]; windowStart: string; windowEnd: string }
  | { ok: false; reason: string }
> {
  const identity = await identityFor(input.context);
  const today = formatInTimeZone(
    input.context.now,
    identity.clinicTimezone,
    "yyyy-MM-dd",
  );
  const windowStart =
    input.after && input.after >= today ? addCalendarDays(input.after, 1) : today;
  const windowEnd = addCalendarDays(windowStart, AVAILABILITY_WINDOW_DAYS - 1);
  const result = await getPatientAvailableDays({
    identity,
    doctorId: input.doctorId,
    durationMinutes: input.durationMinutes ?? 30,
    searchDays: AVAILABILITY_WINDOW_DAYS,
    startDate: windowStart,
    serviceId: input.serviceId ?? null,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    windowStart,
    windowEnd,
    days: result.availableDays.map((day) => ({
      value: day.date,
      label: day.date,
      source: "clinic_directory" as const,
    })),
  };
}

export async function readAvailableSlots(input: {
  context: TurnContext;
  doctorId: string;
  date: string;
  serviceId?: string | null;
  durationMinutes?: number;
}): Promise<
  { ok: true; times: readonly Candidate<string>[] } | { ok: false; reason: string }
> {
  const identity = await identityFor(input.context);
  const result = await getPatientAvailableSlots({
    identity,
    date: input.date,
    doctorId: input.doctorId,
    serviceId: input.serviceId ?? null,
    durationMinutes: input.durationMinutes ?? 30,
    now: input.context.now,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    times: result.availableSlots.map((slot: string) => ({
      value: slot,
      label: slot,
      source: "clinic_directory" as const,
    })),
  };
}

// ---------------------------------------------------------------------------
// Identity — one implementation, used by every flow that needs it
// ---------------------------------------------------------------------------

export type IdentityResolution =
  /** No file here proves this identity. Registration is the next move. */
  | { kind: "none" }
  /** Exactly one file, and the submitted name is a plausible rendering of it. */
  | {
      kind: "matched";
      patientId: string;
      canonicalName: string;
      departments: readonly { id: string; name: string }[];
      treatingDoctorByDepartment: Record<string, { id: string; name: string }>;
    }
  /** Several clinical homes. Which one is a question, never a guess. */
  | {
      kind: "ambiguous_department";
      patientId: string;
      canonicalName: string;
      departments: readonly { id: string; name: string }[];
    };

/**
 * The single identity implementation (the brief's "centralized, not
 * reimplemented per flow").
 *
 * Delegates the *rule* to `find_clinic_patient_by_identity`, which already
 * implements it correctly and in the right place: exact folded national/civil
 * id within one clinic, confirmed by an exactly folded name, ambiguity failing
 * closed. Nothing about that rule is reimplemented here, and nothing here can
 * match anybody — it is handed rows the database has already decided are one
 * specific person.
 *
 * The anti-existence-oracle property is preserved by construction: this
 * function is only ever called with an id **the patient themselves supplied**,
 * and every non-match returns the same `none` regardless of whether some other
 * person's record exists. A caller cannot distinguish "no such id" from "that
 * id belongs to somebody whose name you got wrong", because both are `none`.
 */
export async function resolveIdentity(input: {
  context: TurnContext;
  nationalId: string;
  fullName: string;
}): Promise<IdentityResolution> {
  const result = await findClinicPatientByIdentity({
    clinicId: input.context.clinicId,
    nationalId: input.nationalId,
    fullName: input.fullName,
  });
  if (result.error) return { kind: "none" };
  const discovery = discoveryFromRelationships(
    (result.data ?? []) as Parameters<typeof discoveryFromRelationships>[0],
  );
  if (discovery.kind === "none") return { kind: "none" };
  if (discovery.kind === "single_department") {
    return {
      kind: "matched",
      patientId: discovery.patientId,
      canonicalName: discovery.patientName,
      departments: [discovery.department],
      treatingDoctorByDepartment: discovery.treatingDoctor
        ? { [discovery.department.id]: discovery.treatingDoctor }
        : {},
    };
  }
  return {
    kind: "ambiguous_department",
    patientId: discovery.patientId,
    canonicalName: discovery.patientName,
    departments: discovery.departments,
  };
}

// ---------------------------------------------------------------------------
// Writes. Two of them, each reachable from exactly one step.
// ---------------------------------------------------------------------------

/**
 * Stages a new patient file for staff review. Never creates one outright.
 *
 * The existing RPC, unchanged, including its own identity checks and its
 * refusal to stage a record it cannot validate. The V2 step that calls it has
 * `identity: "none"` — a stranger must be able to register — but has every
 * intake slot in its precondition list, so it cannot run on a partial file.
 */
export async function stageIntake(input: {
  context: TurnContext;
  fullName: string;
  nationalId: string;
  dateOfBirth: string;
  email: string;
  /**
   * The booking this file is being opened for.
   *
   * Required by the RPC, and correctly so: a staged intake exists to be
   * reviewed alongside a request, and a file with no clinical destination is
   * not something staff can act on. The step that calls this therefore
   * declares both in its precondition, which is why it can never run before a
   * department and doctor are committed.
   */
  departmentId: string;
  doctorId: string;
  forThirdParty?: boolean;
  phone?: string | null;
  bloodType?: string | null;
  /**
   * The name exactly as the patient typed it, when `fullName` is a Latin
   * rendering of it. Kept beside the transliteration, never instead of it —
   * the existing P10 behaviour, unchanged.
   */
  fullNameOriginal?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await stagePatientIntakeFromConversation({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    fullName: input.fullName,
    nationalId: input.nationalId,
    dateOfBirth: input.dateOfBirth,
    email: input.email,
    departmentId: input.departmentId,
    doctorId: input.doctorId,
    forThirdParty: input.forThirdParty === true,
    phone: input.phone ?? null,
    bloodType: input.bloodType ?? null,
    fullNameOriginal: input.fullNameOriginal ?? null,
  });
  return result.error
    ? { ok: false, reason: String((result.error as { code?: string }).code ?? "failed") }
    : { ok: true };
}

/**
 * Creates the pending booking, optionally consuming a package session.
 *
 * Reachable from one step, and only once that step has read
 * `frame.memo.confirmed === true` — which is written by `affirm_offer` on a
 * `summary` offer and by nothing else. A model cannot set it, because a model
 * emits commands and this memo is written by the engine's own handler.
 *
 * **Package safety.** A session is consumed only when
 * `frame.memo.package_accepted === true`, which likewise comes from an
 * `affirm_offer` on a `package_use` offer. The decrement itself happens inside
 * `create_patient_preliminary_booking_v2`, in the same transaction as the
 * insert and under a row lock on the package, so:
 *
 *   * a failed booking rolls the decrement back with it;
 *   * two racing turns cannot both claim the same session;
 *   * a retried webhook cannot double-consume, because the pending-booking
 *     uniqueness refuses the second insert and the decrement rolls back.
 *
 * Nothing about "the model inferred a package applies" can reach it.
 */
export async function commitBooking(input: {
  context: TurnContext;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
  packageId?: string | null;
}): Promise<
  | { ok: true; appointmentId: string; packageSessionNumber: number | null }
  | { ok: false; reason: string }
> {
  const identity = await identityFor(input.context);
  if (!input.packageId) {
    // No package: the existing path, byte for byte. Every slot, notice and
    // ownership check it has always performed still applies.
    const result = await createPatientPendingBooking({
      identity,
      doctorId: input.doctorId,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      serviceId: input.serviceId ?? null,
      now: input.context.now,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      appointmentId: String(
        (result as unknown as { appointmentId?: string }).appointmentId ?? "",
      ),
      packageSessionNumber: null,
    };
  }
  const result = await createPatientPreliminaryBookingWithPackage({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    doctorId: input.doctorId,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    serviceId: input.serviceId ?? null,
    packageId: input.packageId,
  });
  if (result.error) {
    return { ok: false, reason: String(result.error.message ?? "booking_failed") };
  }
  const row = Array.isArray(result.data)
    ? (result.data[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!row?.appointment_id) return { ok: false, reason: "booking_failed" };
  return {
    ok: true,
    appointmentId: String(row.appointment_id),
    packageSessionNumber:
      row.package_session_number === null || row.package_session_number === undefined
        ? null
        : Number(row.package_session_number),
  };
}

/**
 * Cancels one of the patient's own appointments.
 *
 * `cancel_patient_ai_appointment` returns `(cancelled boolean, reason text)`,
 * so the absence of a transport error proves nothing: an RPC that ran fine and
 * declined the cancellation returns `cancelled = false` with no error at all.
 * Reading the flag is the difference between telling a patient their
 * appointment is cancelled and it actually being cancelled.
 */
export async function commitCancellation(input: {
  context: TurnContext;
  appointmentId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await cancelPatientAiAppointment({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
  });
  if (result.error) return { ok: false, reason: "rpc_error" };
  const row = firstRow(result.data);
  if (row?.cancelled !== true) {
    return { ok: false, reason: String(row?.reason ?? "refused") };
  }
  return { ok: true };
}

/**
 * The appointment a reschedule is about, as the server describes it.
 *
 * `prepare_patient_ai_reschedule` takes only the appointment and returns its
 * doctor, service and duration — it has never taken a date. The call this
 * replaces passed one anyway and silenced the resulting type error with a cast,
 * so the argument was dropped on the floor and the single appointment row came
 * back where a list of times was expected. The reschedule flow then offered
 * that row *as* a time.
 *
 * What it returns instead is what a reschedule actually needs: the identifiers
 * to ask the calendar with, so days and times are read from the same
 * authoritative availability the booking flow uses rather than parsed out of
 * the patient's message.
 */
export async function readRescheduleTarget(input: {
  context: TurnContext;
  appointmentId: string;
}): Promise<
  | {
      ok: true;
      doctorId: string;
      doctorName: string;
      serviceId: string | null;
      durationMinutes: number;
    }
  | { ok: false }
> {
  const result = await preparePatientAiReschedule({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
  });
  if (result.error) return { ok: false };
  const row = firstRow(result.data);
  if (!row || typeof row.doctor_id !== "string") return { ok: false };
  return {
    ok: true,
    doctorId: row.doctor_id,
    doctorName: String(row.doctor_name ?? ""),
    serviceId: typeof row.service_id === "string" ? row.service_id : null,
    durationMinutes: Number(row.duration_minutes ?? 30),
  };
}

/**
 * Moves the appointment. Reads the RPC's own verdict, for the reason
 * {@link commitCancellation} does.
 */
export async function commitReschedule(input: {
  context: TurnContext;
  appointmentId: string;
  scheduledAt: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await reschedulePatientAiAppointment({
    clinicId: input.context.clinicId,
    conversationId: input.context.conversationId,
    appointmentId: input.appointmentId,
    scheduledAt: input.scheduledAt,
  });
  if (result.error) return { ok: false, reason: "rpc_error" };
  const row = firstRow(result.data);
  if (row?.rescheduled !== true) {
    return { ok: false, reason: String(row?.reason ?? "refused") };
  }
  return { ok: true };
}

/** The first row of an RPC result set, whatever shape PostgREST returned it in. */
function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    return (data[0] as Record<string, unknown> | undefined) ?? null;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}
