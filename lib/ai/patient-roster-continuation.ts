import "server-only";

import { fromZonedTime } from "date-fns-tz";

import { logAgentTool } from "@/lib/ai/audit";
import {
  candidateClockTimes,
  establishedDepartmentId,
  establishedDoctorId,
  missingIntakeFields,
  nextBookingStep,
  resolveOfferedDay,
  resolveOfferedTime,
  type BookingStep,
} from "@/lib/ai/booking-stage";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import {
  availableDoctorsInDepartment,
  isOtherDoctorsRequest,
  toDoctorOption,
  type DoctorDirectory,
} from "@/lib/ai/doctor-directory";
import {
  resolveDepartmentChange,
  resolveOfferedDoctor,
} from "@/lib/ai/offered-doctor-resolution";
import {
  buildDeterministicDaysReply,
  buildDeterministicDoctorChoiceReply,
  buildDeterministicIntakeReply,
  buildDeterministicPendingBookingReply,
  buildDeterministicRevalidationReply,
  buildDeterministicRosterReply,
  buildDeterministicTimeChoiceReply,
  buildDeterministicTimesReply,
} from "@/lib/ai/patient-grounding";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";
import {
  createPatientPendingBooking,
  getPatientAvailableDays,
  getPatientAvailableSlots,
} from "@/lib/booking/patient";
import { setConversationAiState } from "@/lib/supabase/admin";
import type { NamedEntity } from "@/lib/ai/entity-resolution";

/**
 * P11D/P11F — the deterministic answer, made to *advance the booking* instead
 * of merely describing it, and then made to stop going backwards.
 *
 * ## P11D: the defect this module was originally the fix for
 *
 * Production conversation, four consecutive turns, all four with
 * `tool_called: "none"`. The model answered a booking turn in prose without
 * calling `prepare_booking` or `list_doctors` (both were mounted). Its reply
 * named doctors, so `checkDoctorGrounding` rejected it against an empty
 * allowed-set, and the `unbacked_roster` branch replaced the whole reply with a
 * server-composed sentence — correctly, because the alternative is a phantom
 * roster. That sentence was then thrown away as state, so every roster-bearing
 * turn re-entered the same branch: a livelock in which the fallback's own
 * statelessness guaranteed it would fire again.
 *
 * P11D established the rule that fixed it:
 *
 * > **A roster the server puts in front of a patient is an offer, and an offer
 * > is state.**
 *
 * ## P11F: what P11D did not fix, and what this module is now
 *
 * The same production clinic, eight turns later, `tool_called: "none"` on every
 * single turn again — the model never called a booking tool in the entire
 * conversation, so *the deterministic path was the booking flow*. And the
 * deterministic path knew two sentences: "here is the roster" and "here are the
 * days". So:
 *
 * ```
 *   turn 40  "يوسف"            → doctor committed, real days offered   ✅
 *   turn 41  "31"              → (model prose, not checked) times      ⚠️ nothing persisted
 *   turn 42  "الساعه ٩ الصبح"  → grounding fires; the continuation has
 *                                no sentence for a time, resolves the
 *                                text against the *doctor* roster,
 *                                misses, and re-offers the roster       ❌
 * ```
 *
 * `stage_before` and `stage_after` were `intake_collecting` on all three turns
 * and `illegalTransitions` stayed 0, because the stage machine was never wrong:
 * the *presentation* went backwards, and nothing in the system had an opinion
 * about that. The patient, having chosen a department, a doctor, a day and a
 * time, was asked to choose a doctor.
 *
 * So the rule this module now adds on top of P11D's:
 *
 * > **A deterministic reply answers the step the booking is on, and may never
 * > render the step before it.**
 *
 * The step comes from `nextBookingStep` — derived, pure, monotonic in the
 * collected facts, and computed from the same `ai_collected_data` the tools
 * write. Every branch below is selected by it, so "the latest message contains
 * a doctor-shaped word" can no longer produce a roster on a turn that is about
 * a clock time. Going backwards is possible, and stays possible, but only for
 * the four reasons §4 of the phase brief allows: an explicit department change,
 * an explicit doctor change, a doctor the directory no longer lists as
 * available, and a slot that failed revalidation at booking time. Each of those
 * is a named branch with its own outcome label in the audit trail.
 *
 * ## What it must never do
 *
 * It knows no department name and no doctor name. Every candidate comes from
 * the live directory loaded this turn, every choice is made against candidates
 * the server produced, and the offered roster is always
 * `availableDoctorsInDepartment` — so this module cannot invent, substitute or
 * resurrect a doctor, and the P11B closed-world guarantee is unchanged. It also
 * never clears `bookingForOther`, and never clears the booking target while
 * collecting intake: the booking *subject* and the booking *target* are
 * separate state and stay that way.
 */

export type RosterContinuation = {
  text: string;
  /** What was persisted, for the audit trace. Labels only, never names. */
  committed: "doctor" | "department" | "day" | "time" | "booking" | "none";
  /** Which branch produced the sentence. Labels only. */
  outcome:
    | "doctor_selected"
    | "doctor_ambiguous"
    | "doctor_changed"
    | "doctor_unavailable"
    | "department_changed"
    | "roster_offered"
    | "department_list"
    | "days_offered"
    | "day_selected"
    | "times_offered"
    | "time_ambiguous"
    | "time_selected"
    | "time_commit_failed"
    | "intake_required"
    | "booking_created"
    | "booking_blocked"
    | "already_submitted";
  /** The ladder step this turn was answering. For the trace. */
  step: BookingStep;
};

/** How long a patient-booked appointment is, matching the booking tools. */
const DEFAULT_DURATION_MINUTES = 30;

export async function continuePatientBookingFromRoster(input: {
  identity: ResolvedPatientAiContext;
  directory: DoctorDirectory;
  locale: "ar" | "en";
  patientText: string | null;
}): Promise<RosterContinuation> {
  const { identity, directory, locale } = input;
  const patientText = input.patientText ?? null;
  const departments: NamedEntity[] = directory.departments.map((item) => ({
    id: item.id,
    name: item.name,
  }));
  const collected = identity.collectedData;
  const stage = identity.bookingStage;
  const currentDepartmentId = establishedDepartmentId(collected);
  const currentDoctorId = establishedDoctorId(collected);

  // The authoritative step. Everything below is a branch on this value, and
  // nothing below re-derives it from the patient's words.
  const step = nextBookingStep({
    collected,
    linked: identity.linked,
    bookingForOther: stage.bookingForOther,
    intakeStaged: stage.intakeStaged,
    submitted: stage.submitted,
  });

  // ---- 0. The four sanctioned ways to go backwards ------------------------
  //
  // Checked before the ladder, and only these four. Each one *clears* the
  // fields it invalidates, so the ladder then recomputes forward from a
  // genuinely earlier position rather than being overridden.

  // (a) "لا عايز جلدية" — an explicit department change.
  const departmentChange = currentDepartmentId
    ? resolveDepartmentChange({ patientText, departments, currentDepartmentId })
    : null;
  if (departmentChange) {
    return await commitDepartment({
      identity,
      directory,
      locale,
      department: departmentChange,
      clearDoctor: true,
      outcome: "department_changed",
      step,
    });
  }

  // (b) The doctor this conversation chose is no longer bookable. A leave
  //     block or a deactivation between two turns is a *domain* fact, not a
  //     change of mind, and it is the one thing that may take a settled doctor
  //     away without the patient asking.
  if (currentDoctorId) {
    const chosen = directory.doctors.find((item) => item.id === currentDoctorId);
    if (!chosen || chosen.state !== "available") {
      return await reofferRoster({
        identity,
        directory,
        locale,
        departmentId: currentDepartmentId,
        departments,
        preface: buildDeterministicRevalidationReply({
          locale,
          reason: "doctor_unavailable",
          doctorName: chosen?.name ?? null,
        }),
        outcome: "doctor_unavailable",
        step,
      });
    }
  }

  // (c) "مين دكتور تاني؟" / naming a different doctor from the same offered
  //     roster — an explicit change, and the only patient-driven way back to
  //     the roster once a doctor is settled.
  if (currentDoctorId && currentDepartmentId) {
    const explicit = explicitDoctorChange({ directory, stage, patientText, currentDoctorId });
    if (explicit === "alternatives") {
      return await reofferRoster({
        identity,
        directory,
        locale,
        departmentId: currentDepartmentId,
        departments,
        preface: null,
        outcome: "doctor_changed",
        step,
      });
    }
    if (explicit && explicit !== "none") {
      return await commitDoctor({
        identity,
        locale,
        departmentId: currentDepartmentId,
        doctor: explicit,
        outcome: "doctor_changed",
        step,
      });
    }
  }

  // ---- 1. The ladder ------------------------------------------------------
  switch (step) {
    case "department":
      return await answerDepartmentStep({
        identity,
        directory,
        locale,
        departments,
        patientText,
        step,
      });
    case "doctor":
      return await answerDoctorStep({
        identity,
        directory,
        locale,
        departments,
        patientText,
        departmentId: currentDepartmentId,
        step,
      });
    case "day":
      return await answerDayStep({ identity, locale, patientText, step });
    case "time":
      return await answerTimeStep({ identity, locale, patientText, step });
    case "intake":
      return intakeAsk({ identity, locale, step, outcome: "intake_required" });
    case "confirm":
      return await answerConfirmStep({ identity, locale, step });
    case "done":
    default:
      return {
        text: buildDeterministicIntakeReply({
          locale,
          doctorName: String(collected.doctor_name ?? ""),
          date: dateOf(identity),
          time: timeOf(identity),
          missingFields: [],
          forOther: stage.bookingForOther,
        }),
        committed: "none",
        outcome: "already_submitted",
        step,
      };
  }
}

// ---------------------------------------------------------------------------
// Backward-transition detection
// ---------------------------------------------------------------------------

/**
 * Did the patient ask for a *different* doctor?
 *
 * Three answers, and the distinction between them is the whole of §4's "unless
 * the patient explicitly changes doctor":
 *
 *   * `"alternatives"` — "مين تاني؟", "who else?": show the roster again.
 *   * a doctor — they named somebody else from the roster we offered.
 *   * `"none"` — they said something that is not about doctors at all, which is
 *     the overwhelmingly common case on a day or time turn and the one the
 *     regression turned into a restart.
 *
 * Naming the doctor they already chose is deliberately `"none"`: "أيوه يوسف،
 * الساعة ٩" is a confirmation, not a change.
 */
function explicitDoctorChange(input: {
  directory: DoctorDirectory;
  stage: ResolvedPatientAiContext["bookingStage"];
  patientText: string | null;
  currentDoctorId: string;
}): NamedEntity | "alternatives" | "none" {
  const text = (input.patientText ?? "").trim();
  if (text.length === 0) return "none";
  if (isOtherDoctorsRequest(text)) return "alternatives";
  const offered = offeredRoster(input.directory, input.stage.offeredDoctorIds).filter(
    (doctor) => doctor.id !== input.currentDoctorId,
  );
  if (offered.length === 0) return "none";
  const resolution = resolveOfferedDoctor({ patientText: text, offered });
  return resolution.status === "resolved" ? resolution.doctor : "none";
}

// ---------------------------------------------------------------------------
// The rungs
// ---------------------------------------------------------------------------

async function answerDepartmentStep(input: {
  identity: ResolvedPatientAiContext;
  directory: DoctorDirectory;
  locale: "ar" | "en";
  departments: NamedEntity[];
  patientText: string | null;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const department = resolveDepartmentChange({
    patientText: input.patientText,
    departments: input.departments,
    currentDepartmentId: null,
  });
  if (!department) {
    // The only branch that may show the department list, and it is reachable
    // only when no department has ever been settled and this message names none.
    return {
      text: buildDeterministicRosterReply({
        locale: input.locale,
        departmentName: null,
        doctors: [],
        departments: input.departments.map((item) => item.name),
      }),
      committed: "none",
      outcome: "department_list",
      step: input.step,
    };
  }
  return await commitDepartment({
    identity: input.identity,
    directory: input.directory,
    locale: input.locale,
    department,
    clearDoctor: false,
    outcome: "roster_offered",
    step: input.step,
  });
}

async function answerDoctorStep(input: {
  identity: ResolvedPatientAiContext;
  directory: DoctorDirectory;
  locale: "ar" | "en";
  departments: NamedEntity[];
  patientText: string | null;
  departmentId: string | null;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const departmentId = input.departmentId;
  if (!departmentId) {
    return await answerDepartmentStep(input);
  }
  const offered = offeredRoster(input.directory, input.identity.bookingStage.offeredDoctorIds);
  if (offered.length > 0) {
    const resolution = resolveOfferedDoctor({ patientText: input.patientText, offered });
    if (resolution.status === "resolved") {
      return await commitDoctor({
        identity: input.identity,
        locale: input.locale,
        departmentId,
        doctor: resolution.doctor,
        outcome: "doctor_selected",
        step: input.step,
      });
    }
    if (resolution.status === "ambiguous") {
      // No commit: an ambiguous reply has not selected anybody. The question is
      // narrowed to the contested offers and the roster stays offered, so the
      // next turn resolves against the same set.
      return {
        text: buildDeterministicDoctorChoiceReply({
          locale: input.locale,
          doctors: resolution.candidates.map((item) => item.name),
        }),
        committed: "none",
        outcome: "doctor_ambiguous",
        step: input.step,
      };
    }
    // `no_match` re-offers *this department's* roster. Never the department list.
  }
  const department =
    input.departments.find((item) => item.id === departmentId) ?? null;
  if (!department) return await answerDepartmentStep(input);
  return await commitDepartment({
    identity: input.identity,
    directory: input.directory,
    locale: input.locale,
    department,
    clearDoctor: false,
    outcome: "roster_offered",
    step: input.step,
  });
}

/**
 * The day rung: "31" against the days we actually offered.
 *
 * A day that resolves is committed and answered with that day's real times —
 * two rungs in one turn, which is what a patient who says "الأربع الساعة ٩"
 * deserves and what the old code could not do at all.
 */
async function answerDayStep(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  patientText: string | null;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, locale } = input;
  const doctorId = establishedDoctorId(identity.collectedData);
  const doctorName = String(identity.collectedData.doctor_name ?? "");
  if (!doctorId) {
    return {
      text: buildDeterministicDaysReply({ locale, doctorName, days: [] }),
      committed: "none",
      outcome: "days_offered",
      step: input.step,
    };
  }
  const day = resolveOfferedDay(identity.bookingStage, input.patientText ?? "");
  if (day) {
    return await commitDay({ identity, locale, doctorId, doctorName, date: day, step: input.step });
  }
  // Not a day we offered. Re-offer the real days — never the roster.
  const days = await availableDays(identity, doctorId);
  await persist({
    identity,
    collected: null,
    patch: { offeredDays: days, tool: "deterministic_continuation", outcome: "days_offered" },
  });
  return {
    text: buildDeterministicDaysReply({ locale, doctorName, days }),
    committed: "none",
    outcome: "days_offered",
    step: input.step,
  };
}

/**
 * The time rung — the turn the P11F regression lived on.
 *
 * "الساعه ٩ الصبح" is resolved against the slots this conversation was actually
 * shown, exactly as "31" is resolved against the days. A miss re-offers the
 * times for the settled day. Neither outcome touches the doctor.
 */
async function answerTimeStep(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  patientText: string | null;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, locale } = input;
  const doctorId = establishedDoctorId(identity.collectedData);
  const doctorName = String(identity.collectedData.doctor_name ?? "");
  const date = String(identity.collectedData.appointment_date ?? "");
  if (!doctorId || !date) {
    return await answerDayStep(input);
  }

  const offeredForDate = identity.bookingStage.offeredSlots
    .filter((slot) => slot.startsWith(`${date}T`))
    .map((slot) => slot.slice(11));
  const time = resolveOfferedTime(identity.bookingStage, date, input.patientText ?? "");
  if (time) {
    return await commitTime({ identity, locale, doctorId, doctorName, date, time, step: input.step });
  }

  // A reading that matched two offered slots ("9" with both 09:00 and 21:00
  // open) is a real ambiguity and gets a real question — about times.
  if (offeredForDate.length > 0 && ambiguousAgainst(offeredForDate, input.patientText)) {
    return {
      text: buildDeterministicTimeChoiceReply({ locale, date, times: offeredForDate }),
      committed: "none",
      outcome: "time_ambiguous",
      step: input.step,
    };
  }

  const times = await availableTimes(identity, doctorId, date);
  await persist({
    identity,
    collected: null,
    patch: {
      offeredSlots: { date, times },
      tool: "deterministic_continuation",
      outcome: "times_offered",
    },
  });
  return {
    text: buildDeterministicTimesReply({ locale, doctorName, date, times }),
    committed: "none",
    outcome: "times_offered",
    step: input.step,
  };
}

/**
 * Everything is chosen and the intake is not staged: ask for the missing intake
 * fields, and *say the booking target back*.
 *
 * This is §5 and §6 of the phase brief in one function. It does not touch
 * `department_id`, `doctor_id`, `appointment_date` or `appointment_time`, it
 * writes nothing at all, and the sentence it produces is built from those four
 * values — so the target cannot be lost here without the sentence visibly
 * losing it too.
 */
function intakeAsk(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  step: BookingStep;
  outcome: "intake_required" | "booking_blocked";
}): RosterContinuation {
  const { identity } = input;
  return {
    text: buildDeterministicIntakeReply({
      locale: input.locale,
      doctorName: String(identity.collectedData.doctor_name ?? ""),
      date: dateOf(identity),
      time: timeOf(identity),
      missingFields: missingIntakeFields(identity.collectedData),
      forOther: identity.bookingStage.bookingForOther,
    }),
    committed: "none",
    outcome: input.outcome,
    step: input.step,
  };
}

/**
 * Everything is chosen and the intake is settled: put the request in.
 *
 * The same server function `create_preliminary_booking` calls, with the same
 * 24-hour rule, the same availability revalidation and the same pending caps —
 * this is not a second booking path, it is the same one reached without the
 * model's cooperation. A failure never restarts the flow: each reason maps to
 * the one rung it actually invalidates.
 */
async function answerConfirmStep(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, locale } = input;
  const doctorId = establishedDoctorId(identity.collectedData);
  const doctorName = String(identity.collectedData.doctor_name ?? "");
  const date = dateOf(identity);
  const time = timeOf(identity);
  if (!doctorId || !date || !time) {
    return await answerTimeStep({ identity, locale, patientText: null, step: input.step });
  }

  let result: Awaited<ReturnType<typeof createPatientPendingBooking>>;
  try {
    result = await createPatientPendingBooking({
      identity,
      doctorId,
      scheduledAt: fromZonedTime(`${date}T${time}:00`, identity.clinicTimezone).toISOString(),
      durationMinutes: DEFAULT_DURATION_MINUTES,
    });
  } catch {
    return intakeAsk({ identity, locale, step: input.step, outcome: "booking_blocked" });
  }

  if (result.ok) {
    await persist({
      identity,
      collected: null,
      patch: { submitted: true, tool: "deterministic_continuation", outcome: "booking_created" },
    });
    await trace(identity, "booking_created", 1);
    return {
      text: buildDeterministicPendingBookingReply({ locale, doctorName, date, time }),
      committed: "booking",
      outcome: "booking_created",
      step: input.step,
    };
  }

  // The one reason that is not a dead end and not a restart: the file is not
  // there yet. Ask for the fields, keep the target.
  if (result.reason === "intake_required") {
    return intakeAsk({ identity, locale, step: input.step, outcome: "intake_required" });
  }

  // A slot that lost its revalidation invalidates the *time*, and nothing above
  // it. Clearing the time drops the ladder exactly one rung.
  if (result.reason === "slot_unavailable" || result.reason === "minimum_notice") {
    await persist({
      identity,
      collected: { appointment_time: "" },
      patch: {
        collectedOverride: { appointment_time: "" },
        tool: "deterministic_continuation",
        outcome: "booking_blocked",
      },
    });
    const times = await availableTimes(identity, doctorId, date);
    return {
      text:
        buildDeterministicRevalidationReply({
          locale,
          reason: result.reason === "minimum_notice" ? "too_soon" : "slot_taken",
          doctorName,
        }) +
        " " +
        buildDeterministicTimesReply({ locale, doctorName, date, times }),
      committed: "none",
      outcome: "booking_blocked",
      step: input.step,
    };
  }

  await trace(identity, "booking_blocked", 0);
  return {
    text:
      locale === "ar"
        ? "معلش، مش قادر أكمّل طلب الحجز دلوقتي. تحب أوصلك بموظفي العيادة؟"
        : "Sorry — I cannot complete the booking request right now. Shall I pass you to clinic staff?",
    committed: "none",
    outcome: "booking_blocked",
    step: input.step,
  };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/**
 * Persist the department and offer its authoritative roster.
 *
 * The two writes mirror `prepare_booking` exactly: the collected fields go
 * through `set_conversation_ai_state`, and the stage record is advanced with
 * the same fields echoed as `collectedOverride` so the derived stage does not
 * lag one write behind.
 */
async function commitDepartment(input: {
  identity: ResolvedPatientAiContext;
  directory: DoctorDirectory;
  locale: "ar" | "en";
  department: NamedEntity;
  clearDoctor: boolean;
  outcome: "department_changed" | "roster_offered";
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, directory, department } = input;
  const roster = availableDoctorsInDepartment(directory, department.id);
  const text = buildDeterministicRosterReply({
    locale: input.locale,
    departmentName: department.name,
    doctors: roster.map((item) => item.name),
    departments: directory.departments.map((item) => item.name),
  });

  // A department change replaces everything chosen under the old department. A
  // re-offer of the same department changes nothing at all.
  const collected = {
    department_id: department.id,
    department_name: department.name,
    ...(input.clearDoctor
      ? { doctor_id: "", doctor_name: "", appointment_date: "", appointment_time: "" }
      : {}),
  };
  const ok = await persist({
    identity,
    collected,
    patch: {
      bookingIntent: true,
      tool: "deterministic_continuation",
      outcome: input.outcome,
      collectedOverride: collected,
      offeredDoctorIds: roster.map((item) => item.id),
    },
  });
  if (!ok) {
    // Bookkeeping must never break a reply: the sentence is already true, and
    // the next turn re-derives. Degrades to the old stateless behaviour.
    return { text, committed: "none", outcome: input.outcome, step: input.step };
  }
  await trace(identity, input.outcome, roster.length);
  return { text, committed: "department", outcome: input.outcome, step: input.step };
}

/** Re-offer the current department's roster, with a reason in front of it. */
async function reofferRoster(input: {
  identity: ResolvedPatientAiContext;
  directory: DoctorDirectory;
  locale: "ar" | "en";
  departmentId: string | null;
  departments: NamedEntity[];
  preface: string | null;
  outcome: "doctor_unavailable" | "doctor_changed";
  step: BookingStep;
}): Promise<RosterContinuation> {
  const department = input.departments.find((item) => item.id === input.departmentId);
  if (!department) {
    return await answerDepartmentStep({
      identity: input.identity,
      directory: input.directory,
      locale: input.locale,
      departments: input.departments,
      patientText: null,
      step: input.step,
    });
  }
  const roster = availableDoctorsInDepartment(input.directory, department.id);
  const body = buildDeterministicRosterReply({
    locale: input.locale,
    departmentName: department.name,
    doctors: roster.map((item) => item.name),
    departments: input.departments.map((item) => item.name),
  });
  // Both reasons invalidate the doctor and everything chosen under them.
  const collected = {
    doctor_id: "",
    doctor_name: "",
    appointment_date: "",
    appointment_time: "",
  };
  await persist({
    identity: input.identity,
    collected,
    patch: {
      bookingIntent: true,
      tool: "deterministic_continuation",
      outcome: input.outcome,
      collectedOverride: collected,
      offeredDoctorIds: roster.map((item) => item.id),
    },
  });
  await trace(input.identity, input.outcome, roster.length);
  return {
    text: input.preface ? `${input.preface} ${body}` : body,
    committed: "department",
    outcome: input.outcome,
    step: input.step,
  };
}

/**
 * Persist the doctor and answer with their real bookable days.
 *
 * This is the turn P11D existed for: the patient answered the roster question,
 * so the booking moves on and the patient is given days rather than being asked
 * the same question again.
 */
async function commitDoctor(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  departmentId: string;
  doctor: NamedEntity;
  outcome: "doctor_selected" | "doctor_changed";
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, doctor } = input;
  // A doctor change invalidates the day and the time chosen with the old one.
  const collected = {
    department_id: input.departmentId,
    doctor_id: doctor.id,
    doctor_name: doctor.name,
    ...(input.outcome === "doctor_changed"
      ? { appointment_date: "", appointment_time: "" }
      : {}),
  };
  const days = await availableDays(identity, doctor.id);
  const ok = await persist({
    identity,
    collected,
    patch: {
      bookingIntent: true,
      tool: "deterministic_continuation",
      outcome: input.outcome,
      collectedOverride: collected,
      ...(days.length > 0 ? { offeredDays: days } : {}),
    },
  });
  const text = buildDeterministicDaysReply({
    locale: input.locale,
    doctorName: doctor.name,
    days,
  });
  if (!ok) return { text, committed: "none", outcome: input.outcome, step: input.step };
  await trace(identity, input.outcome, days.length);
  return { text, committed: "doctor", outcome: input.outcome, step: input.step };
}

/** Persist the day and offer that day's real times. */
async function commitDay(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  doctorId: string;
  doctorName: string;
  date: string;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, locale } = input;
  const times = await availableTimes(identity, input.doctorId, input.date);
  const collected = { appointment_date: input.date };
  const ok = await persist({
    identity,
    collected,
    patch: {
      bookingIntent: true,
      tool: "deterministic_continuation",
      outcome: "day_selected",
      collectedOverride: collected,
      ...(times.length > 0 ? { offeredSlots: { date: input.date, times } } : {}),
    },
  });
  const text = buildDeterministicTimesReply({
    locale,
    doctorName: input.doctorName,
    date: input.date,
    times,
  });
  if (!ok) return { text, committed: "none", outcome: "day_selected", step: input.step };
  await trace(identity, "day_selected", times.length);
  return { text, committed: "day", outcome: "day_selected", step: input.step };
}

/**
 * Persist the time, then keep going in the same turn.
 *
 * The patient supplied the last thing the booking needed, so the reply is not
 * "noted" — it is either the pending booking or the precise list of intake
 * fields still standing between them and it. Re-deriving the ladder from the
 * *updated* collected state is what makes that one turn instead of two.
 */
async function commitTime(input: {
  identity: ResolvedPatientAiContext;
  locale: "ar" | "en";
  doctorId: string;
  doctorName: string;
  date: string;
  time: string;
  step: BookingStep;
}): Promise<RosterContinuation> {
  const { identity, locale } = input;
  const [hour, minute] = input.time.split(":").map(Number);
  const appointmentTime = hour * 60 + minute;
  const collected = { appointment_time: appointmentTime };
  const ok = await persist({
    identity,
    collected,
    patch: {
      bookingIntent: true,
      tool: "deterministic_continuation",
      outcome: "time_selected",
      collectedOverride: collected,
    },
  });
  if (!ok) {
    return {
      text:
        locale === "ar"
          ? "معلش، مقدرتش أحفظ اختيار الوقت دلوقتي. جرّب تبعته مرة تانية."
          : "Sorry, I could not save that time selection. Please send it again.",
      committed: "none",
      outcome: "time_commit_failed",
      step: input.step,
    };
  }
  await trace(identity, "time_selected", 1);

  // The identity snapshot was read before this write, so the next step is
  // derived from a copy that carries it. Same reason `collectedOverride`
  // exists on the stage patch.
  const advanced: ResolvedPatientAiContext = {
    ...identity,
    collectedData: { ...identity.collectedData, appointment_time: appointmentTime },
  };
  const next = nextBookingStep({
    collected: advanced.collectedData,
    linked: advanced.linked,
    bookingForOther: advanced.bookingStage.bookingForOther,
    intakeStaged: advanced.bookingStage.intakeStaged,
    submitted: advanced.bookingStage.submitted,
  });
  const forward =
    next === "confirm"
      ? await answerConfirmStep({ identity: advanced, locale, step: next })
      : intakeAsk({ identity: advanced, locale, step: next, outcome: "intake_required" });

  return {
    text: forward.text,
    committed: forward.committed === "booking" ? "booking" : "time",
    outcome: forward.outcome === "intake_required" ? "intake_required" : forward.outcome,
    step: input.step,
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** The offered ids, resolved to doctors who are still bookable right now. */
function offeredRoster(
  directory: DoctorDirectory,
  offeredIds: readonly string[],
): NamedEntity[] {
  const out: NamedEntity[] = [];
  for (const id of offeredIds) {
    const doctor = directory.doctors.find((item) => item.id === id);
    // A doctor deactivated or put on leave between turns stops being
    // selectable, exactly as they stop being offered. The offer record is a
    // record of what was said, never a licence to book somebody the directory
    // no longer lists as available.
    if (doctor && doctor.state === "available") out.push(toDoctorOption(doctor));
  }
  return out;
}

/** Does the text read as a time at all, without resolving to exactly one slot? */
function ambiguousAgainst(offered: readonly string[], patientText: string | null): boolean {
  const matches = candidateClockTimes(patientText ?? "").filter((time) =>
    offered.includes(time),
  );
  return matches.length > 1;
}

function dateOf(identity: ResolvedPatientAiContext): string | null {
  const value = identity.collectedData.appointment_date;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `appointment_time` is stored as minutes past midnight. Rendered as `HH:mm`. */
function timeOf(identity: ResolvedPatientAiContext): string | null {
  const value = identity.collectedData.appointment_time;
  if (typeof value === "string" && /^\d{2}:\d{2}$/.test(value)) return value;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function availableDays(
  identity: ResolvedPatientAiContext,
  doctorId: string,
): Promise<string[]> {
  try {
    const availability = await getPatientAvailableDays({
      identity,
      doctorId,
      durationMinutes: DEFAULT_DURATION_MINUTES,
    });
    return availability.ok ? availability.availableDays.map((day) => day.date) : [];
  } catch {
    return [];
  }
}

async function availableTimes(
  identity: ResolvedPatientAiContext,
  doctorId: string,
  date: string,
): Promise<string[]> {
  try {
    const availability = await getPatientAvailableSlots({
      identity,
      date,
      doctorId,
      durationMinutes: DEFAULT_DURATION_MINUTES,
    });
    return availability.ok ? availability.availableSlots : [];
  } catch {
    return [];
  }
}

/**
 * The two writes, together, and never fatal.
 *
 * Returns false when either failed, which every caller reads as "say the true
 * sentence anyway and let the next turn re-derive" — the P11D degradation, kept.
 */
async function persist(input: {
  identity: ResolvedPatientAiContext;
  collected: Record<string, string | number> | null;
  patch: Parameters<typeof recordStageTurn>[1];
}): Promise<boolean> {
  try {
    if (input.collected) {
      const write = await setConversationAiState({
        clinicId: input.identity.clinicId,
        conversationId: input.identity.conversationId,
        collected: input.collected,
      });
      if (write?.error) return false;
    }
    await recordStageTurn(input.identity, input.patch);
    return true;
  } catch {
    return false;
  }
}

/** One privacy-safe line. Labels and a count; no name ever reaches this. */
async function trace(
  identity: ResolvedPatientAiContext,
  outcome: string,
  count: number,
): Promise<void> {
  try {
    await logAgentTool({
      clinicId: identity.clinicId,
      actorId: null,
      tool: "patient_roster_continuation",
      params: { outcome, count },
    });
  } catch {
    // Never break a reply for a trace.
  }
}
