/**
 * P9 — multi-turn booking scenarios, and the simulator that runs them.
 *
 * The P6A corpus (`eval-set.ts`) is one turn per case, which is the right shape
 * for "did the model reach for the right tool?" and the wrong shape for every
 * metric the architecture study actually asks for. Repeated questions, flow
 * restarts and "other doctors" are all *sequence* failures: they cannot be
 * observed in a single turn, because the thing that goes wrong is the second
 * turn contradicting the first.
 *
 * So this module adds the missing axis. It is deliberately built from the same
 * pieces as the product rather than beside them:
 *
 *   * the **real** `booking-stage.ts` machine drives the simulated state, so a
 *     scenario measures the stage logic that ships, not a copy of it;
 *   * the **real** tool names and result shapes are reproduced, so the model
 *     sees the payloads and the `guidance` strings it sees in production;
 *   * the clinic is a fixture rather than a database, so a run is deterministic
 *     across models and the only variable is the model, the step budget and the
 *     orchestration mode.
 *
 * What this is **not** is an end-to-end test. It exercises L2 — prompt, model,
 * tool schemas, stage scoping. `authorizePatientConversation`, RLS, the
 * entitlement checks, the identity RPCs and the availability engine are not in
 * the loop, and are covered by their own suites. That boundary is stated here
 * rather than in a footnote because a metric is only worth as much as the
 * honesty of the thing that produced it.
 *
 * Pure data and pure functions: no `server-only`, no imports with side effects.
 */

import {
  advanceStage,
  deriveStage,
  EMPTY_BOOKING_STAGE_STATE,
  recordOfferedDays,
  recordOfferedDoctors,
  recordOfferedSlots,
  checkOfferedSlot,
  type BookingStage,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import type { CollectedData } from "@/lib/ai/collected-state";

// ---------------------------------------------------------------------------
// The fixture clinic
// ---------------------------------------------------------------------------

export type FixtureDoctor = {
  id: string;
  name: string;
  departmentId: string;
};

export type FixtureDepartment = { id: string; name: string };

const DERM = "aaaaaaaa-0000-4000-8000-000000000001";
const DENT = "aaaaaaaa-0000-4000-8000-000000000002";

export const FIXTURE_DEPARTMENTS: readonly FixtureDepartment[] = [
  { id: DERM, name: "Dermatology" },
  { id: DENT, name: "Dentistry" },
];

export const FIXTURE_DOCTORS: readonly FixtureDoctor[] = [
  { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "Ahmed Nabil", departmentId: DERM },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Sara Ali", departmentId: DERM },
  { id: "bbbbbbbb-0000-4000-8000-000000000003", name: "Mohamed Khaled", departmentId: DERM },
  { id: "bbbbbbbb-0000-4000-8000-000000000004", name: "Laila Fouad", departmentId: DENT },
];

/** Three real days, far enough out to clear the 24-hour rule. */
export const FIXTURE_DAYS: readonly string[] = ["2026-09-07", "2026-09-08", "2026-09-10"];
export const FIXTURE_SLOTS: readonly string[] = ["10:00", "10:30", "11:00"];

export const FIXTURE_CLINIC = {
  name: "Nile Care Clinic",
  phone: "+20 2 1234 5678",
  address: "12 Corniche El Nil, Cairo",
  timezone: "Africa/Cairo",
  workingHours: "Sunday to Thursday, 09:00 to 17:00",
} as const;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type ScenarioPatient = {
  /** A phone-linked, verified existing patient, or a stranger. */
  linked: boolean;
  identityVerified: boolean;
  /** Only meaningful when linked. Drives the treating-doctor opening. */
  treatingDoctorId?: string;
};

export type BookingScenario = {
  id: string;
  locale: "en" | "ar";
  /** What the scenario is testing, in one line, for the report. */
  intent: string;
  patient: ScenarioPatient;
  /** The patient's messages, in order. One agent run per message. */
  turns: readonly string[];
  /**
   * The metrics this scenario is *designed* to produce a signal for. A metric
   * not listed here is still computed, but this scenario is not evidence for it.
   */
  measures: readonly ScenarioMetric[];
  /**
   * Fields the assistant must never ask for again once established, keyed by
   * the turn index from which the ban applies.
   */
  noReAsk?: Readonly<Record<number, readonly ReAskTopic[]>>;
};

export type ScenarioMetric =
  | "repeated_question"
  | "flow_restart"
  | "other_doctors"
  | "booking_completion"
  | "turns_to_booking"
  | "technical_fallback"
  | "unnecessary_escalation"
  | "offered_slot_integrity";

export type ReAskTopic = "department" | "doctor" | "day" | "phone";

const LINKED_VERIFIED: ScenarioPatient = {
  linked: true,
  identityVerified: true,
  treatingDoctorId: FIXTURE_DOCTORS[0]!.id,
};

const STRANGER: ScenarioPatient = { linked: false, identityVerified: false };

export const BOOKING_SCENARIOS: readonly BookingScenario[] = [
  {
    id: "scn-other-doctors-en",
    locale: "en",
    intent:
      "The reported bug in its purest form: a treating-doctor opening followed by " +
      "'are there other doctors?'. The follow-up must produce the rest of the roster " +
      "without re-asking the department and without restarting the booking.",
    patient: LINKED_VERIFIED,
    turns: [
      "Hi, I would like to book an appointment please.",
      "Are there other doctors?",
      "Then Sara Ali please.",
    ],
    measures: ["other_doctors", "flow_restart", "repeated_question"],
    noReAsk: { 1: ["department"], 2: ["department", "doctor"] },
  },
  {
    id: "scn-other-doctors-ar",
    locale: "ar",
    intent: "The same sequence in Egyptian Arabic, which is how it was reported.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز معاد لو سمحت.", "في دكاترة غيره؟", "طب د. سارة علي.",],
    measures: ["other_doctors", "flow_restart", "repeated_question"],
    noReAsk: { 1: ["department"], 2: ["department", "doctor"] },
  },
  {
    id: "scn-full-booking-en",
    locale: "en",
    intent:
      "A whole booking, end to end, for a verified patient who names a department " +
      "rather than taking the treating doctor. Produces booking completion and " +
      "turns-to-booking.",
    patient: { linked: true, identityVerified: true },
    turns: [
      "I need a dermatology appointment.",
      "Mohamed Khaled.",
      "The first day you have.",
      "The 10 o'clock one.",
    ],
    measures: [
      "booking_completion",
      "turns_to_booking",
      "repeated_question",
      "flow_restart",
    ],
    noReAsk: { 1: ["department"], 2: ["department", "doctor"], 3: ["department", "doctor", "day"] },
  },
  {
    id: "scn-full-booking-ar",
    locale: "ar",
    intent: "The same end-to-end booking in Arabic.",
    patient: { linked: true, identityVerified: true },
    turns: [
      "محتاج معاد في الجلدية.",
      "د. محمد خالد.",
      "أول يوم متاح.",
      "الساعة عشرة.",
    ],
    measures: [
      "booking_completion",
      "turns_to_booking",
      "repeated_question",
      "flow_restart",
    ],
    noReAsk: { 1: ["department"], 2: ["department", "doctor"], 3: ["department", "doctor", "day"] },
  },
  {
    id: "scn-fragmented-en",
    locale: "en",
    intent:
      "The answer arriving in pieces, with a correction in the middle. The " +
      "department must survive the correction; the day must be re-asked once and " +
      "only once.",
    patient: { linked: true, identityVerified: true },
    turns: [
      "book me with dermatology",
      "sara",
      "the 8th",
      "no sorry, the 10th",
      "10:30",
    ],
    measures: ["repeated_question", "flow_restart", "booking_completion"],
    noReAsk: {
      2: ["department", "doctor"],
      3: ["department", "doctor"],
      4: ["department", "doctor"],
    },
  },
  {
    id: "scn-hallucinated-slot-en",
    locale: "en",
    intent:
      "The offered-options guard. The patient asks for a time that was never in a " +
      "tool result. The assistant must not book it, and the server must refuse it " +
      "even if the assistant tries.",
    patient: { linked: true, identityVerified: true },
    turns: [
      "I want an appointment with Sara Ali in dermatology.",
      "the 7th",
      "can you do 4pm?",
    ],
    measures: ["offered_slot_integrity", "technical_fallback"],
  },
  {
    id: "scn-stranger-intake-en",
    locale: "en",
    intent:
      "A number the clinic has never seen. Department and doctor first, then the " +
      "personal details, then a real-slot request — without sending them away and " +
      "without asking for their phone number.",
    patient: STRANGER,
    turns: [
      "hello, I have never been to your clinic. can I book a dermatology appointment?",
      "Sara Ali",
      "Omar Hassan, 29812345600321, 12/9/1998, omar@example.com",
      "the first available day at 10",
    ],
    measures: [
      "booking_completion",
      "repeated_question",
      "unnecessary_escalation",
      "turns_to_booking",
    ],
    noReAsk: { 1: ["department", "phone"], 2: ["department", "doctor", "phone"], 3: ["phone"] },
  },
  {
    id: "scn-wrong-doctor-ar",
    locale: "ar",
    intent:
      "A doctor who works in another department. A real status, not an error — it " +
      "must never produce a technical-problem reply, and it must not restart.",
    patient: { linked: true, identityVerified: true },
    turns: ["عايز احجز في الجلدية.", "د. ليلى فؤاد", "طب مين المتاح؟"],
    measures: ["technical_fallback", "flow_restart", "repeated_question"],
    noReAsk: { 2: ["department"] },
  },
];

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

export type SimulatedToolCall = {
  tool: string;
  outcome: string;
  stageBefore: BookingStage;
  stageAfter: BookingStage;
  legal: boolean;
};

/**
 * The conversation's server-side state, evolved exactly as the real tools evolve
 * it: collected fields through `set_conversation_ai_state` semantics, stage
 * through `booking-stage.ts`.
 */
export class BookingSimulator {
  collected: CollectedData = {};
  stageState: BookingStageState = EMPTY_BOOKING_STAGE_STATE;
  intakeStaged = false;
  submitted = false;
  readonly calls: SimulatedToolCall[] = [];
  /** Set when the model tried to book a time no tool ever offered. */
  neverOfferedAttempts = 0;

  constructor(private readonly patient: ScenarioPatient) {}

  get stage(): BookingStage {
    return deriveStage({
      collected: this.collected,
      linked: this.patient.linked,
      identityVerified: this.patient.identityVerified,
      identityLocked: false,
      intakeStaged: this.intakeStaged,
      submitted: this.submitted,
      escalated: false,
      bookingForOther: false,
      bookingIntent: this.hasIntent,
    });
  }

  private hasIntent = false;

  markIntent(): void {
    this.hasIntent = true;
  }

  private record(tool: string, outcome: string): void {
    const before = this.stageState.stage;
    const after = this.stage;
    const advanced = advanceStage(this.stageState, after, {
      at: new Date().toISOString(),
    });
    this.stageState = advanced.state;
    this.calls.push({
      tool,
      outcome,
      stageBefore: before,
      stageAfter: after,
      legal: advanced.transition.legal,
    });
  }

  private departmentByName(name: string): FixtureDepartment | null {
    const needle = name.trim().toLowerCase();
    return (
      FIXTURE_DEPARTMENTS.find(
        (item) =>
          item.name.toLowerCase() === needle ||
          item.name.toLowerCase().startsWith(needle.slice(0, 4)) ||
          (needle.includes("جلد") && item.id === DERM) ||
          (needle.includes("سنان") && item.id === DENT),
      ) ?? null
    );
  }

  private doctorByName(name: string): FixtureDoctor | null {
    const needle = name.trim().toLowerCase();
    const arabicMap: Record<string, string> = {
      "أحمد": "Ahmed Nabil",
      "احمد": "Ahmed Nabil",
      "سارة": "Sara Ali",
      "ساره": "Sara Ali",
      "محمد": "Mohamed Khaled",
      "ليلى": "Laila Fouad",
      "ليلي": "Laila Fouad",
    };
    for (const [arabic, english] of Object.entries(arabicMap)) {
      if (name.includes(arabic)) {
        return FIXTURE_DOCTORS.find((item) => item.name === english) ?? null;
      }
    }
    return (
      FIXTURE_DOCTORS.find((item) => item.name.toLowerCase() === needle) ??
      FIXTURE_DOCTORS.find((item) =>
        item.name.toLowerCase().split(" ").some((part) => part === needle),
      ) ??
      FIXTURE_DOCTORS.find((item) => item.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  private roster(departmentId: string, excludeId?: string | null) {
    const doctors = FIXTURE_DOCTORS.filter(
      (item) => item.departmentId === departmentId && item.id !== excludeId,
    );
    return {
      department: FIXTURE_DEPARTMENTS.find((item) => item.id === departmentId)!,
      doctors: doctors.map((item) => ({ id: item.id, name: item.name })),
      doctor_count: doctors.length,
      only_one_available: doctors.length === 1,
    };
  }

  // -- the tools ------------------------------------------------------------

  prepareBooking(input: {
    department?: string;
    doctor?: string;
    show_other_doctors?: boolean;
  }): Record<string, unknown> {
    this.markIntent();
    const wantsAlternatives =
      input.show_other_doctors === true ||
      /other|another|else|غير|تاني|ثاني|بديل/i.test(input.doctor ?? "");
    const doctorQuery = wantsAlternatives ? undefined : input.doctor;
    const establishedDepartment =
      typeof this.collected.department_id === "string" ? this.collected.department_id : null;

    if (!input.department && !doctorQuery && !wantsAlternatives && !establishedDepartment) {
      const treating = this.patient.treatingDoctorId
        ? FIXTURE_DOCTORS.find((item) => item.id === this.patient.treatingDoctorId)
        : undefined;
      if (treating) {
        this.collected = {
          ...this.collected,
          doctor_id: treating.id,
          doctor_name: treating.name,
          department_id: treating.departmentId,
          department_name: this.roster(treating.departmentId).department.name,
        };
        const others = this.roster(treating.departmentId, treating.id);
        this.stageState = recordOfferedDoctors(this.stageState, [
          treating.id,
          ...others.doctors.map((item) => item.id),
        ]);
        this.record("prepare_booking", "treating_doctor");
        return {
          existing_patient: true,
          treating_doctor: { id: treating.id, name: treating.name },
          department: others.department,
          other_doctors: others.doctors,
          other_doctor_count: others.doctor_count,
          guidance:
            `The patient's treating doctor is Dr ${treating.name}. Recommend this doctor first. ` +
            "If the patient asks for someone else, offer every doctor in other_doctors by name — " +
            "do not force the treating doctor, and do not ask for the department again.",
        };
      }
    }

    let department = establishedDepartment
      ? FIXTURE_DEPARTMENTS.find((item) => item.id === establishedDepartment) ?? null
      : null;
    if (input.department) {
      const resolved = this.departmentByName(input.department);
      if (!resolved) {
        this.record("prepare_booking", "department_not_found");
        return {
          needs_clarification: true,
          field: "department",
          reason: "unknown",
          departments: FIXTURE_DEPARTMENTS,
          guidance: "Say that department was not found and offer these active departments.",
        };
      }
      department = resolved;
    }
    if (!department) {
      this.record("prepare_booking", "needs_department");
      return {
        existing_patient: this.patient.linked,
        needs_selection: true,
        field: "department",
        departments: FIXTURE_DEPARTMENTS,
        guidance: "Offer these active ClinicFlow departments and ask which one they need.",
      };
    }

    const departmentChanged =
      Boolean(input.department) && establishedDepartment !== department.id;
    this.collected = {
      ...this.collected,
      department_id: department.id,
      department_name: department.name,
      ...(departmentChanged ? { doctor_id: undefined, doctor_name: undefined } : {}),
    };

    if (!doctorQuery) {
      const roster = this.roster(department.id);
      this.stageState = recordOfferedDoctors(
        this.stageState,
        roster.doctors.map((item) => item.id),
      );
      if (!wantsAlternatives) {
        this.collected = { ...this.collected, doctor_id: undefined, doctor_name: undefined };
      }
      this.record("prepare_booking", wantsAlternatives ? "roster_alternatives" : "roster");
      return {
        ...roster,
        needs_selection: true,
        field: "doctor",
        guidance:
          "List EVERY doctor in `doctors` by name in one sentence, then ask which one they " +
          "want. Do not offer a subset, do not pick one for the patient, and never name a " +
          "doctor that is not in this list.",
      };
    }

    const doctor = this.doctorByName(doctorQuery);
    if (!doctor) {
      this.record("prepare_booking", "doctor_not_found");
      return {
        ...this.roster(department.id),
        needs_selection: true,
        field: "doctor",
        reason: "doctor_not_found",
        guidance:
          "That name does not match any doctor at this clinic. Say so plainly and offer every " +
          "doctor in `doctors` for the selected department.",
      };
    }
    if (doctor.departmentId !== department.id) {
      this.record("prepare_booking", "doctor_in_other_department");
      return {
        ...this.roster(department.id),
        needs_selection: true,
        field: "doctor",
        reason: "doctor_in_other_department",
        requested_doctor: {
          id: doctor.id,
          name: doctor.name,
          department: this.roster(doctor.departmentId).department.name,
        },
        departments: FIXTURE_DEPARTMENTS,
        guidance:
          "This doctor is real but works in a different department. Say which department they " +
          "are in, then offer every doctor in `doctors` for the department the patient chose.",
      };
    }
    this.collected = { ...this.collected, doctor_id: doctor.id, doctor_name: doctor.name };
    this.stageState = recordOfferedDoctors(this.stageState, [doctor.id]);
    this.record("prepare_booking", "doctor_resolved");
    return {
      resolved: true,
      existing_patient: this.patient.linked,
      department,
      doctor: { id: doctor.id, name: doctor.name },
      guidance:
        "The real department and doctor are resolved. Continue with list_available_days and " +
        "do not ask for the department or the doctor again.",
    };
  }

  listDoctors(input: { department?: string; exclude_doctor_id?: string }): Record<string, unknown> {
    this.markIntent();
    const departmentId = input.department
      ? this.departmentByName(input.department)?.id ?? null
      : typeof this.collected.department_id === "string"
        ? this.collected.department_id
        : null;
    if (!departmentId) {
      this.record("list_doctors", "needs_department");
      return {
        needs_selection: true,
        field: "department",
        departments: FIXTURE_DEPARTMENTS,
        guidance: "No department has been chosen in this conversation yet.",
      };
    }
    const roster = this.roster(departmentId, input.exclude_doctor_id ?? null);
    this.stageState = recordOfferedDoctors(
      this.stageState,
      roster.doctors.map((item) => item.id),
    );
    this.record("list_doctors", roster.doctor_count === 0 ? "empty_roster" : "roster");
    return {
      ...roster,
      department_already_selected: true,
      guidance:
        "Name EVERY doctor in `doctors` in one sentence and ask which one they want. Do not " +
        "shorten the list and never name a doctor that is not in it.",
    };
  }

  listAvailableDays(input: { doctor_id?: string }): Record<string, unknown> {
    this.markIntent();
    const doctorId =
      input.doctor_id ??
      (typeof this.collected.doctor_id === "string" ? this.collected.doctor_id : null);
    if (!doctorId) {
      this.record("list_available_days", "doctor_required");
      return {
        needs_clarification: true,
        field: "doctor",
        guidance: "Call prepare_booking and resolve a real doctor before listing days.",
      };
    }
    this.collected = { ...this.collected, doctor_id: doctorId };
    this.stageState = recordOfferedDays(this.stageState, FIXTURE_DAYS);
    this.record("list_available_days", "success");
    return {
      ok: true,
      doctorId,
      doctorName: FIXTURE_DOCTORS.find((item) => item.id === doctorId)?.name ?? "",
      availableDays: FIXTURE_DAYS.map((date) => ({ date, slotCount: FIXTURE_SLOTS.length })),
      minimumNoticeHours: 24,
    };
  }

  checkAvailability(input: { date: string; doctor_id?: string }): Record<string, unknown> {
    this.markIntent();
    const date = resolveFixtureDate(input.date);
    const doctorId =
      input.doctor_id ??
      (typeof this.collected.doctor_id === "string" ? this.collected.doctor_id : null);
    if (!date) {
      this.record("check_availability", "unrecognized_date");
      return {
        needs_clarification: true,
        field: "date",
        reason: "unrecognized",
        guidance: "Ask once, conversationally, which day they mean.",
      };
    }
    if (!doctorId) {
      this.record("check_availability", "doctor_required");
      return {
        needs_clarification: true,
        field: "doctor_id",
        guidance: "Ask which doctor the patient prefers.",
      };
    }
    this.collected = { ...this.collected, appointment_date: date, doctor_id: doctorId };
    this.stageState = recordOfferedSlots(this.stageState, date, FIXTURE_SLOTS);
    this.record("check_availability", "success");
    return {
      ok: true,
      date,
      doctorId,
      availableSlots: [...FIXTURE_SLOTS],
      minimumNoticeHours: 24,
    };
  }

  createBooking(input: {
    date?: string;
    time?: string;
    scheduled_at?: string;
  }): Record<string, unknown> {
    this.markIntent();
    const doctorId =
      typeof this.collected.doctor_id === "string" ? this.collected.doctor_id : null;
    if (!doctorId) {
      this.record("create_preliminary_booking", "doctor_required");
      return {
        created: false,
        reason: "doctor_required",
        guidance: "Call prepare_booking and resolve the doctor before booking.",
      };
    }
    const date =
      resolveFixtureDate(input.date ?? "") ??
      (typeof this.collected.appointment_date === "string"
        ? this.collected.appointment_date
        : null) ??
      (input.scheduled_at ? input.scheduled_at.slice(0, 10) : null);
    const time = resolveFixtureTime(input.time ?? input.scheduled_at?.slice(11, 16) ?? "");
    if (!date || !time) {
      this.record("create_preliminary_booking", "needs_time");
      return {
        created: false,
        needs_clarification: true,
        field: "time",
        guidance: "Offer only the real slots returned by check_availability.",
      };
    }

    // The production guard, running on the production function.
    const offered = checkOfferedSlot(this.stageState, date, time);
    if (offered.status === "rejected") {
      this.neverOfferedAttempts += 1;
      this.record("create_preliminary_booking", "slot_never_offered");
      return {
        created: false,
        needs_clarification: true,
        field: "time",
        reason: "slot_not_offered",
        available_times: offered.offeredForDate,
        guidance:
          offered.offeredForDate.length > 0
            ? "That time was never offered to this patient. Offer only the times in " +
              "available_times and ask which one they want. Do not book any other time."
            : "That time was never offered to this patient. Call check_availability for the " +
              "day they chose and offer only the times it returns.",
      };
    }

    // The production booking path recomputes availability inside
    // `createPatientPendingBooking` and refuses a slot the clinic cannot serve.
    // Reproduced here so the offered-options guard is measured for what it adds
    // *on top of* that check, rather than being credited with its work.
    if (!FIXTURE_DAYS.includes(date) || !FIXTURE_SLOTS.includes(time)) {
      this.record("create_preliminary_booking", "slot_unavailable");
      return {
        created: false,
        reason: "slot_unavailable",
        guidance: "The slot could not be booked. Check availability again.",
      };
    }

    if (!this.patient.linked && !this.intakeStaged) {
      this.record("create_preliminary_booking", "patient_unlinked");
      return {
        created: false,
        reason: "patient_unlinked",
        guidance:
          "This sender has no patient record yet. Use register_patient before requesting a slot.",
      };
    }

    this.collected = {
      ...this.collected,
      appointment_date: date,
      appointment_time: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
    };
    this.submitted = true;
    this.record("create_preliminary_booking", "submitted");
    return {
      created: true,
      provisional: !this.patient.linked,
      status: "pending",
      expires_at: "2026-09-06T09:00:00.000Z",
      requires_staff_confirmation: true,
    };
  }

  registerPatient(input: {
    full_name: string;
    national_id: string;
    date_of_birth: string;
    email: string;
  }): Record<string, unknown> {
    this.markIntent();
    if (this.patient.linked) {
      this.record("register_patient", "already_linked");
      return { registered: false, reason: "already_linked", guidance: "Continue with the booking." };
    }
    const missing = (["full_name", "national_id", "date_of_birth", "email"] as const).filter(
      (field) => !String(input[field] ?? "").trim(),
    );
    if (missing.length > 0) {
      this.record("register_patient", "unreadable_fields");
      return {
        registered: false,
        reason: "unreadable_fields",
        fields: missing,
        guidance: "Ask the patient again for only the listed details, in ordinary words.",
      };
    }
    if (
      typeof this.collected.department_id !== "string" ||
      typeof this.collected.doctor_id !== "string"
    ) {
      this.record("register_patient", "assignment_required");
      return {
        registered: false,
        reason: "assignment_required",
        guidance:
          "Call prepare_booking to resolve one active department and one active doctor in it, " +
          "then call register_patient without asking for these personal details again.",
      };
    }
    this.collected = {
      ...this.collected,
      full_name: input.full_name,
      national_id: input.national_id,
      email: input.email,
    };
    this.intakeStaged = true;
    this.record("register_patient", "staged");
    return {
      registered: false,
      intake_staged: true,
      awaiting_staff_review: true,
      can_request_appointment: true,
      guidance:
        "The proposed patient file is securely staged for staff review. Do not say the patient " +
        "is registered yet. Continue to a real-slot appointment request if they asked to book.",
    };
  }

  clinicInfo(): Record<string, unknown> {
    this.record("get_clinic_info", "success");
    return {
      name: FIXTURE_CLINIC.name,
      phone: FIXTURE_CLINIC.phone,
      address: FIXTURE_CLINIC.address,
      working_hours: FIXTURE_CLINIC.workingHours,
      timezone: FIXTURE_CLINIC.timezone,
    };
  }

  faq(): Record<string, unknown> {
    this.record("answer_clinic_faq", "no_answer");
    return {
      found: false,
      guidance: "There is no clinic-authored answer. Say you do not know and offer clinic staff.",
    };
  }

  verifyIdentity(): Record<string, unknown> {
    this.record("verify_patient_identity", this.patient.identityVerified ? "verified" : "failed");
    return {
      verified: this.patient.identityVerified,
      attempts_remaining: 4,
      locked_until: null,
      guidance: this.patient.identityVerified
        ? "Identity verified for this conversation."
        : "The date did not match. Ask the patient to try again.",
    };
  }

  listAppointments(): Record<string, unknown> {
    this.record("list_my_appointments", "success");
    return { appointments: [] };
  }

  cancelAppointment(): Record<string, unknown> {
    this.record("cancel_my_appointment", "not_found");
    return { cancelled: false, reason: "not_found" };
  }
}

/** Maps the fixture's day words onto the three real dates. */
export function resolveFixtureDate(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (iso) return FIXTURE_DAYS.includes(iso) ? iso : null;
  for (const date of FIXTURE_DAYS) {
    const day = String(Number(date.slice(8, 10)));
    if (new RegExp(`(^|\\D)${day}(st|nd|rd|th)?(\\D|$)`).test(text)) return date;
  }
  if (/first|earliest|soonest|أول|اقرب|أقرب/.test(text)) return FIXTURE_DAYS[0]!;
  return null;
}

/** Maps a natural time onto `HH:mm`, without pinning it to the offered set. */
export function resolveFixtureTime(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const explicit = /(\d{1,2})\s*[:.]\s*(\d{2})/.exec(text);
  if (explicit) {
    return `${explicit[1]!.padStart(2, "0")}:${explicit[2]}`;
  }
  const hour = /(\d{1,2})\s*(am|pm|صباح|مساء|عصر)?/.exec(text);
  if (!hour) return null;
  let value = Number(hour[1]);
  if (!Number.isFinite(value) || value > 23) return null;
  const meridiem = hour[2];
  if ((meridiem === "pm" || meridiem === "مساء" || meridiem === "عصر") && value < 12) {
    value += 12;
  }
  return `${String(value).padStart(2, "0")}:00`;
}
