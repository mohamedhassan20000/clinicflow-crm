import "server-only";

import {
  availableDoctorsInDepartment,
  departmentDoctorsPayload,
  loadDoctorDirectory,
  resolveDoctorName,
  toDoctorOption,
  type DirectoryDepartment,
  type DirectoryDoctor,
  type DoctorDirectory,
} from "@/lib/ai/doctor-directory";
import { isUuid } from "@/lib/ai/tools/booking-refs";
import { establishedDepartmentId, establishedDoctorId } from "@/lib/ai/booking-stage";
import { resolveOfferedDoctor } from "@/lib/ai/offered-doctor-resolution";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";
import {
  createClinicScopedAdminClient,
  setConversationAiState,
} from "@/lib/supabase/admin";

/**
 * P9B — the one place a booking tool turns model-supplied ids into real ones.
 *
 * `prepare_booking` has always resolved a department and a doctor properly. The
 * three tools *after* it — `list_available_days`, `check_availability` and
 * `create_preliminary_booking` — did not: each took `doctor_id` and `service_id`
 * straight off the model's tool call, passed them to the availability engine,
 * and reported whatever came back.
 *
 * That is what broke the real Dermatology → Dr Ahmed Nabil flow. The model never
 * called `prepare_booking` at all (the stage trace for those turns records
 * `tool_called: "none"`), so it had no real ids; on the doctor-selection turn it
 * called `list_available_days` with an invented `service_id`, the service lookup
 * missed, and `{ ok: false, reason: "service_not_found" }` came back carrying no
 * roster, no alternative and no guidance. A dead end with nothing to say is
 * exactly the shape that becomes "sorry, technical problem, here is the clinic's
 * phone number" — and the conversation's `ai_collected_data` still held nothing
 * but a date, because none of these tools ever wrote the doctor down.
 *
 * So this module enforces three things, server-side, for every tool downstream
 * of the roster:
 *
 *   1. **An id the clinic cannot prove is never used.** A `doctor_id` that is
 *      not a real, bookable doctor of this clinic does not reach the
 *      availability engine and is never persisted.
 *   2. **Nothing here is an error.** Every unresolved case comes back as a
 *      recoverable selection payload carrying the real roster (or the real
 *      department list) and a guidance line naming the next move. The technical
 *      fallback in `patient-tools.ts` is reserved for thrown exceptions.
 *   3. **A resolved selection becomes durable state.** The department and the
 *      doctor are written to `ai_collected_data` here, so the booking survives
 *      whichever tool the model happened to reach for.
 *
 * P9C extends rule 1 in the only direction that was left. The uuid was not just
 * unprovable, it was *unproducible*: the model does not have one when the patient
 * has just said a name out loud, and `z.string().uuid()` rejected the call before
 * any of this ran. So `doctorId` is now a reference — uuid or the patient's own
 * words — and the words are resolved here, against the same directory, by the
 * same resolver `prepare_booking` uses. See `tools/booking-refs.ts`.
 *
 * A `service_id` is treated as a filter, never as a gate: an unknown one is
 * dropped and reported as dropped. A patient booking does not need a service —
 * the duration does the work — and refusing the whole turn over one hallucinated
 * uuid is precisely the dead end this module exists to remove.
 */

export type ResolvedBookingTarget = {
  status: "resolved";
  doctor: DirectoryDoctor;
  department: DirectoryDepartment | null;
  /** Validated, or null when none was supplied or the supplied one was dropped. */
  serviceId: string | null;
  /** True when a `service_id` was supplied and did not resolve. */
  serviceIgnored: boolean;
};

export type UnresolvedBookingTarget = {
  status: "unresolved";
  /** Enumerated label for the audit + stage trace. Never free text. */
  outcome:
    | "doctor_unknown"
    | "doctor_ambiguous"
    | "doctor_not_recognized"
    | "doctor_on_leave"
    | "doctor_inactive"
    | "department_required"
    | "no_bookable_doctors";
  /** The recoverable tool result. Always carries real options and guidance. */
  payload: Record<string, unknown>;
};

export type BookingTargetOutcome = ResolvedBookingTarget | UnresolvedBookingTarget;

function departmentOf(
  directory: DoctorDirectory,
  doctor: DirectoryDoctor,
): DirectoryDepartment | null {
  return directory.departments.find((item) => item.id === doctor.departmentId) ?? null;
}

/**
 * The department the conversation is working in, for the purpose of offering
 * alternatives: the one already collected, else none.
 */
function contextDepartment(
  directory: DoctorDirectory,
  identity: ResolvedPatientAiContext,
): DirectoryDepartment | null {
  const id = establishedDepartmentId(identity.collectedData);
  if (!id) return null;
  return directory.departments.find((item) => item.id === id) ?? null;
}

function explicitDoctorChoice(
  patientText: string | null | undefined,
  directory: DoctorDirectory,
  department: DirectoryDepartment | null,
  offeredIds: readonly string[],
): string | null {
  const text = patientText?.trim();
  if (!text) return null;
  const offered = directory.doctors
    .filter((doctor) => offeredIds.includes(doctor.id))
    .map(toDoctorOption);
  if (offered.length > 0) {
    const selected = resolveOfferedDoctor({ patientText: text, offered });
    if (selected.status === "resolved") return selected.doctor.id;
  }
  const candidates = [
    text,
    text.replace(
      /^(?:(?:i\s+)?want(?:\s+to)?(?:\s+book)?|book(?:\s+me)?|عايز(?:ة)?|أريد|اريد)[\s\S]*?(?:\bwith\b|مع)\s+/iu,
      "",
    ),
  ];
  for (const candidate of candidates) {
    const named = resolveDoctorName(candidate, directory, department?.id ?? null);
    if (
      named.status === "resolved" ||
      named.status === "other_department" ||
      named.status === "on_leave" ||
      named.status === "inactive"
    ) {
      return named.doctor.id;
    }
  }
  return null;
}

/**
 * The "pick a doctor" answer, with whatever truth the clinic's data supports:
 * the department's complete roster when a department is settled, the list of
 * active departments when it is not.
 */
function selectionPayload(
  directory: DoctorDirectory,
  department: DirectoryDepartment | null,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  if (department) {
    const roster = departmentDoctorsPayload(directory, department);
    return {
      ...roster,
      needs_selection: true as const,
      field: "doctor",
      ...extra,
    };
  }
  return {
    needs_selection: true as const,
    field: "department",
    departments: directory.departments,
    ...extra,
  };
}

async function validateService(
  clinicId: string,
  serviceId: string | null | undefined,
): Promise<{ serviceId: string | null; serviceIgnored: boolean }> {
  if (!serviceId) return { serviceId: null, serviceIgnored: false };
  // A service *name* is not a lookup key, and feeding one to a uuid column
  // raises `22P02` rather than returning no rows — an exception on the booking
  // path, which is the shape that becomes the technical fallback. Dropped here,
  // for the same reason an unknown uuid is dropped below.
  if (!isUuid(serviceId)) return { serviceId: null, serviceIgnored: true };
  const db = createClinicScopedAdminClient(clinicId);
  const service = await db
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (service.error || !service.data) {
    // Dropped, not refused. See the module note.
    return { serviceId: null, serviceIgnored: true };
  }
  return { serviceId: service.data.id, serviceIgnored: false };
}

/**
 * Resolves the doctor (and the service filter) a booking tool should act on.
 *
 * `doctorId` is the model's argument — a uuid *or* the patient's words — and is
 * treated as a claim, not a fact. The
 * fallback is the conversation's own collected `doctor_id`, which is subject to
 * exactly the same directory check — a doctor who has since gone on leave or
 * left the clinic must not keep working just because a jsonb column remembers
 * them.
 */
export async function resolvePatientBookingTarget(input: {
  identity: ResolvedPatientAiContext;
  doctorId?: string | null;
  serviceId?: string | null;
  /** Write the resolved department + doctor to `ai_collected_data`. */
  persist?: boolean;
  /**
   * Whether a department with exactly one bookable doctor may resolve to that
   * doctor without the patient naming them.
   *
   * True for the two availability reads, where it reproduces what the
   * availability engine did implicitly. False for `create_preliminary_booking`:
   * a *write* must never guess who the appointment is with, however obvious the
   * only candidate looks.
   */
  allowImplicitSingleDoctor?: boolean;
  /** Newest patient-authored text; a stale model argument cannot change a bound doctor. */
  patientText?: string | null;
  now?: Date;
}): Promise<BookingTargetOutcome> {
  const { identity } = input;
  const directory = await loadDoctorDirectory(identity.clinicId, {
    ...(input.now ? { now: input.now } : {}),
  });
  const department = contextDepartment(directory, identity);

  // The model's argument is a *reference*, not an id: a uuid when it is echoing
  // one back, the patient's own words the rest of the time. Both are claims, and
  // both are checked against the directory before anything is done with them.
  const establishedId = establishedDoctorId(identity.collectedData) ?? null;
  const patientChoice = establishedId
    ? explicitDoctorChoice(
        input.patientText,
        directory,
        department,
        identity.bookingStage.offeredDoctorIds,
      )
    : null;
  // Once a doctor is selected, only this turn's patient-authored words may
  // replace them. A model-carried UUID or stale name is not consent to switch.
  const claimedRef = establishedId
    ? patientChoice ?? establishedId
    : (input.doctorId ?? "").trim() || null;
  let claimedId: string | null = null;

  if (claimedRef && isUuid(claimedRef)) {
    claimedId = claimedRef;
  } else if (claimedRef) {
    // A name. Resolved exactly as `prepare_booking` resolves one, against the
    // department the conversation is working in, so "احمد نبيل" means the same
    // doctor whichever tool the model happened to reach for.
    const named = resolveDoctorName(claimedRef, directory, department?.id ?? null);
    if (named.status === "ambiguous") {
      return {
        status: "unresolved",
        outcome: "doctor_ambiguous",
        payload: selectionPayload(directory, department, {
          reason: "doctor_ambiguous" as const,
          candidates: named.candidates.map(toDoctorOption),
          guidance:
            "More than one doctor matches that name. Ask the patient which of `candidates` they " +
            "mean, by name, then call this tool again with the answer.",
        }),
      };
    }
    if (named.status === "unknown") {
      return {
        status: "unresolved",
        outcome: "doctor_not_recognized",
        payload: selectionPayload(directory, department, {
          reason: "doctor_not_recognized" as const,
          guidance:
            "No doctor of this clinic matches that name. Offer every doctor in the result by " +
            "name and ask which one the patient wants. This is a normal step, not a failure.",
        }),
      };
    }
    // `resolved`, `other_department`, `on_leave` and `inactive` all name a real
    // person. The last two are answered by the availability check further down,
    // which already says the true thing about a doctor who cannot be booked —
    // duplicating that judgement here would be a second place to get it wrong.
    claimedId = named.doctor.id;
  }

  if (!claimedId) claimedId = establishedId;
  if (!claimedId && department && input.allowImplicitSingleDoctor === true) {
    // A department with exactly one bookable doctor has already answered the
    // question. The availability engine used to bind that doctor implicitly;
    // doing it here keeps the behaviour and makes the binding explicit enough
    // to be written down.
    const only = availableDoctorsInDepartment(directory, department.id);
    if (only.length === 1) claimedId = only[0]!.id;
  }
  if (!claimedId) {
    return {
      status: "unresolved",
      outcome: department ? "doctor_unknown" : "department_required",
      payload: selectionPayload(directory, department, {
        reason: "doctor_required" as const,
        guidance: department
          ? "No doctor has been chosen yet. List every doctor in `doctors` by name and ask which " +
            "one they want, then call prepare_booking with the patient's answer. Do not check " +
            "availability until a doctor is resolved."
          : "No department has been chosen yet. Offer these active departments, then call " +
            "prepare_booking with the patient's answer. This is a normal step, not a failure.",
      }),
    };
  }

  const doctor = directory.doctors.find((item) => item.id === claimedId) ?? null;
  if (!doctor) {
    // Either the model invented the uuid or the collected one belongs to a
    // doctor this clinic no longer has. Both are recoverable and neither is an
    // error the patient should ever hear about.
    if (persistWanted(input) && establishedDoctorId(identity.collectedData) === claimedId) {
      await clearCollectedDoctor(identity);
    }
    return {
      status: "unresolved",
      outcome: "doctor_not_recognized",
      payload: selectionPayload(directory, department, {
        reason: "doctor_not_recognized" as const,
        guidance:
          "That doctor id is not one this clinic issued, so it cannot be used. Never send an id " +
          "to the patient. Call prepare_booking with the department and the doctor exactly as the " +
          "patient said them, and continue from the doctor it resolves.",
      }),
    };
  }

  if (doctor.state !== "available") {
    const alternativesDepartment = departmentOf(directory, doctor) ?? department;
    return {
      status: "unresolved",
      outcome: doctor.state === "on_leave" ? "doctor_on_leave" : "doctor_inactive",
      payload: selectionPayload(directory, alternativesDepartment, {
        reason:
          doctor.state === "on_leave"
            ? ("doctor_on_leave" as const)
            : ("doctor_inactive" as const),
        requested_doctor: {
          ...toDoctorOption(doctor),
          department: doctor.departmentName,
          ...(doctor.state === "on_leave"
            ? { unavailable_until: doctor.unavailableUntil }
            : {}),
        },
        guidance:
          doctor.state === "on_leave"
            ? "This doctor is unavailable according to the clinic's own leave records. Say so " +
              "plainly — never invent a reason — and offer every doctor in `doctors`."
            : "This doctor is no longer available at the clinic. Say that plainly, without a " +
              "reason the records do not contain, and offer every doctor in `doctors`.",
      }),
    };
  }

  const resolvedDepartment = departmentOf(directory, doctor) ?? department;
  if (
    resolvedDepartment &&
    availableDoctorsInDepartment(directory, resolvedDepartment.id).length === 0
  ) {
    // Defensive: `doctor` is available and belongs to this department, so this
    // is unreachable today. It stays because "the roster is empty" must never
    // be answered with an empty list and no words.
    return {
      status: "unresolved",
      outcome: "no_bookable_doctors",
      payload: {
        needs_selection: true as const,
        field: "department",
        departments: directory.departments,
        guidance:
          "That department currently has no bookable doctors. Say so plainly and offer another " +
          "active department.",
      },
    };
  }

  const service = await validateService(identity.clinicId, input.serviceId);

  if (persistWanted(input)) {
    // The write `list_available_days` and `check_availability` never did. This
    // is what makes a doctor selection survive the turn it was made in.
    await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: {
        doctor_id: doctor.id,
        doctor_name: doctor.name,
        ...(resolvedDepartment
          ? {
              department_id: resolvedDepartment.id,
              department_name: resolvedDepartment.name,
            }
          : {}),
      },
    });
  }

  return {
    status: "resolved",
    doctor,
    department: resolvedDepartment,
    serviceId: service.serviceId,
    serviceIgnored: service.serviceIgnored,
  };
}

function persistWanted(input: { persist?: boolean }): boolean {
  return input.persist !== false;
}

/**
 * Drops a doctor the directory can no longer prove.
 *
 * `set_conversation_ai_state` discards empty values by design, which is how a
 * field is cleared: the same mechanism `prepare_booking` uses when a department
 * correction invalidates the doctor chosen under it.
 */
async function clearCollectedDoctor(identity: ResolvedPatientAiContext): Promise<void> {
  await setConversationAiState({
    clinicId: identity.clinicId,
    conversationId: identity.conversationId,
    collected: { doctor_id: "", doctor_name: "" },
  });
}
