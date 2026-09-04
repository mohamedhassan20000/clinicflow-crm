/**
 * P11G — the tool-necessity contract.
 *
 * ## The defect this exists for
 *
 * The hosted audit for turns 32–42 of one production conversation records
 * `tool_called: "none"` on every single turn. The investigation in
 * `docs/reviews/P11G_PATIENT_BOOKING_TOOL_EXECUTION_ARCHITECTURE.md` proves
 * that the tools were mounted, narrowed correctly per stage, present in the
 * final provider request, and offered under `toolChoice: auto` — nothing
 * structural withheld them. Two things withheld the *call*:
 *
 *   1. **The reconstructed history contains no tool evidence.** `loadHistory`
 *      rebuilds the turn from `inbound_messages` and `outbound_messages`, so
 *      every prior assistant turn — including the ones the deterministic
 *      continuation composed — appears as plain prose that answered a booking
 *      question with no tool call. The strongest in-context pattern is
 *      therefore "in this conversation the assistant answers from prose", and
 *      the fallback rewrites that pattern one turn stronger every time it
 *      rescues a turn.
 *   2. **The stage banner disagreed with the ladder.** `deriveStage` puts
 *      intake before the calendar, so a new or third-party booking sits in
 *      `intake_collecting` for the whole day-and-time window while
 *      `nextBookingStep` says `day` or `time`. The banner the model reads said
 *      "collect the missing personal details" for eleven consecutive turns on
 *      which the patient was choosing a day and a time.
 *
 * Neither is fixed by asking the model harder, and neither is fixed by forcing
 * a tool on every turn. What was missing is a *server-computed statement of
 * which authoritative operation this turn needs* — one value, derived from the
 * same ladder the deterministic continuation already trusts, that can be said
 * to the model in one sentence, enforced through `toolChoice` for exactly the
 * turns that need it, and audited.
 *
 * ## Three properties
 *
 * **Pure.** No database, no clock, no `server-only`. Every function is a total
 * function of its arguments, so the whole contract is a table.
 *
 * **It carries no authority.** Nothing here can mount a tool, unlock a stage,
 * clear a collected field or authorize anything. It reads server-owned state
 * and returns a label. `allowedToolsForStage` still decides what is callable,
 * every tool still re-resolves identity, and `checkOfferedSlot` still decides
 * what may be booked.
 *
 * **It subtracts calls as readily as it adds them.** A requirement that is
 * already satisfied by a committed, still-valid server offer resolves to
 * `none` — so a conversation holding an authoritative roster, an authoritative
 * day list or an authoritative slot list does not call the tool that produced
 * it a second time. See `satisfied` on the result.
 */

import type { CollectedData } from "@/lib/ai/collected-state";
import type { BookingStep } from "@/lib/ai/booking-stage";

/**
 * How much authority this turn needs before it may answer.
 *
 *   * `none` — the answer is conversational, or the authoritative result this
 *     turn needs is already committed and still valid.
 *   * `read_authority` — a clinic-state fact (roster, days, times) must come
 *     from the server on this turn.
 *   * `write_authority` — the turn reaches the booking-creation boundary.
 */
export type AuthorityRequirement = "none" | "read_authority" | "write_authority";

/** Why the requirement resolved the way it did. Closed set, for the audit. */
export type AuthorityReason =
  | "conversational"
  | "closing"
  | "terminal"
  | "committed_roster"
  | "committed_days"
  | "committed_slots"
  | "needs_clinic_directory"
  /**
   * F-9 — the patient asked to cancel. The turn owes them their own
   * appointments, not the first rung of a new booking.
   */
  | "needs_appointments"
  | "needs_reschedule_target"
  | "needs_reschedule_availability"
  | "needs_reschedule_confirmation"
  | "needs_reschedule"
  | "needs_departments"
  /**
   * F-10 — the patient asked who else there is, on a turn the ladder had
   * already moved past the doctor rung.
   */
  | "needs_roster_continuation"
  | "needs_roster"
  | "needs_days"
  | "needs_slots"
  | "needs_intake"
  | "needs_booking_confirmation"
  | "needs_booking"
  /** F-2 — the latest answer was ambiguous and the server owes a question. */
  | "needs_clarification"
  /** F-6 — the latest answer resolved nothing; the offer must be re-stated. */
  | "reoffer";

export type BookingAuthority = {
  requirement: AuthorityRequirement;
  /** The tool that satisfies it, or null when nothing is required. */
  operation: string | null;
  reason: AuthorityReason;
  /** True when an authoritative result is already committed and still valid. */
  satisfied: boolean;
  /** The ladder step this authority was computed for. */
  step: BookingStep;
  /**
   * F-2 — the competing readings the server must ask about, in the order they
   * were offered. Non-empty only when `reason` is `needs_clarification`.
   *
   * Always a subset of what a server tool already put in front of this patient
   * — `resolveOfferedDoctor` is closed over the offered roster and cannot
   * return anybody else — so composing a reply from it can never name somebody
   * the conversation has not already seen.
   */
  clarificationCandidates?: readonly { id: string; name: string }[];
};

export type BookingAuthorityFacts = {
  /** The ladder step, from `nextBookingStep`. Never re-derived here. */
  step: BookingStep;
  collected: CollectedData;
  /** Doctor ids a server tool actually presented on an earlier turn. */
  offeredDoctorIds: readonly string[];
  /** Days a server tool actually presented, `YYYY-MM-DD`. */
  offeredDays: readonly string[];
  /** Slots a server tool actually presented, `YYYY-MM-DDTHH:mm`. */
  offeredSlots: readonly string[];
  /** The patient's message is a bare closing ("شكراً", "thanks, bye"). */
  closing: boolean;
  /** This conversation is escalated or already submitted. */
  terminal: boolean;
  /** The patient asked for the clinic-wide directory, not the booking target. */
  clinicDirectoryQuery?: boolean;
  /**
   * F-4 — this message is a clinic-information question the server can prove,
   * and this thread is not already booking.
   *
   * Read from `isClinicInformationQuestion`, and used only to *withhold* the
   * `department` pin. See that module for why the ladder alone cannot answer
   * "is this turn a booking?".
   */
  clinicInformationQuery?: boolean;
  /**
   * F-4 — this conversation is actually working through a booking, as opposed
   * to merely sitting at the ladder's first rung because it has collected
   * nothing. Server-owned: the stage latch and the collected fields, never the
   * sentence.
   */
  bookingIntent?: boolean;
  /**
   * V2-CONTAINMENT — **this turn** asked to book.
   *
   * Read from the turn classifier's `topic === "booking"` (or an explicit
   * availability/booking request), never from collected state and never from
   * durable memory. It is the positive evidence the `department` rung now
   * requires before it may pin `prepare_booking`.
   *
   * Deliberately separate from `bookingIntent`: that one answers "is this
   * conversation already booking?", which durable state can make true. This
   * one answers "did the patient just ask to book?", which only the current
   * message can. Conflating them is what allowed a greeting on a thread with
   * an old doctor in it to open a calendar.
   */
  bookingOpening?: boolean;
  /**
   * F-2 — the answer the patient just gave matched more than one offered
   * option, and the server has not committed anything.
   *
   * Set by the pre-commit (`commitLatestOfferedSelection`) from
   * `resolveOfferedDoctor`'s own `ambiguous` verdict. It is the fact that used
   * to be computed and then thrown away.
   */
  pendingSelection?: {
    field: "doctor";
    candidates: readonly { id: string; name: string }[];
  } | null;
  /**
   * F-6 — the patient answered the day or time question and the server could
   * resolve nothing from it.
   *
   * Without this, a day/time step holding a still-valid offer reports
   * `satisfied` and nothing is pinned, so a turn the pre-commit could not read
   * produces no tool call and no question: the booking deadlocks silently. With
   * it, the authority falls back to the read that re-states the offer.
   */
  unresolvedAnswer?: boolean;
  /**
   * F-9 — this message asks to cancel an existing appointment.
   *
   * Read from `detectCancellationIntent`, server-side, before the ladder. It
   * changes only *which read* the turn is pinned to; it authorizes nothing.
   * `cancel_my_appointment` keeps every check it has, and this never pins it.
   */
  cancellationRequest?: boolean;
  /**
   * F-9 — the thread's own number selects a patient file.
   *
   * A cancellation request from an unlinked thread has no appointment list to
   * read, so the pin is withheld and the ordinary ladder answers: the identity
   * path (`lookup_appointment`) is stage-independent and stays reachable.
   */
  linked?: boolean;
  /**
   * F-10 — this message asks who *else* there is: "في دكاترة غيره؟", "are
   * there other doctors?", "مين تاني متاح؟".
   *
   * Read from `isRosterQuestion`, server-side. It matters only once a
   * department is settled, which is exactly the case the ladder cannot serve:
   * the booking has moved on to the day or the time, so the authority pinned
   * the calendar read and the roster question was answered by whatever the
   * model felt like saying — in the live run, by restarting the funnel and
   * asking which department the patient wanted.
   */
  rosterQuestion?: boolean;
  /** The patient explicitly confirmed the deterministic final summary. */
  explicitBookingConfirmation?: boolean;
  /** The patient is asking about changing an existing request. */
  appointmentChangeRequest?: boolean;
  /** A server-verified pending-request proposal carried between turns. */
  appointmentChange?: { selectedTime: boolean } | null;
};

const NONE = (step: BookingStep, reason: AuthorityReason, satisfied = false): BookingAuthority => ({
  requirement: "none",
  operation: null,
  reason,
  satisfied,
  step,
});

/**
 * The authoritative operation this turn needs, if any.
 *
 * The ordering matters and is deliberately defensive: `terminal` and `closing`
 * are checked before the ladder, so a patient who says "شكراً" mid-booking is
 * never answered with a forced tool call. That is the §3 requirement, and it is
 * the reason this returns `none` rather than the caller having to special-case
 * it.
 */
export function resolveBookingAuthority(
  facts: BookingAuthorityFacts,
): BookingAuthority {
  const { step } = facts;
  if (facts.closing) return NONE(step, "closing");
  // P11I — message scope outranks booking progress. A selected department is
  // authority for the booking target only; it cannot redefine a clinic-wide
  // fact. This read is valid even after a booking has been submitted.
  if (facts.clinicDirectoryQuery) {
    return {
      requirement: "read_authority",
      operation: "list_clinic_departments",
      reason: "needs_clinic_directory",
      satisfied: false,
      step,
    };
  }
  if (facts.appointmentChange) {
    if (!facts.appointmentChange.selectedTime) {
      return {
        requirement: "read_authority",
        operation: "check_reschedule_availability",
        reason: "needs_reschedule_availability",
        satisfied: false,
        step,
      };
    }
    if (facts.explicitBookingConfirmation !== true) {
      return NONE(step, "needs_reschedule_confirmation");
    }
    return {
      requirement: "write_authority",
      operation: "reschedule_my_appointment",
      reason: "needs_reschedule",
      satisfied: false,
      step,
    };
  }

  if (facts.appointmentChangeRequest === true && facts.linked !== false) {
    return {
      requirement: "read_authority",
      operation: "list_my_appointments",
      reason: "needs_reschedule_target",
      satisfied: false,
      step,
    };
  }

  // F-9 — a cancellation is not the first rung of a booking.
  //
  // Checked before the ladder for the same reason `closing` is: the ladder
  // describes where a *booking* has got to, and this message is not about one.
  // Without it, a thread that has collected nothing resolves `department` and
  // pins `prepare_booking`, which is how two live cancellation cases reached
  // the end of the conversation without `list_my_appointments` ever running.
  //
  // The pin is the *read*. Nothing here cancels anything, and
  // `cancel_my_appointment` is never the pinned operation: its ownership check,
  // identity check and confirmation are unchanged.
  if (
    facts.cancellationRequest === true &&
    facts.linked !== false
  ) {
    return {
      requirement: "read_authority",
      operation: "list_my_appointments",
      reason: "needs_appointments",
      satisfied: false,
      step,
    };
  }

  if (facts.terminal) return NONE(step, "terminal");

  // F-10 — "are there other doctors?" continues the roster it is asking about.
  //
  // Only once a department is settled: with no department there is no roster to
  // continue, and the ordinary `department` rung is the correct answer. Beyond
  // that rung the ladder would pin the calendar read, which is what turned a
  // roster question into a restart of the funnel in the live run.
  if (
    facts.rosterQuestion === true &&
    readString(facts.collected.department_id) !== null &&
    step !== "department" &&
    step !== "done"
  ) {
    return {
      requirement: "read_authority",
      operation: "list_doctors",
      reason: "needs_roster_continuation",
      satisfied: false,
      step,
    };
  }

  // F-2 — an ambiguous answer is a question the *server* owes the patient.
  //
  // `resolveOfferedDoctor` had already computed this verdict and the pre-commit
  // discarded it, so the only thing standing between a patient who typed "دكتور
  // احم" and a clarification was the deployed model's judgement — against a
  // prompt that told it the step's data was settled and not to re-read it.
  // Nothing is pinned here (the tool would re-state the whole roster rather than
  // the two competing readings) and nothing is marked satisfied: the reply gate
  // composes the question from `clarificationCandidates`, which are members of
  // the offered set by construction.
  const pending = facts.pendingSelection ?? null;
  if (pending && pending.candidates.length > 1 && step === pending.field) {
    return {
      requirement: "none",
      operation: null,
      reason: "needs_clarification",
      satisfied: false,
      step,
      clarificationCandidates: pending.candidates,
    };
  }

  switch (step) {
    case "department":
      // V2-CONTAINMENT — the default at this rung is inverted, and that
      // inversion is the fix for the «عندي استفسار» failure rather than a
      // further exception to the old one.
      //
      // The rung used to be *allow-by-default*: `prepare_booking` was pinned
      // unless a hand-written reader could prove the message was something
      // else. `nextBookingStep` reports `department` for every thread that has
      // collected nothing — including a thread whose patient has only said
      // hello — so an unrecognised Arabic phrasing was answered by pinning the
      // opening move of a booking. `prepare_booking` then read the patient's
      // treating doctor out of appointment history, and the conversation was
      // committed to a booking nobody asked for.
      //
      // `clinicInformationQuery` was the escape hatch built on top of that
      // default, and it could only ever cover shapes somebody had already
      // seen fail. Natural language has no such finite set.
      //
      // So the burden of proof moves. The pin now requires *positive evidence*
      // that this turn is a booking:
      //
      //   * `bookingOpening` — the current turn actually asked to book, read
      //     from the turn classifier, not from durable state; or
      //   * `bookingIntent` — this conversation is genuinely mid-booking, which
      //     at this rung can only come from a latch a previous turn set.
      //
      // Absent both, the correct answer is `conversational`: no forced tool, no
      // history read, no state. The model still has the read-only mount and can
      // answer or ask what the patient wants — which is what a receptionist
      // does with "I have a question".
      //
      // The old `clinicInformationQuery` short-circuit is retained below it as
      // a *narrowing* clause only, so a proven information question cannot be
      // pinned even if a future caller sets `bookingOpening` too eagerly.
      if (facts.clinicInformationQuery === true && facts.bookingIntent !== true) {
        return NONE(step, "conversational");
      }
      if (facts.bookingOpening !== true && facts.bookingIntent !== true) {
        return NONE(step, "conversational");
      }
      // The department list is clinic state and there is no record of a
      // department offer, so this is always a fresh read.
      return {
        requirement: "read_authority",
        operation: "prepare_booking",
        reason: "needs_departments",
        satisfied: false,
        step,
      };
    case "doctor":
      if (facts.offeredDoctorIds.length > 0) {
        return NONE(step, "committed_roster", true);
      }
      return {
        requirement: "read_authority",
        operation: "list_doctors",
        reason: "needs_roster",
        satisfied: false,
        step,
      };
    case "day":
      // F-6 — a committed offer the patient has just answered *unreadably* is
      // not a satisfied requirement, it is a stalled turn. Re-read so the offer
      // is put in front of them again rather than saying nothing at all.
      if (facts.offeredDays.length > 0 && facts.unresolvedAnswer !== true) {
        return NONE(step, "committed_days", true);
      }
      return {
        requirement: "read_authority",
        operation: "list_available_days",
        reason: facts.offeredDays.length > 0 ? "reoffer" : "needs_days",
        satisfied: false,
        step,
      };
    case "time": {
      // Slots are only authoritative for the day this booking actually holds.
      // A slot list offered for the 28th says nothing about the 31st, which is
      // exactly the substitution the offered-slot guard exists to refuse.
      const date = readString(facts.collected.appointment_date);
      const hasSlotsForDate =
        date !== null &&
        facts.offeredSlots.some((slot) => slot.startsWith(`${date}T`));
      // F-6, one rung up: same rule, same reason.
      if (hasSlotsForDate && facts.unresolvedAnswer !== true) {
        return NONE(step, "committed_slots", true);
      }
      return {
        requirement: "read_authority",
        operation: "check_availability",
        reason: hasSlotsForDate ? "reoffer" : "needs_slots",
        satisfied: false,
        step,
      };
    }
    case "intake":
      // P11H — collecting the fields is conversational; staging them is not.
      // By the time the monotonic ladder reaches this rung, department, doctor,
      // day and time are established. `register_patient` accepts a partial call
      // and returns the exact missing fields without writing, so pinning it here
      // cannot pressure the model to invent values. It either returns the
      // staged intake entity or an explicit non-success result.
      return {
        requirement: "write_authority",
        operation: "register_patient",
        reason: "needs_intake",
        satisfied: false,
        step,
      };
    case "confirm":
      if (facts.explicitBookingConfirmation !== true) {
        return NONE(step, "needs_booking_confirmation");
      }
      return {
        requirement: "write_authority",
        operation: "create_preliminary_booking",
        reason: "needs_booking",
        satisfied: false,
        step,
      };
    case "done":
    default:
      return NONE(step, "terminal");
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether this turn should be *made* to call the operation.
 *
 * Three conditions, all of them server-side facts:
 *
 *   * an operation is genuinely required and not already satisfied;
 *   * the operation is actually mounted for this stage — a contract that could
 *     name a tool the stage table hides would be a contract that deadlocks the
 *     turn, and `allowedToolsForStage` stays the only thing that decides what
 *     is callable;
 *   * this is the first step of the turn. Forcing on later steps would make a
 *     tool loop that cannot terminate.
 *
 * Read authority and write authority are both forced. The write is not a
 * semantic decision: by the time the ladder says `confirm`, the department,
 * doctor, day, time and intake are all established and validated server-side,
 * and `createPatientPendingBooking` re-validates the slot regardless. See §11
 * of the phase report for why the boundary is unchanged by this.
 */
export function shouldForceAuthority(input: {
  authority: BookingAuthority;
  mountedTools: readonly string[];
  stepNumber: number;
}): boolean {
  const { authority } = input;
  if (authority.requirement === "none" || authority.satisfied) return false;
  if (!authority.operation) return false;
  if (input.stepNumber !== 0) return false;
  return input.mountedTools.includes(authority.operation);
}

/**
 * One sentence naming the authoritative operation, in the turn's language.
 *
 * Deliberately one line. The prompt is already ~10 KB and the P9 split exists
 * because a small model's attention is the scarce resource here; the fix for
 * "the model answered from prose" is not more prose.
 *
 * Returns null when there is nothing to say, so an unremarkable turn's prompt
 * is byte-for-byte what it was before this phase.
 */
export function bookingAuthorityInstruction(
  locale: "ar" | "en",
  authority: BookingAuthority,
): string | null {
  if (authority.requirement === "none") {
    if (authority.reason === "needs_booking_confirmation") {
      return locale === "ar"
        ? "كل تفاصيل الطلب مكتملة، لكن لا تنشئ الطلب بعد. اعرض ملخص التأكيد الذي يجهزه النظام وانتظر موافقة صريحة من المريض في رسالة لاحقة."
        : "All request details are complete, but do not create it yet. Present the server-provided confirmation summary and wait for the patient's explicit confirmation in a later message.";
    }
    if (authority.reason === "needs_reschedule_confirmation") {
      return locale === "ar"
        ? "موعد التغيير المقترح متاح ومسجل من النظام، لكن لا تغيّر الطلب بعد. اعرض الطبيب والتاريخ والوقت بصيغة محلية، ووضّح أن الطلب سيظل منتظر التأكيد، ثم انتظر موافقة صريحة في رسالة لاحقة."
        : "The proposed replacement slot is available and server-recorded, but do not change the request yet. Show the doctor, localized date and time, say it will remain pending, and wait for explicit confirmation in a later message.";
    }
    // F-2 — the one `none` that has something to say. The server has already
    // decided the answer was ambiguous; the model's job is to ask, not to pick,
    // and the reply gate will replace the sentence if it does anything else.
    if (authority.reason === "needs_clarification") {
      const names = (authority.clarificationCandidates ?? []).map((item) => item.name);
      if (names.length < 2) return null;
      return locale === "ar"
        ? `إجابة المريض تحتمل أكثر من قراءة: ${names.join(" أو ")}. اسأله سؤالًا واحدًا قصيرًا يحدد أي واحد يقصد، واذكر هذه الأسماء وحدها. لا تختار نيابة عنه ولا تبدأ الحجز من أوله.`
        : `The patient's answer has more than one reading: ${names.join(" or ")}. Ask one short question naming exactly these and no others. Do not choose for them and do not restart the booking.`;
    }
    if (!authority.satisfied) return null;
    // P11I-R — scoped to the booking step on purpose. The unscoped form of
    // this sentence told the model not to call anything, which suppressed the
    // read-only tool that answers a side question the server did not prove.
    return locale === "ar"
      ? "بيانات خطوة الحجز الحالية معروضة عليك بالفعل من النظام وما زالت صالحة، فأجب منها ولا تستدعِ أداة الحجز نفسها من جديد. وإن كان سؤال المريض عن شيء آخر (مثل معلومات العيادة أو أقسامها بالكامل) فاستدعِ الأداة القرائية المناسبة له."
      : "The server data for the current booking step is already in front of you and still valid: answer from it and do not call that booking tool again. If the patient asked about something else (clinic information, or the clinic's full list of departments), call the read-only tool that answers it instead.";
  }
  if (!authority.operation) return null;
  if (authority.reason === "needs_clinic_directory") {
    return locale === "ar"
      ? "هذا سؤال عن دليل أقسام العيادة بالكامل، وليس عن القسم المختار للحجز. استدعِ list_clinic_departments أولًا في هذا الدور، ثم اذكر كل الأقسام التي أعادتها فقط. لا تغيّر حالة الحجز ولا تذكر الأطباء."
      : "This is a clinic-wide department-directory question, not a question about the selected booking department. Call list_clinic_departments first on this turn, then name every department it returned and no others. Do not change booking state or list doctors.";
  }
  if (authority.reason === "needs_appointments") {
    // F-9 — one read, then a question. The cancellation itself keeps every
    // protection it has, and this sentence deliberately does not ask for it.
    return locale === "ar"
      ? "المريض طلب إلغاء موعد قائم. استدعِ list_my_appointments أولًا في هذا الدور، ثم اذكر المواعيد التي أعادتها وحدها واسأله أي واحد يقصد. لا تلغِ أي شيء قبل ما يأكد لك الموعد المقصود، ولا تبدأ حجزًا جديدًا ولا تسأل عن قسم."
      : "The patient asked to cancel an existing appointment. Call list_my_appointments first on this turn, then name only the appointments it returned and ask which one they mean. Do not cancel anything before they confirm which one, do not start a new booking, and do not ask about a department.";
  }
  if (authority.reason === "needs_reschedule_target") {
    return locale === "ar"
      ? "المريض طلب تغيير طلب حجز قائم. استدعِ list_my_appointments أولًا، وحدد الطلب المنتظر المقصود من النتيجة، ثم استدعِ check_reschedule_availability للتاريخ والوقت المطلوبين. لا تنشئ طلبًا جديدًا ولا تغيّر شيئًا في هذا الدور."
      : "The patient asked to change an existing request. Call list_my_appointments first, identify the pending request from that result, then call check_reschedule_availability for the requested date/time. Do not create a new request or mutate anything on this turn.";
  }
  if (authority.reason === "needs_reschedule_availability") {
    return locale === "ar"
      ? "هناك طلب تغيير قائم لموعد منتظر. استدعِ check_reschedule_availability أولًا باستخدام الطلب الذي سجله النظام، واعرض الأوقات المتاحة فقط. لا تبدأ حجزًا جديدًا ولا تغيّر الطلب قبل موافقة صريحة لاحقة."
      : "There is an active pending-request change. Call check_reschedule_availability first using the server-recorded request and show only returned slots. Do not start a new booking or mutate before a later explicit confirmation.";
  }
  if (authority.reason === "needs_roster_continuation") {
    // F-10 — the patient asked who else there is. The department is settled and
    // stays settled; this is a continuation of the roster, not a restart.
    return locale === "ar"
      ? "المريض بيسأل عن دكاترة تانيين في نفس القسم اللي اختاره بالفعل. استدعِ list_doctors أولًا في هذا الدور، ثم اذكر كل الأسماء اللي رجّعتها وحدها واسأله يختار. القسم متحدد خلاص: ما تسألش عن القسم تاني وما تبدأش الحجز من أوله."
      : "The patient is asking about other doctors in the department this conversation has already settled. Call list_doctors first on this turn, then name every doctor it returned and no others, and ask which one they want. The department is already chosen: do not ask which department, and do not restart the booking.";
  }
  if (authority.requirement === "write_authority") {
    if (authority.reason === "needs_reschedule") {
      return locale === "ar"
        ? "المريض وافق صراحة على ملخص التغيير. استدعِ reschedule_my_appointment بلا أي مدخلات لكي تستخدم الأداة الطلب والموعد اللذين سجلهما الخادم. لا تقل إن التغيير تم إلا إذا أكدت الأداة نجاح الاستبدال."
        : "The patient explicitly approved the change summary. Call reschedule_my_appointment with no inputs so it uses the server-recorded request and slot. Do not claim the change succeeded unless the tool confirms the atomic replacement.";
    }
    if (authority.reason === "needs_booking") {
      return locale === "ar"
        ? "المريض وافق صراحة على الملخص. استدعِ create_preliminary_booking بلا تاريخ أو وقت جديدين لكي تستخدم الأداة الاختيار الذي ثبّته الخادم. لا تفسّر رسالة الموافقة كموعد جديد، ولا تقل إن الطلب أُنشئ إلا إذا أعادت الأداة الكيان الذي أنشأه الخادم."
        : "The patient explicitly approved the summary. Call create_preliminary_booking without a new date or time so the tool uses the server-committed selection. Do not reinterpret the confirmation message as scheduling data, and never claim creation unless the tool returns the server-created entity.";
    }
    return locale === "ar"
      ? `هذه الخطوة تحتاج كتابة موثوقة في النظام. استدعِ ${authority.operation} أولًا في هذا الدور. لا تقل إن ملفًا أو طلب حجز أُنشئ إلا إذا أعادت الأداة الكيان الذي أنشأه الخادم.`
      : `This step needs an authoritative system write. Call ${authority.operation} first on this turn. Never say a file or booking request was created unless the tool returns the entity created by the server.`;
  }
  if (authority.reason === "reoffer") {
    // F-6 — the patient answered and the server could read nothing from it.
    // Saying nothing is the worst available option, so the offer is re-stated.
    return locale === "ar"
      ? `الرد الأخير للمريض ما اتقراش كاختيار من اللي اتعرض عليه. استدعِ ${authority.operation} أولًا في هذا الدور، ثم اعرض عليه الخيارات المتاحة تاني واسأله يختار واحد منها. لا تفترض اختيارًا ولا تبدأ الحجز من أوله.`
      : `The patient's last answer could not be read as a choice from what they were shown. Call ${authority.operation} first on this turn, put the available options in front of them again, and ask them to pick one. Do not assume a choice and do not restart the booking.`;
  }
  return locale === "ar"
    ? `هذه الخطوة تحتاج بيانات حيّة من العيادة. استدعِ ${authority.operation} أولًا في هذا الدور، ثم أجب من نتيجتها وحدها. لا تذكر طبيبًا أو يومًا أو وقتًا لم يعده لك.`
    : `This step needs live clinic data. Call ${authority.operation} first on this turn and answer only from its result. Never state a doctor, a day or a time it did not return.`;
}
