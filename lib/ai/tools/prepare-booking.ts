import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  availableDoctorsInDepartment,
  departmentDoctorsPayload,
  isOtherDoctorsRequest,
  loadDoctorDirectory,
  resolveDoctorName,
  toDoctorOption,
  type DirectoryDepartment,
  type DirectoryDoctor,
  type DoctorDirectory,
} from "@/lib/ai/doctor-directory";
import {
  allowsTreatingDoctorOpening,
  establishedDepartmentId as establishedDepartmentIdOf,
  isBookingOpening as isBookingOpeningFor,
} from "@/lib/ai/booking-stage";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import {
  buildPatientVocabulary,
  isPatientSourcedArgument,
} from "@/lib/ai/argument-provenance";
import {
  assertPatientBookingIdentity,
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import {
  createClinicScopedAdminClient,
  setConversationAiState,
} from "@/lib/supabase/admin";

/**
 * Resolves the receptionist part of a booking: existing-file context first,
 * then a real active department and *every* one of that department's bookable
 * doctors.
 *
 * The rule this tool now enforces structurally, rather than by prompt wording:
 * a result that is not a resolved doctor always carries the department's
 * complete roster. Before, a not-found or ambiguous name came back with three
 * fuzzy candidates and nothing else, so "is there another doctor?" had no true
 * answer available and the assistant either repeated the one doctor it already
 * knew about or invented one.
 *
 * Names are fuzzy only here; identity decisions never call this resolver.
 */
export function prepareBookingTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Start or continue appointment booking. Call this first. For an existing patient it returns " +
      "their treating doctor first, together with the other bookable doctors in that department. " +
      "For a new patient it lists active departments, then returns ALL bookable doctors of the " +
      "chosen department. Pass the patient's own words as `doctor` — a name, an ordinal, or a " +
      "request such as 'another doctor' / 'في دكاترة غيره؟', which returns the rest of the roster " +
      "without restarting the flow. Never invent an id and never guess when the result asks for " +
      "clarification.",
    inputSchema: z.object({
      department: z.string().trim().min(1).max(120).optional(),
      doctor: z.string().trim().min(1).max(120).optional(),
      /**
       * Set when the patient asked for alternatives in words the model would
       * rather not pass through `doctor`. Equivalent to a `doctor` value that
       * `isOtherDoctorsRequest` recognises.
       */
      show_other_doctors: z.boolean().optional(),
      /**
       * P9C — "ممكن احجز لصاحبي".
       *
       * Set here rather than only on `register_patient` because of an ordering
       * problem that is otherwise circular: the stage table mounts
       * `register_patient` only in `intake_collecting`, and a linked
       * conversation never derives that stage unless something has already
       * recorded that the patient is not the sender. `prepare_booking` is the
       * one tool the model calls at the opening of every booking, so this is
       * where the conversation can first learn who it is for.
       */
      for_someone_else: z
        .boolean()
        .optional()
        .describe(
          "True when the patient says the appointment is for another person ('لصاحبي', " +
            "'for my friend'). It never books anything — it records who the booking is for.",
        ),
    }),
    execute: async (rawInput) => {
      const { show_other_doctors, for_someone_else } = rawInput;
      let department = rawInput.department;
      let doctor = rawInput.doctor;
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
        refuseIfPaused: true,
      });
      assertPatientBookingIdentity(identity, {
        forSomeoneElse:
          for_someone_else === true || identity.bookingStage?.bookingForOther === true,
      });
      if (for_someone_else === true) {
        // Latched before anything else, so every stage decision made in the rest
        // of this call already knows the patient is not the sender.
        await recordStageTurn(identity, { bookingIntent: true, bookingForOther: true });
      }
      const db = createClinicScopedAdminClient(identity.clinicId);
      const directory: DoctorDirectory = await loadDoctorDirectory(identity.clinicId);
      const departments = directory.departments;

      // F-11 — an entity argument the patient never uttered carries no
      // information, so it is discarded before it can suppress the opening.
      //
      // Only an argument that fails to resolve is ever questioned: a department
      // this clinic really has is honoured whatever words produced it, so a
      // model that translates "اسنان" into the stored name loses nothing. What
      // is discarded is the invented, unresolvable string a `toolChoice` pin
      // pressures the model into supplying for a patient who said only "ممكن
      // أحجز؟" — which, treated as an explicit choice, suppressed the
      // treating-doctor opening and deadlocked three live cases on the
      // `department` rung. See `lib/ai/argument-provenance.ts`.
      const vocabulary = buildPatientVocabulary(ctx.episodeUtterances ?? []);
      if (
        department &&
        resolveNamedEntity(department, departments).status === "not_found" &&
        !isPatientSourcedArgument(department, vocabulary)
      ) {
        department = undefined;
      }
      if (
        doctor &&
        !isOtherDoctorsRequest(doctor) &&
        resolveDoctorName(doctor, directory, null).status === "unknown" &&
        !isPatientSourcedArgument(doctor, vocabulary)
      ) {
        doctor = undefined;
      }

      // "Who else?" is a request for the roster, not a name. Recognising it here
      // stops it from being scored against real names, which is how an arbitrary
      // doctor used to come back as a "did you mean".
      const wantsAlternatives =
        show_other_doctors === true || isOtherDoctorsRequest(doctor);
      const doctorQuery = wantsAlternatives ? undefined : doctor;

      const establishedDepartmentId = establishedDepartmentIdOf(identity.collectedData);

      // The treating-doctor shortcut is for the *opening* of a booking, not for
      // every argument-less call. Once this conversation has chosen a
      // department, or the patient has asked for alternatives, returning the one
      // treating doctor again is what made "في دكاترة غيره؟" unanswerable.
      //
      // P9: the condition is unchanged, but it is no longer written out here.
      // "Has a department been established?" is a stage question and it now has
      // exactly one implementation, shared with `list_doctors`,
      // `list_available_days` and the stage table itself.
      const isBookingOpening = isBookingOpeningFor(identity.collectedData, {
        hasExplicitDepartment: Boolean(department),
        hasDoctorQuery: Boolean(doctorQuery),
        wantsAlternatives,
      });

      // P12 — the treating doctor belongs to the *sender*, so it can only open
      // a booking the sender is the patient for. A third-party booking that
      // borrows it forces both the doctor and the department onto somebody
      // else's appointment and skips the department question, which is exactly
      // what manual QA saw after the other person's name was collected.
      const treatingAllowed =
        allowsTreatingDoctorOpening({
          linked: identity.linked,
          beneficiary: identity.bookingStage?.beneficiary ?? null,
          bookingForOther:
            for_someone_else === true ||
            identity.bookingStage?.bookingForOther === true,
        }) && Boolean(identity.patientId);
      const treatingResult = treatingAllowed
        ? await treatingDoctorContext(db, directory, identity.patientId!)
        : null;

      if (isBookingOpening) {
        if (treatingResult) {
          // V2-CONTAINMENT (I-5) — the treating doctor is a **candidate**, and
          // this is where it stopped being one.
          //
          // The write that used to stand here took a fact out of the patient's
          // appointment *history* and committed it as a settled slot of the
          // *current* conversation. Every downstream reader then treated it as
          // something the patient had said: `hasBookingIntent` became true
          // permanently, the ladder jumped to `day`, and the authority pinned
          // the calendar — which is how a message that named no doctor was
          // answered with one doctor's availability.
          //
          // The result below still recommends them first, which is the useful
          // half and the half the patient actually benefits from. What it no
          // longer does is decide on their behalf. The doctor is committed by
          // `list_doctors`/`prepare_booking` when the patient names one, or by
          // the offered-selection pre-commit when they accept this one — both
          // of which require the patient to have said something.
          const others = treatingResult.department
            ? availableDoctorsInDepartment(directory, treatingResult.department.id)
                .filter((item) => item.id !== treatingResult.doctor.id)
                .map(toDoctorOption)
            : [];
          // The offer record stays — these doctors really were put in front of
          // the patient, and the offered-selection pre-commit needs that set to
          // read their answer against. `collectedOverride` is deliberately
          // gone: it existed to keep the derived stage in step with the write
          // above, and there is no longer a write to keep step with. Recording
          // a doctor there would reintroduce the exact commitment this change
          // removes, one layer down.
          await recordStageTurn(identity, {
            bookingIntent: true,
            tool: "prepare_booking",
            outcome: "treating_doctor_offered",
            offeredDoctorIds: [
              treatingResult.doctor.id,
              ...others.map((item) => item.id),
            ],
          });
          return {
            existing_patient: true as const,
            treating_doctor: toDoctorOption(treatingResult.doctor),
            ...(treatingResult.department
              ? { department: treatingResult.department }
              : {}),
            // Carried on the same result so "is there another doctor?" is
            // answerable without a second call and without a restart.
            other_doctors: others,
            other_doctor_count: others.length,
            // The doctor is offered, not chosen. Nothing is recorded against
            // the booking until the patient answers.
            treating_doctor_is_offer: true as const,
            guidance:
              `The patient has been treated by Dr ${treatingResult.doctor.name} before. ` +
              "Offer that doctor first and ask whether they want them again — this is a " +
              "suggestion, not a selection, and nothing about it is settled until the patient " +
              "answers. If the patient asks for someone else, offer every doctor in " +
              "other_doctors by name and do not push the previous one. Do not treat the " +
              "department as chosen either. If other_doctors is empty, say this is currently " +
              "the only doctor available in that department.",
          };
        }
      }

      let selectedDepartment: DirectoryDepartment | null =
        departments.find((item) => item.id === establishedDepartmentId) ?? null;
      if (!selectedDepartment) {
        // Context the conversation implies but never wrote down. A patient who
        // was offered their treating doctor and answered "في دكتور غيره؟" has
        // chosen a department in every sense except the stored one, and asking
        // them to name it again is the restart this tool exists to avoid. The
        // doctor already collected is the same story one step later.
        const impliedDoctorId =
          typeof identity.collectedData.doctor_id === "string"
            ? identity.collectedData.doctor_id
            : null;
        const impliedDepartmentId =
          directory.doctors.find((item) => item.id === impliedDoctorId)?.departmentId ??
          treatingResult?.department?.id ??
          null;
        selectedDepartment =
          departments.find((item) => item.id === impliedDepartmentId) ?? null;
      }
      if (department) {
        const resolution = resolveNamedEntity(department, departments);
        if (resolution.status !== "resolved") {
          return {
            needs_clarification: true as const,
            field: "department",
            reason: resolution.status,
            candidates: resolution.candidates
              .filter((item) => item.score >= 0.58)
              .map(({ id, name }) => ({ id, name })),
            // The real list travels with the clarification, so "not found" can
            // be followed immediately by the true alternatives.
            departments,
            guidance:
              resolution.status === "ambiguous"
                ? "Ask one short question naming only these plausible departments."
                : "Say that department was not found and offer these active departments.",
          };
        }
        selectedDepartment = resolution.entity;
      }
      if (!selectedDepartment) {
        return {
          existing_patient: identity.linked,
          needs_selection: true as const,
          field: "department",
          departments,
          guidance: "Offer these active ClinicFlow departments and ask which one they need.",
        };
      }

      const departmentChanged =
        Boolean(department) && establishedDepartmentId !== selectedDepartment.id;
      if (departmentChanged) {
        await setConversationAiState({
          clinicId: identity.clinicId,
          conversationId: identity.conversationId,
          collected: {
            department_id: selectedDepartment.id,
            department_name: selectedDepartment.name,
            // A department correction invalidates the earlier doctor. Empty
            // values are deliberately discarded by parseCollectedData.
            doctor_id: "",
            doctor_name: "",
            // P11 — and it invalidates the day and the time with it. A day was
            // only ever offered *for a particular doctor*, so carrying one
            // across a department change means the next stage derives
            // `selecting_time` for a doctor who was never asked about their
            // availability. That is how a second booking, started after a
            // completed one, inherited half of the first booking's target.
            appointment_date: "",
            appointment_time: "",
          },
        });
      }

      const roster = departmentDoctorsPayload(directory, selectedDepartment);
      if (roster.doctor_count === 0) {
        return {
          needs_selection: true as const,
          field: "department",
          departments,
          department: selectedDepartment,
          doctors: [],
          doctor_count: 0,
          guidance:
            "That department currently has no bookable doctors. Say so plainly and offer another " +
            "active department.",
        };
      }

      // No name to resolve — either the patient has not named one yet, or they
      // asked who else is available. Both get the complete roster.
      if (!doctorQuery) {
        await setConversationAiState({
          clinicId: identity.clinicId,
          conversationId: identity.conversationId,
          collected: {
            department_id: selectedDepartment.id,
            department_name: selectedDepartment.name,
            ...(wantsAlternatives && !departmentChanged
              ? {}
              : { doctor_id: "", doctor_name: "" }),
          },
        });
        const alreadyChosen =
          wantsAlternatives && typeof identity.collectedData.doctor_id === "string"
            ? identity.collectedData.doctor_id
            : null;
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "prepare_booking",
          outcome: wantsAlternatives ? "roster_alternatives" : "roster",
          collectedOverride: {
            department_id: selectedDepartment.id,
            ...(wantsAlternatives && !departmentChanged ? {} : { doctor_id: "" }),
          },
          offeredDoctorIds: roster.doctors.map((item) => item.id),
        });
        return {
          ...roster,
          needs_selection: true as const,
          field: "doctor",
          ...(alreadyChosen ? { previously_offered_doctor_id: alreadyChosen } : {}),
          guidance:
            roster.doctor_count === 1
              ? "Exactly one doctor is currently available in this department. Say so explicitly, " +
                "name them, and ask whether to continue with them. Never add a second name."
              : "List EVERY doctor in `doctors` by name in one sentence, then ask which one they " +
                "want. Do not offer a subset, do not pick one for the patient, and never name a " +
                "doctor that is not in this list.",
        };
      }

      const resolution = resolveDoctorName(doctorQuery, directory, selectedDepartment.id);
      if (resolution.status === "resolved") {
        // P12-QA — «غير الدكتور» has to invalidate what the old doctor's
        // calendar produced. A day and a time are only ever offered *for a
        // particular doctor*, so carrying them across a doctor change leaves
        // the draft holding a slot the new doctor was never asked about, and
        // the stage derives `selecting_time` for a calendar nobody read. The
        // department, the beneficiary and every intake field are untouched:
        // changing the doctor says nothing about who the patient is.
        const doctorChanged =
          typeof identity.collectedData.doctor_id === "string" &&
          identity.collectedData.doctor_id.length > 0 &&
          identity.collectedData.doctor_id !== resolution.doctor.id;
        await setConversationAiState({
          clinicId: identity.clinicId,
          conversationId: identity.conversationId,
          collected: {
            department_id: selectedDepartment.id,
            department_name: selectedDepartment.name,
            doctor_id: resolution.doctor.id,
            doctor_name: resolution.doctor.name,
            // Empty values are deliberately discarded by parseCollectedData.
            ...(doctorChanged ? { appointment_date: "", appointment_time: "" } : {}),
          },
        });
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "prepare_booking",
          outcome: doctorChanged ? "doctor_changed" : "doctor_resolved",
          collectedOverride: {
            department_id: selectedDepartment.id,
            doctor_id: resolution.doctor.id,
            ...(doctorChanged ? { appointment_date: "", appointment_time: "" } : {}),
          },
          offeredDoctorIds: [resolution.doctor.id],
          ...(doctorChanged ? { clearOfferedDays: true, clearOfferedSlots: true } : {}),
        });
        return {
          resolved: true as const,
          existing_patient: identity.linked,
          department: selectedDepartment,
          doctor: toDoctorOption(resolution.doctor),
          guidance:
            "The real department and doctor are resolved. Continue with list_available_days and " +
            "do not ask for the department or the doctor again.",
        };
      }

      if (resolution.status === "ambiguous") {
        return {
          ...roster,
          needs_clarification: true as const,
          field: "doctor",
          reason: "ambiguous" as const,
          candidates: resolution.candidates.map(toDoctorOption),
          guidance:
            "More than one doctor could be the one they mean. Ask one short question naming only " +
            "the candidates. Do not choose for the patient.",
        };
      }

      // Every remaining branch is a real status the clinic's own data proves.
      // None of them is an error, and none of them may be reported as one.
      if (resolution.status === "other_department") {
        return {
          ...roster,
          needs_selection: true as const,
          field: "doctor",
          reason: "doctor_in_other_department" as const,
          requested_doctor: {
            ...toDoctorOption(resolution.doctor),
            department: resolution.doctor.departmentName,
          },
          departments,
          guidance:
            "This doctor is real but works in a different department. Say which department they " +
            "are in, then offer every doctor in `doctors` for the department the patient chose. " +
            "Offer to switch department if they would rather see that doctor.",
        };
      }
      if (resolution.status === "on_leave") {
        return {
          ...roster,
          needs_selection: true as const,
          field: "doctor",
          reason: "doctor_on_leave" as const,
          requested_doctor: {
            ...toDoctorOption(resolution.doctor),
            department: resolution.doctor.departmentName,
            unavailable_until: resolution.doctor.unavailableUntil,
          },
          guidance:
            "This doctor is currently unavailable according to the clinic's own leave records. " +
            "Say plainly that they are not available at the moment — never invent a reason for " +
            "the leave — and offer every doctor in `doctors`.",
        };
      }
      if (resolution.status === "inactive") {
        return {
          ...roster,
          needs_selection: true as const,
          field: "doctor",
          reason: "doctor_inactive" as const,
          requested_doctor: toDoctorOption(resolution.doctor),
          guidance:
            "This doctor is no longer available at the clinic. Say that plainly, without giving a " +
            "reason the records do not contain, and offer every doctor in `doctors`.",
        };
      }

      return {
        ...roster,
        needs_selection: true as const,
        field: "doctor",
        reason: "doctor_not_found" as const,
        guidance:
          "That name does not match any doctor at this clinic. Say so plainly and offer every " +
          "doctor in `doctors` for the selected department.",
      };
    },
  });
}

type TreatingDoctorContext = {
  doctor: DirectoryDoctor;
  department: DirectoryDepartment | null;
};

/**
 * The patient's assigned doctor, but only when that doctor is still bookable.
 *
 * A treating doctor who has left the clinic or is currently on leave is not a
 * recommendation, so the caller falls through to the ordinary department flow
 * rather than opening on somebody the patient cannot actually book.
 */
async function treatingDoctorContext(
  db: ReturnType<typeof createClinicScopedAdminClient>,
  directory: DoctorDirectory,
  patientId: string,
): Promise<TreatingDoctorContext | null> {
  const patient = await db
    .from("patients")
    .select("assigned_doctor_id, department_id")
    .eq("id", patientId)
    .eq("is_deleted", false)
    .maybeSingle();
  const assignedId = patient.data?.assigned_doctor_id ?? null;
  if (!assignedId) return null;
  const doctor = directory.doctors.find((item) => item.id === assignedId);
  if (!doctor || doctor.state !== "available") return null;
  const departmentId = doctor.departmentId ?? patient.data?.department_id ?? null;
  const department =
    directory.departments.find((item) => item.id === departmentId) ?? null;
  return { doctor, department };
}
