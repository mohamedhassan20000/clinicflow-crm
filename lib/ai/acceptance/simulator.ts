/**
 * The acceptance simulator: all sixteen patient tools, over the fixture clinic.
 *
 * Two properties make it worth trusting.
 *
 *   1. It calls the **production** decision functions wherever a decision is
 *      being made — `resolveNamedEntity` for a name, `checkOfferedSlot` for a
 *      slot, `recordOffered*`/`deriveStage`/`advanceStage` for the state
 *      machine. It reimplements plumbing, never policy. A change to how the
 *      product resolves "دكتور احم" changes this suite's result on the next run,
 *      which is the whole point of a durable acceptance suite.
 *
 *   2. It records a **write ledger**. Every attempted and every committed write
 *      is kept with the arguments that produced it, so "did the assistant book
 *      something nobody agreed to?" is answered from data rather than from
 *      prose.
 *
 * Deliberately *not* covered here: RLS, the real availability engine, the
 * identity RPCs, entitlements. Those have their own suites, and pretending to
 * cover them from a fixture would make this report less honest, not more.
 */

import {
  advanceStage,
  checkOfferedSlot,
  deriveStage,
  EMPTY_BOOKING_STAGE_STATE,
  recordOfferedDays,
  recordOfferedDoctors,
  recordOfferedSlots,
  resolveOfferedTime,
  type BookingStage,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import type { CollectedData } from "@/lib/ai/collected-state";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import { parseHumanDate } from "@/lib/ai/human-input";
import {
  buildPatientVocabulary,
  isPatientSourcedArgument,
} from "@/lib/ai/argument-provenance";
import {
  checkIntakeProvenance,
  collectIntakeEvidence,
  INTAKE_PROVENANCE_GUIDANCE,
} from "@/lib/ai/intake-provenance";
import {
  bookableDoctors,
  daysFor,
  departmentById,
  doctorById,
  FIXTURE_APPOINTMENTS,
  FIXTURE_CLINIC,
  FIXTURE_CURRENCY,
  FIXTURE_DEPARTMENTS,
  FIXTURE_DOCTORS,
  FIXTURE_FAQ,
  FIXTURE_INSURERS,
  FIXTURE_PATIENT,
  servicesOf,
  slotsFor,
  type FixtureAppointment,
} from "@/lib/ai/acceptance/fixture-clinic";

export type SimulatedPatient = {
  /** The sender's number already selects a patient file. */
  linked: boolean;
  /** The stronger clinical check (date of birth) has passed this conversation. */
  identityVerified: boolean;
  /** The booking-only confirmation has passed. */
  bookingIdentityConfirmed: boolean;
  /** The treating doctor a linked patient is offered first, if any. */
  treatingDoctorId?: string;
  /** A staff member currently holds the thread. */
  humanTakeover?: boolean;
  /**
   * The stored conversation points to a soft-deleted patient and still carries
   * booking/intake state from that finished episode. The production resolver
   * normalizes this before the first turn; the deterministic harness seeds and
   * performs the same reset in its constructor.
   */
  staleSoftDeletedEpisode?: boolean;
};

export const LINKED_VERIFIED: SimulatedPatient = {
  linked: true,
  identityVerified: true,
  bookingIdentityConfirmed: true,
  treatingDoctorId: FIXTURE_DOCTORS[0]!.id,
};

export const LINKED_UNCONFIRMED: SimulatedPatient = {
  linked: true,
  identityVerified: false,
  bookingIdentityConfirmed: false,
};

export const STRANGER: SimulatedPatient = {
  linked: false,
  identityVerified: false,
  bookingIdentityConfirmed: false,
};

export const SOFT_DELETED_STALE_PATIENT: SimulatedPatient = {
  ...STRANGER,
  staleSoftDeletedEpisode: true,
};

export type ToolCallRecord = {
  tool: string;
  input: Record<string, unknown>;
  outcome: string;
  stageBefore: BookingStage;
  stageAfter: BookingStage;
  legalTransition: boolean;
};

export type WriteRecord = {
  operation: "register_patient" | "create_preliminary_booking" | "cancel_my_appointment";
  committed: boolean;
  reason: string;
  entityId: string | null;
  /** The exact values the write was attempted with. */
  args: Record<string, unknown>;
};

/**
 * Failures the harness can inject, by tool name. `"throw"` reproduces an
 * unexpected exception (which production converts into the clinic's stored
 * phone number, never a stack trace); `"timeout"` reproduces a provider that
 * never answers.
 */
export type InjectedFailure = "throw" | "timeout" | "raw_db_error";

export class AcceptanceSimulator {
  collected: CollectedData = {};
  stageState: BookingStageState = EMPTY_BOOKING_STAGE_STATE;
  intakeStaged = false;
  intakeId: string | null = null;
  submitted = false;
  bookingForOther = false;
  escalated = false;
  identityVerified: boolean;
  bookingIdentityConfirmed: boolean;

  readonly calls: ToolCallRecord[] = [];
  readonly writes: WriteRecord[] = [];
  /** Slot-booking attempts the server refused because it never offered them. */
  neverOfferedAttempts = 0;
  /** Every entity name the server actually put in front of the patient. */
  readonly offeredNames = new Set<string>();
  /**
   * F-8 / F-11 — the patient's own messages for the current episode, in order.
   *
   * Stands in for the `inbound_messages` read `patient-reply.ts` performs, and
   * is what the two provenance gates are evaluated against, so the harness runs
   * the same refusals production does rather than a weaker imitation. Cleared
   * at the episode boundary for the same reason the collected data is.
   */
  readonly utterances: string[] = [];
  /** Intake writes refused because the patient never supplied the values. */
  fabricatedIntakeAttempts = 0;
  /** Entity arguments discarded because the patient never uttered them. */
  unsourcedArgumentDiscards = 0;
  /** The acceptance fixture's authoritative pre-turn normalization ran. */
  normalizedStalePatientEpisode = false;

  private appointments: FixtureAppointment[] = FIXTURE_APPOINTMENTS.map((a) => ({ ...a }));
  private bookingCounter = 0;
  private hasIntent = false;

  constructor(
    readonly patient: SimulatedPatient,
    private readonly failures: Partial<Record<string, InjectedFailure>> = {},
  ) {
    this.identityVerified = patient.identityVerified;
    this.bookingIdentityConfirmed = patient.bookingIdentityConfirmed;
    if (patient.staleSoftDeletedEpisode) {
      // Representative stale shape: every value below belongs to the deleted
      // patient's old episode and must be gone before the first message is
      // classified or a tool mount is derived.
      this.collected = {
        full_name: "Previous Deleted Patient",
        department_id: FIXTURE_DEPARTMENTS[0]!.id,
        doctor_id: FIXTURE_DOCTORS[0]!.id,
        appointment_date: "2026-09-15",
        appointment_time: 600,
      };
      this.stageState = {
        ...EMPTY_BOOKING_STAGE_STATE,
        stage: "intake_collecting",
        offeredDoctorIds: [FIXTURE_DOCTORS[0]!.id],
        offeredDays: ["2026-09-15"],
        offeredSlots: ["2026-09-15T10:00"],
        turnCount: 7,
      };
      this.hasIntent = true;
      this.resetEpisode();
      this.normalizedStalePatientEpisode = true;
    }
  }

  get stage(): BookingStage {
    return deriveStage({
      collected: this.collected,
      linked: this.patient.linked,
      identityVerified: this.identityVerified || this.bookingIdentityConfirmed,
      identityLocked: false,
      intakeStaged: this.intakeStaged,
      submitted: this.submitted,
      escalated: this.escalated,
      bookingForOther: this.bookingForOther,
      bookingIntent: this.hasIntent,
    });
  }

  get bookingIntent(): boolean {
    return this.hasIntent;
  }

  markIntent(): void {
    this.hasIntent = true;
  }

  /** The public, patient-facing state a new episode must not inherit. */
  resetEpisode(): void {
    this.collected = {};
    this.stageState = EMPTY_BOOKING_STAGE_STATE;
    this.intakeStaged = false;
    this.intakeId = null;
    this.submitted = false;
    this.bookingForOther = false;
    this.escalated = false;
    this.hasIntent = false;
    this.offeredNames.clear();
    this.utterances.length = 0;
  }

  /** Records one inbound patient message, as the transport stores it. */
  recordUtterance(text: string): void {
    if (typeof text === "string" && text.trim().length > 0) this.utterances.push(text);
  }

  /** The episode's evidence, for the intake provenance gate. */
  private get intakeEvidence() {
    return collectIntakeEvidence(this.utterances, { order: "dmy" });
  }

  /** The episode's vocabulary, for the entity-argument provenance gate. */
  private get patientVocabulary() {
    return buildPatientVocabulary(this.utterances);
  }

  private record(tool: string, outcome: string, input: Record<string, unknown>): void {
    const before = this.stageState.stage;
    const after = this.stage;
    const advanced = advanceStage(this.stageState, after, { at: new Date().toISOString() });
    this.stageState = advanced.state;
    this.calls.push({
      tool,
      input,
      outcome,
      stageBefore: before,
      stageAfter: after,
      legalTransition: advanced.transition.legal,
    });
  }

  private offer(...names: string[]): void {
    for (const name of names) this.offeredNames.add(name);
  }

  /** Applies an injected failure for `tool`, if one is configured. */
  private async maybeFail(tool: string): Promise<void> {
    const mode = this.failures[tool];
    if (!mode) return;
    if (mode === "timeout") {
      throw new Error("ETIMEDOUT: upstream did not respond");
    }
    if (mode === "raw_db_error") {
      throw new Error(
        'PostgrestError: relation "public.appointments" violates row-level security policy for table "appointments" (code 42501)',
      );
    }
    throw new Error("Unexpected failure in tool execution");
  }

  private departmentPayload() {
    return FIXTURE_DEPARTMENTS.map(({ id, name }) => ({ id, name }));
  }

  private rosterPayload(departmentId: string, excludeId?: string | null) {
    const doctors = bookableDoctors(departmentId)
      .filter((item) => item.id !== excludeId)
      .map((item) => ({ id: item.id, name: item.name }));
    this.stageState = recordOfferedDoctors(
      this.stageState,
      doctors.map((item) => item.id),
    );
    this.offer(...doctors.map((item) => item.name));
    return {
      department: departmentById(departmentId)!,
      doctors,
      doctor_count: doctors.length,
      only_one_available: doctors.length === 1,
    };
  }

  private get establishedDepartmentId(): string | null {
    return typeof this.collected.department_id === "string"
      ? this.collected.department_id
      : null;
  }

  private get establishedDoctorId(): string | null {
    return typeof this.collected.doctor_id === "string" ? this.collected.doctor_id : null;
  }

  // -- booking ---------------------------------------------------------------

  async prepareBooking(input: {
    department?: string;
    doctor?: string;
    show_other_doctors?: boolean;
  }): Promise<Record<string, unknown>> {
    await this.maybeFail("prepare_booking");
    this.markIntent();

    if (this.patient.humanTakeover) {
      this.record("prepare_booking", "human_takeover", input);
      return {
        permission_denied: true,
        reason: "human_takeover",
        guidance:
          "A member of clinic staff has taken this conversation over. Do not act and do not send anything.",
      };
    }
    if (this.patient.linked && !this.bookingIdentityConfirmed && !this.identityVerified) {
      this.record("prepare_booking", "booking_identity_required", input);
      return {
        permission_denied: true,
        reason: "booking_identity_required",
        guidance:
          "This booking still needs its patient file identified. Ask the patient to confirm the " +
          "stored name and call confirm_booking_identity.",
      };
    }

    // F-11 — the production argument-provenance pre-pass, on the production
    // function. An entity argument that resolves to nothing real *and* that the
    // patient never uttered is discarded rather than treated as a choice, so a
    // model pressured into inventing a department by the authority pin cannot
    // suppress the treating-doctor opening and deadlock the ladder on
    // `department`. See `lib/ai/argument-provenance.ts`.
    const vocabulary = this.patientVocabulary;
    let departmentArg = input.department;
    let doctorArg = input.doctor;
    if (
      departmentArg &&
      resolveNamedEntity(departmentArg, this.departmentPayload()).status === "not_found" &&
      !isPatientSourcedArgument(departmentArg, vocabulary)
    ) {
      departmentArg = undefined;
      this.unsourcedArgumentDiscards += 1;
    }
    if (
      doctorArg &&
      !/other|another|else|غير|تاني|ثاني|بديل/i.test(doctorArg) &&
      resolveNamedEntity(
        doctorArg,
        FIXTURE_DOCTORS.map((item) => ({ id: item.id, name: item.name })),
      ).status === "not_found" &&
      !isPatientSourcedArgument(doctorArg, vocabulary)
    ) {
      doctorArg = undefined;
      this.unsourcedArgumentDiscards += 1;
    }
    input = { ...input, department: departmentArg, doctor: doctorArg };

    const wantsAlternatives =
      input.show_other_doctors === true ||
      /other|another|else|غير|تاني|ثاني|بديل/i.test(input.doctor ?? "");
    const doctorQuery = wantsAlternatives ? undefined : input.doctor;

    // The treating-doctor opening: a linked patient who names nothing.
    if (
      !input.department &&
      !doctorQuery &&
      !wantsAlternatives &&
      !this.establishedDepartmentId &&
      this.patient.treatingDoctorId
    ) {
      const treating = doctorById(this.patient.treatingDoctorId)!;
      this.collected = {
        ...this.collected,
        doctor_id: treating.id,
        doctor_name: treating.name,
        department_id: treating.departmentId,
        department_name: departmentById(treating.departmentId)!.name,
      };
      const others = this.rosterPayload(treating.departmentId, treating.id);
      this.stageState = recordOfferedDoctors(this.stageState, [treating.id]);
      this.offer(treating.name);
      this.record("prepare_booking", "treating_doctor", input);
      return {
        existing_patient: true,
        treating_doctor: { id: treating.id, name: treating.name },
        department: others.department,
        other_doctors: others.doctors,
        other_doctor_count: others.doctor_count,
        guidance:
          `The patient's treating doctor is Dr ${treating.name}. Recommend this doctor first. ` +
          "If the patient asks for someone else, offer every doctor in other_doctors by name.",
      };
    }

    let department = this.establishedDepartmentId
      ? departmentById(this.establishedDepartmentId)
      : null;

    if (input.department) {
      const resolution = resolveNamedEntity(input.department, this.departmentPayload());
      if (resolution.status !== "resolved") {
        const candidates = resolution.candidates
          .filter((item) => item.score >= 0.58)
          .map(({ id, name }) => ({ id, name }));
        this.offer(...candidates.map((c) => c.name), ...this.departmentPayload().map((d) => d.name));
        this.record("prepare_booking", `department_${resolution.status}`, input);
        return {
          needs_clarification: true,
          field: "department",
          reason: resolution.status,
          candidates,
          departments: this.departmentPayload(),
          guidance:
            resolution.status === "ambiguous"
              ? "Ask one short question naming only these plausible departments."
              : "Say that department was not found and offer these active departments.",
        };
      }
      department = resolution.entity as { id: string; name: string };
    }

    if (!department) {
      this.offer(...this.departmentPayload().map((d) => d.name));
      this.record("prepare_booking", "needs_department", input);
      return {
        existing_patient: this.patient.linked,
        needs_selection: true,
        field: "department",
        departments: this.departmentPayload(),
        guidance: "Offer these active ClinicFlow departments and ask which one they need.",
      };
    }

    const departmentChanged =
      Boolean(input.department) && this.establishedDepartmentId !== department.id;
    this.collected = {
      ...this.collected,
      department_id: department.id,
      department_name: department.name,
      ...(departmentChanged
        ? { doctor_id: undefined, doctor_name: undefined, appointment_date: undefined, appointment_time: undefined }
        : {}),
    };

    if (!doctorQuery) {
      const roster = this.rosterPayload(department.id);
      if (!wantsAlternatives) {
        this.collected = { ...this.collected, doctor_id: undefined, doctor_name: undefined };
      }
      this.record("prepare_booking", wantsAlternatives ? "roster_alternatives" : "roster", input);
      return {
        ...roster,
        needs_selection: true,
        field: "doctor",
        guidance:
          "List EVERY doctor in `doctors` by name in one sentence, then ask which one they want. " +
          "Never name a doctor that is not in this list.",
      };
    }

    // A doctor query is resolved against the whole clinic, so "in another
    // department", "on leave" and "inactive" stay distinguishable statuses
    // rather than collapsing into "not found".
    const clinicWide = FIXTURE_DOCTORS.map((item) => ({ id: item.id, name: item.name }));
    const resolution = resolveNamedEntity(doctorQuery, clinicWide);
    const roster = this.rosterPayload(department.id);

    if (resolution.status === "ambiguous") {
      const candidates = resolution.candidates.map(({ id, name }) => ({ id, name }));
      this.offer(...candidates.map((c) => c.name));
      this.record("prepare_booking", "doctor_ambiguous", input);
      return {
        ...roster,
        needs_clarification: true,
        field: "doctor",
        reason: "ambiguous",
        candidates,
        guidance:
          "More than one doctor could be the one they mean. Ask one short question naming only " +
          "the candidates. Do not choose for the patient.",
      };
    }
    if (resolution.status === "not_found") {
      this.record("prepare_booking", "doctor_not_found", input);
      return {
        ...roster,
        needs_selection: true,
        field: "doctor",
        reason: "doctor_not_found",
        guidance:
          "That name does not match any doctor at this clinic. Say so plainly and offer every " +
          "doctor in `doctors` for the selected department.",
      };
    }

    const doctor = doctorById(resolution.entity.id)!;
    if (doctor.state === "on_leave") {
      this.offer(doctor.name);
      this.record("prepare_booking", "doctor_on_leave", input);
      return {
        ...roster,
        needs_selection: true,
        field: "doctor",
        reason: "doctor_on_leave",
        requested_doctor: {
          id: doctor.id,
          name: doctor.name,
          department: departmentById(doctor.departmentId)!.name,
          unavailable_until: doctor.unavailableUntil ?? null,
        },
        guidance:
          "This doctor is currently unavailable according to the clinic's own leave records. Say " +
          "so plainly — never invent a reason — and offer every doctor in `doctors`.",
      };
    }
    if (doctor.departmentId !== department.id) {
      this.offer(doctor.name);
      this.record("prepare_booking", "doctor_in_other_department", input);
      return {
        ...roster,
        needs_selection: true,
        field: "doctor",
        reason: "doctor_in_other_department",
        requested_doctor: {
          id: doctor.id,
          name: doctor.name,
          department: departmentById(doctor.departmentId)!.name,
        },
        departments: this.departmentPayload(),
        guidance:
          "This doctor is real but works in a different department. Say which department they are " +
          "in, then offer every doctor in `doctors` for the department the patient chose.",
      };
    }

    this.collected = { ...this.collected, doctor_id: doctor.id, doctor_name: doctor.name };
    this.stageState = recordOfferedDoctors(this.stageState, [doctor.id]);
    this.offer(doctor.name);
    this.record("prepare_booking", "doctor_resolved", input);
    return {
      resolved: true,
      existing_patient: this.patient.linked,
      department,
      doctor: { id: doctor.id, name: doctor.name },
      guidance:
        "The real department and doctor are resolved. Continue with list_available_days and do " +
        "not ask for the department or the doctor again.",
    };
  }

  async listDoctors(input: { department?: string; exclude_doctor_id?: string }) {
    await this.maybeFail("list_doctors");
    this.markIntent();
    const departmentId = input.department
      ? (() => {
          const r = resolveNamedEntity(input.department!, this.departmentPayload());
          return r.status === "resolved" ? r.entity.id : null;
        })()
      : this.establishedDepartmentId;
    if (!departmentId) {
      this.offer(...this.departmentPayload().map((d) => d.name));
      this.record("list_doctors", "needs_department", input);
      return {
        needs_selection: true,
        field: "department",
        departments: this.departmentPayload(),
        guidance: "No department has been chosen in this conversation yet.",
      };
    }
    const roster = this.rosterPayload(departmentId, input.exclude_doctor_id ?? null);
    this.record("list_doctors", roster.doctor_count === 0 ? "empty_roster" : "roster", input);
    return {
      ...roster,
      department_already_selected: true,
      guidance:
        "Name EVERY doctor in `doctors` in one sentence and ask which one they want. Never name a " +
        "doctor that is not in it.",
    };
  }

  async listAvailableDays(input: { doctor_id?: string }) {
    await this.maybeFail("list_available_days");
    this.markIntent();
    const doctorId = input.doctor_id ?? this.establishedDoctorId;
    if (!doctorId || !doctorById(doctorId)) {
      this.record("list_available_days", "doctor_required", input);
      return {
        needs_clarification: true,
        field: "doctor",
        guidance: "Call prepare_booking and resolve a real doctor before listing days.",
      };
    }
    this.collected = { ...this.collected, doctor_id: doctorId };
    const days = daysFor(doctorId);
    if (days.length === 0) {
      this.record("list_available_days", "no_availability", input);
      return {
        ok: true,
        doctorId,
        doctorName: doctorById(doctorId)!.name,
        availableDays: [],
        minimumNoticeHours: 24,
        guidance:
          "This doctor has no bookable days in the search window. Say so plainly, never invent a " +
          "day, and offer another doctor or clinic staff.",
      };
    }
    this.stageState = recordOfferedDays(this.stageState, days);
    this.offer(...days);
    this.record("list_available_days", "success", input);
    return {
      ok: true,
      doctorId,
      doctorName: doctorById(doctorId)!.name,
      availableDays: days.map((date) => ({ date, slotCount: slotsFor(doctorId, date).length })),
      minimumNoticeHours: 24,
    };
  }

  async checkAvailability(input: { date: string; doctor_id?: string }) {
    await this.maybeFail("check_availability");
    this.markIntent();
    const doctorId = input.doctor_id ?? this.establishedDoctorId;
    if (!doctorId) {
      this.record("check_availability", "doctor_required", input);
      return {
        needs_clarification: true,
        field: "doctor_id",
        guidance: "Ask which doctor the patient prefers.",
      };
    }
    // Production resolves the day through `resolvePatientInput`, which falls
    // back to the value this conversation has already committed when the
    // argument cannot be read. Reproduced here for the same reason: the
    // deterministic pre-commit routinely settles the day *before* the model
    // gets to name it, and a read tool that then refused the turn because the
    // model echoed the patient's own words ("awel yom") back as the argument
    // would be measuring the harness rather than the product. It is a read, so
    // the substitution can only ever re-offer a day the server itself chose —
    // `create_preliminary_booking` deliberately does NOT do this for the time.
    const committedDate =
      typeof this.collected.appointment_date === "string"
        ? this.collected.appointment_date
        : null;
    const date =
      resolveFixtureDate(input.date, daysFor(doctorId)) ??
      (committedDate && daysFor(doctorId).includes(committedDate) ? committedDate : null);
    if (!date) {
      this.record("check_availability", "unrecognized_date", input);
      return {
        needs_clarification: true,
        field: "date",
        reason: "unrecognized",
        guidance: "Ask once, conversationally, which day they mean. Never guess a date.",
      };
    }
    const slots = slotsFor(doctorId, date);
    if (slots.length === 0) {
      this.record("check_availability", "no_slots", input);
      return {
        ok: true,
        date,
        doctorId,
        availableSlots: [],
        guidance: "No slots on that day. Never invent a time; offer another day.",
      };
    }
    this.collected = { ...this.collected, appointment_date: date, doctor_id: doctorId };
    this.stageState = recordOfferedSlots(this.stageState, date, slots);
    this.offer(date, ...slots);
    this.record("check_availability", "success", input);
    return { ok: true, date, doctorId, availableSlots: [...slots], minimumNoticeHours: 24 };
  }

  async createBooking(input: {
    date?: string;
    time?: string;
    scheduled_at?: string;
    doctor_id?: string;
  }) {
    await this.maybeFail("create_preliminary_booking");
    this.markIntent();
    const doctorId = this.establishedDoctorId;
    const fail = (reason: string, extra: Record<string, unknown> = {}) => {
      this.writes.push({
        operation: "create_preliminary_booking",
        committed: false,
        reason,
        entityId: null,
        args: input,
      });
      this.record("create_preliminary_booking", reason, input);
      return { created: false, reason, clinic_phone: FIXTURE_CLINIC.phone, ...extra };
    };

    if (!doctorId) return fail("doctor_required");
    const date =
      resolveFixtureDate(input.date ?? "", daysFor(doctorId)) ??
      (typeof this.collected.appointment_date === "string"
        ? this.collected.appointment_date
        : null) ??
      (input.scheduled_at ? input.scheduled_at.slice(0, 10) : null);
    // Production resolves the time through `resolvePatientInput`, which falls
    // back to the value already committed in `ai_collected_data` only when the
    // argument is *absent* — an argument it cannot read produces
    // `needs_clarification`, never a silent substitution. "لا قصدي يوم ١٠" must
    // not become the time the patient had picked a turn earlier.
    const rawTime = (input.time ?? input.scheduled_at?.slice(11, 16) ?? "").trim();
    const committedTime =
      typeof this.collected.appointment_time === "number"
        ? `${String(Math.floor(this.collected.appointment_time / 60)).padStart(2, "0")}:${String(this.collected.appointment_time % 60).padStart(2, "0")}`
        : null;
    const time = rawTime
      ? // The fixture's own reader first, then the *production* offered-time
        // resolver, which is closed over the slots this conversation was
        // actually shown and so can never widen what is bookable. Without it
        // the harness could not read "الساعة عشرة" — the same spelled-out-hour
        // gap F-6 fixed in `candidateClockTimes`, reappearing in the fixture's
        // plumbing and failing a booking the ladder had carried all the way to
        // `confirm`.
        (resolveFixtureTime(rawTime) ??
          (date ? resolveOfferedTime(this.stageState, date, rawTime) : null))
      : committedTime;
    if (!date || !time) {
      return fail("needs_time", {
        needs_clarification: true,
        field: "time",
        guidance: "Offer only the real slots returned by check_availability.",
      });
    }

    // The production offered-options guard, running on the production function.
    const offered = checkOfferedSlot(this.stageState, date, time);
    if (offered.status === "rejected") {
      this.neverOfferedAttempts += 1;
      return fail("slot_not_offered", {
        needs_clarification: true,
        field: "time",
        available_times: offered.offeredForDate,
        guidance:
          "That time was never offered to this patient. Offer only the times in available_times.",
      });
    }
    if (!slotsFor(doctorId, date).includes(time)) return fail("slot_unavailable");
    if ((!this.patient.linked || this.bookingForOther) && !this.intakeStaged) {
      return fail("intake_required");
    }

    this.bookingCounter += 1;
    const requestId = `9999${String(this.bookingCounter).padStart(4, "0")}-0000-4000-8000-000000000001`;
    const doctor = doctorById(doctorId)!;
    const department = departmentById(doctor.departmentId)!;
    const subject = this.bookingForOther
      ? "third_party_intake"
      : this.patient.linked
        ? "linked_patient"
        : "patient_intake";
    const expiresAt = "2026-09-06T09:00:00.000Z";
    this.collected = {
      ...this.collected,
      appointment_date: date,
      appointment_time: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
    };
    this.submitted = true;
    this.writes.push({
      operation: "create_preliminary_booking",
      committed: true,
      reason: "created",
      entityId: requestId,
      args: { ...input, resolved_date: date, resolved_time: time, doctor_id: doctorId },
    });
    this.record("create_preliminary_booking", "submitted", input);
    return {
      created: true,
      status: "pending",
      request_id: requestId,
      expires_at: expiresAt,
      requires_staff_confirmation: true,
      created_entity: {
        id: requestId,
        status: "pending",
        booking_subject: subject,
        subject_id: this.bookingForOther
          ? "77770000-0000-4000-8000-000000000001"
          : FIXTURE_PATIENT.id,
        doctor: { id: doctor.id, name: doctor.name },
        department: { id: department.id, name: department.name },
        scheduled_local_date: date,
        scheduled_local_time: time,
        scheduled_at: `${date}T${time}:00.000Z`,
        expires_at: expiresAt,
      },
    };
  }

  async registerPatient(input: {
    full_name?: string;
    national_id?: string;
    date_of_birth?: string;
    email?: string;
    for_someone_else?: boolean;
  }) {
    await this.maybeFail("register_patient");
    this.markIntent();
    if (input.for_someone_else === true) this.bookingForOther = true;

    const fail = (reason: string, extra: Record<string, unknown> = {}) => {
      this.writes.push({
        operation: "register_patient",
        committed: false,
        reason,
        entityId: null,
        args: input,
      });
      this.record("register_patient", reason, input);
      return { registered: false, reason, for_someone_else: this.bookingForOther, ...extra };
    };

    if (this.patient.linked && !this.bookingForOther) {
      return fail("already_linked", { guidance: "Continue with the booking." });
    }
    if (!this.establishedDepartmentId || !this.establishedDoctorId) {
      return fail("assignment_required", {
        guidance:
          "Call prepare_booking to resolve one active department and one active doctor first.",
      });
    }
    const missing = (["full_name", "national_id", "date_of_birth", "email"] as const).filter(
      (field) => !String(input[field] ?? "").trim(),
    );
    if (missing.length > 0) {
      return fail("unreadable_fields", {
        fields: missing,
        guidance: "Ask the patient again for only the listed details, in ordinary words.",
      });
    }

    // F-8 — the production intake-provenance gate, on the production function.
    // A well-formed value the patient never supplied is refused here, before
    // anything is staged, which is what stops a fabricated national id, date of
    // birth or email from unlocking `create_preliminary_booking`.
    const provenance = checkIntakeProvenance({
      evidence: this.intakeEvidence,
      claim: {
        full_name: input.full_name ?? null,
        national_id: input.national_id ?? null,
        date_of_birth: normalizeIntakeDate(input.date_of_birth ?? ""),
        email: input.email ?? null,
      },
    });
    if (!provenance.ok) {
      this.fabricatedIntakeAttempts += 1;
      return fail("unreadable_fields", {
        fields: [...provenance.untraceable],
        guidance: INTAKE_PROVENANCE_GUIDANCE,
      });
    }

    this.collected = {
      ...this.collected,
      ...(this.bookingForOther
        ? {}
        : {
            full_name: input.full_name!,
            national_id: input.national_id!,
            email: input.email!,
            date_of_birth: input.date_of_birth!,
          }),
    };
    this.intakeStaged = true;
    this.intakeId = "88880000-0000-4000-8000-000000000001";
    this.writes.push({
      operation: "register_patient",
      committed: true,
      reason: "intake_staged",
      entityId: this.intakeId,
      args: input,
    });
    this.record("register_patient", "staged", input);
    return {
      registered: false,
      intake_staged: true,
      intake_id: this.intakeId,
      awaiting_staff_review: true,
      can_request_appointment: true,
      for_someone_else: this.bookingForOther,
      guidance:
        "The proposed patient file is securely staged for staff review. Do not say the patient is " +
        "registered yet.",
    };
  }

  async confirmBookingIdentity(input: { full_name?: string; national_id?: string }) {
    await this.maybeFail("confirm_booking_identity");
    if (!this.patient.linked) {
      this.record("confirm_booking_identity", "not_linked", input);
      return {
        confirmed: false,
        reason: "not_linked",
        guidance: "This number has no patient file. Use register_patient instead.",
      };
    }
    if (!input.full_name && !input.national_id) {
      this.bookingIdentityConfirmed = true;
      this.record("confirm_booking_identity", "confirmed_by_number", input);
      this.offer(FIXTURE_PATIENT.name);
      return {
        confirmed: true,
        scope: "booking_only",
        patient_name: FIXTURE_PATIENT.name,
        clinical_disclosure_allowed: false,
        guidance: "Booking identity confirmed for this thread. Do not disclose clinical detail.",
      };
    }
    const nameOk =
      String(input.full_name ?? "").trim().toLowerCase() ===
      FIXTURE_PATIENT.name.toLowerCase();
    const idOk = String(input.national_id ?? "").trim() === FIXTURE_PATIENT.nationalId;
    if (nameOk && idOk) {
      this.bookingIdentityConfirmed = true;
      this.record("confirm_booking_identity", "confirmed_by_pair", input);
      return {
        confirmed: true,
        scope: "booking_only",
        patient_name: FIXTURE_PATIENT.name,
        clinical_disclosure_allowed: false,
        guidance: "Booking identity confirmed for this thread.",
      };
    }
    this.record("confirm_booking_identity", "no_match", input);
    return {
      confirmed: false,
      reason: "no_match",
      guidance: "Those details do not match a file. Do not guess; offer clinic staff.",
    };
  }

  async verifyIdentity(input: { date_of_birth?: string }) {
    await this.maybeFail("verify_patient_identity");
    const ok =
      this.patient.linked &&
      String(input.date_of_birth ?? "").trim() === FIXTURE_PATIENT.dateOfBirth;
    if (ok) this.identityVerified = true;
    this.record("verify_patient_identity", ok ? "verified" : "failed", input);
    return {
      verified: ok,
      attempts_remaining: 4,
      locked_until: null,
      guidance: ok
        ? "Identity verified for this conversation."
        : "The date did not match. Ask the patient to try again.",
    };
  }

  async listAppointments() {
    await this.maybeFail("list_my_appointments");
    if (!this.identityVerified) {
      this.record("list_my_appointments", "identity_required", {});
      return {
        permission_denied: true,
        reason: "identity_verification_required",
        guidance: "Ask for date of birth, then call verify_patient_identity.",
      };
    }
    // The row shape `list_patient_ai_appointments` actually returns: flat, with
    // `appointment_id` and `doctor_name`. The harness used to nest the doctor
    // under a `doctor` key, which no production RPC produces — so the grounding
    // ledger, which reads `doctor_name`, recorded no doctor for the whole turn
    // and a correct cancellation reply was replaced by the roster fallback.
    // That is a defect in the harness, and it was measuring the harness.
    const rows = this.appointments
      .filter((a) => a.patientId === FIXTURE_PATIENT.id)
      .map((a) => ({
        appointment_id: a.id,
        status: a.status,
        scheduled_local_date: a.date,
        scheduled_local_time: a.time,
        doctor_name: doctorById(a.doctorId)!.name,
        department_name: departmentById(doctorById(a.doctorId)!.departmentId)!.name,
      }));
    this.offer(...rows.map((r) => r.doctor_name), ...rows.map((r) => r.scheduled_local_date));
    this.record("list_my_appointments", "success", {});
    return { appointments: rows, appointment_count: rows.length };
  }

  async lookupAppointment(input: { full_name?: string; national_id?: string }) {
    await this.maybeFail("lookup_appointment");
    const name = String(input.full_name ?? "").trim();
    const nationalId = String(input.national_id ?? "").trim();
    if (!name || !nationalId) {
      this.record("lookup_appointment", "needs_identity", input);
      return {
        found: false,
        reason: "needs_identity",
        missing: [...(name ? [] : ["full_name"]), ...(nationalId ? [] : ["national_id"])],
        guidance: "Ask for the full name and the national id. Do not guess.",
      };
    }
    if (name.toLowerCase() !== FIXTURE_PATIENT.name.toLowerCase() ||
        nationalId !== FIXTURE_PATIENT.nationalId) {
      this.record("lookup_appointment", "no_match", input);
      return { found: false, reason: "no_match", attempts_remaining: 3, guidance: "No match." };
    }
    const rows = this.appointments.map((a) => ({
      appointment_id: a.id,
      status: a.status,
      scheduled_local_date: a.date,
      scheduled_local_time: a.time,
      doctor_name: doctorById(a.doctorId)!.name,
      department_name: departmentById(doctorById(a.doctorId)!.departmentId)!.name,
    }));
    this.offer(...rows.map((r) => r.doctor_name));
    this.record("lookup_appointment", "success", input);
    return {
      found: true,
      appointments: rows,
      appointment_count: rows.length,
      clinical_disclosure_allowed: false,
    };
  }

  async cancelAppointment(input: { appointment_id?: string }) {
    await this.maybeFail("cancel_my_appointment");
    if (!this.identityVerified) {
      this.record("cancel_my_appointment", "identity_required", input);
      return {
        permission_denied: true,
        reason: "identity_verification_required",
        guidance: "Ask for date of birth, then call verify_patient_identity.",
      };
    }
    const index = this.appointments.findIndex((a) => a.id === input.appointment_id);
    if (index < 0) {
      this.writes.push({
        operation: "cancel_my_appointment",
        committed: false,
        reason: "not_found",
        entityId: null,
        args: input,
      });
      this.record("cancel_my_appointment", "not_found", input);
      return { cancelled: false, reason: "not_found" };
    }
    const [removed] = this.appointments.splice(index, 1);
    this.writes.push({
      operation: "cancel_my_appointment",
      committed: true,
      reason: "cancelled",
      entityId: removed!.id,
      args: input,
    });
    this.record("cancel_my_appointment", "cancelled", input);
    return { cancelled: true, appointment_id: removed!.id, status: "cancelled" };
  }

  // -- clinic information ----------------------------------------------------

  async clinicInfo() {
    await this.maybeFail("get_clinic_info");
    this.record("get_clinic_info", "success", {});
    return {
      found: true,
      clinic: {
        name: FIXTURE_CLINIC.name,
        phone: FIXTURE_CLINIC.phone,
        address: FIXTURE_CLINIC.address,
        working_hours: FIXTURE_CLINIC.workingHours,
        timezone: FIXTURE_CLINIC.timezone,
      },
      guidance: "Answer only from `clinic`. Never invent an hour, an address or a phone number.",
    };
  }

  async faq(input: { question?: string }) {
    await this.maybeFail("answer_clinic_faq");
    const q = String(input.question ?? "").toLowerCase();
    const matches = FIXTURE_FAQ.filter((row) => {
      const key = row.question.toLowerCase();
      return (
        (q.includes("park") || q.includes("جراج") || q.includes("موقف")) &&
          key.includes("parking")
      ) || ((q.includes("walk") || q.includes("بدون")) && key.includes("walk-ins"));
    });
    this.record("answer_clinic_faq", matches.length ? "success" : "no_answer", input);
    return matches.length
      ? { found: true, matches: matches.map((m) => ({ ...m, score: 0.9 })) }
      : {
          found: false,
          guidance:
            "No clinic-authored answer matched. Say you do not know and offer to connect the " +
            "patient with clinic staff.",
        };
  }

  async listClinicDepartments() {
    await this.maybeFail("list_clinic_departments");
    this.offer(...this.departmentPayload().map((d) => d.name));
    this.record("list_clinic_departments", "success", {});
    return {
      scope: "clinic_directory",
      complete: true,
      departments: this.departmentPayload(),
      department_count: FIXTURE_DEPARTMENTS.length,
      guidance:
        "Name every department in `departments`. Do not omit any, do not list doctors, and do not " +
        "change the current booking selection.",
    };
  }

  async listClinicInsurance(input: { provider?: string }) {
    await this.maybeFail("list_clinic_insurance");
    const providers = FIXTURE_INSURERS.map(({ id, name }) => ({ id, name }));
    this.offer(...providers.map((p) => p.name));
    if (input.provider) {
      const resolution = resolveNamedEntity(input.provider, providers);
      if (resolution.status === "resolved") {
        this.record("list_clinic_insurance", "matched", input);
        return {
          accepts_insurance: true,
          matched: true,
          provider: resolution.entity,
          providers,
          provider_count: providers.length,
          guidance:
            `Yes — this clinic accepts ${resolution.entity.name}. Do not state coverage ` +
            "percentages, co-payments or contract terms.",
        };
      }
      if (resolution.status === "ambiguous") {
        this.record("list_clinic_insurance", "ambiguous", input);
        return {
          accepts_insurance: true,
          matched: "ambiguous",
          candidates: resolution.candidates.map(({ id, name }) => ({ id, name })),
          providers,
          provider_count: providers.length,
          guidance: "Ask one short question naming only those candidates.",
        };
      }
      this.record("list_clinic_insurance", "no_match", input);
      return {
        accepts_insurance: true,
        matched: false,
        providers,
        provider_count: providers.length,
        guidance:
          "That insurer is not in the clinic's accepted list. Say so plainly and name the ones " +
          "that are. Never say the clinic accepts an insurer that is not listed.",
      };
    }
    this.record("list_clinic_insurance", "success", input);
    return {
      accepts_insurance: true,
      providers,
      provider_count: providers.length,
      guidance: "Name every insurer in `providers` and none other.",
    };
  }

  async listDepartmentServices(input: { department?: string; all_departments?: boolean }) {
    await this.maybeFail("list_department_services");
    const departments = this.departmentPayload();
    if (input.all_departments === true) {
      const grouped = departments.map((item) => ({
        id: item.id,
        name: item.name,
        services: servicesOf(item.id).map((s) => ({
          name: s.name,
          price: s.price,
          currency: FIXTURE_CURRENCY,
        })),
      }));
      this.offer(
        ...departments.map((d) => d.name),
        ...grouped.flatMap((g) => g.services.map((s) => s.name)),
      );
      this.record("list_department_services", "all_departments", input);
      return {
        found: true,
        scope: "all_departments",
        complete: true,
        departments: grouped,
        currency: FIXTURE_CURRENCY,
        guidance: "List every department and every configured service and price. Invent nothing.",
      };
    }

    let selected = this.establishedDepartmentId
      ? departmentById(this.establishedDepartmentId)
      : null;
    if (input.department) {
      const resolution = resolveNamedEntity(input.department, departments);
      if (resolution.status !== "resolved") {
        this.offer(...departments.map((d) => d.name));
        this.record("list_department_services", `department_${resolution.status}`, input);
        return {
          found: false,
          needs_clarification: true,
          field: "department",
          reason: resolution.status,
          candidates: resolution.candidates
            .filter((item) => item.score >= 0.58)
            .map(({ id, name }) => ({ id, name })),
          departments,
          guidance:
            resolution.status === "ambiguous"
              ? "Ask one short question naming only these plausible departments."
              : "Say that department was not found and offer these active departments.",
        };
      }
      selected = resolution.entity as { id: string; name: string };
    }
    if (!selected) {
      this.offer(...departments.map((d) => d.name));
      this.record("list_department_services", "needs_department", input);
      return {
        found: false,
        needs_selection: true,
        field: "department",
        departments,
        guidance: "Services are configured per department. Ask which department they mean.",
      };
    }
    const services = servicesOf(selected.id).map((s) => ({
      name: s.name,
      price: s.price,
      currency: FIXTURE_CURRENCY,
    }));
    this.offer(selected.name, ...services.map((s) => s.name));
    this.record("list_department_services", "success", input);
    return {
      found: true,
      department: selected,
      services,
      service_count: services.length,
      currency: FIXTURE_CURRENCY,
      guidance:
        "List every service in `services` with its price and currency. Never invent a service or " +
        "a price, and never quote a price this result does not contain.",
    };
  }
}

// ---------------------------------------------------------------------------
// Fixture-local natural-language date/time readers
// ---------------------------------------------------------------------------

/**
 * Maps the patient's day words onto a real offered day, or null.
 *
 * Deliberately refuses rather than guesses: an unreadable day is a clarifying
 * question in production, and a simulator that invented one would hide exactly
 * the failure this suite exists to detect.
 */
/**
 * The date of birth as the production path would have resolved it.
 *
 * `register_patient` runs the raw string through `resolvePatientDate`, which
 * returns `YYYY-MM-DD`; the provenance gate compares ISO to ISO. Reproduced
 * here with the same parser so the harness asks the identical question.
 */
function normalizeIntakeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = parseHumanDate(trimmed, { order: "dmy" });
  return parsed.ok ? parsed.iso : trimmed;
}

export function resolveFixtureDate(raw: string, days: readonly string[]): string | null {
  const text = raw.trim().toLowerCase();
  if (!text || days.length === 0) return null;
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (iso) return days.includes(iso) ? iso : null;
  const western = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  for (const date of days) {
    const day = String(Number(date.slice(8, 10)));
    if (new RegExp(`(^|\\D)${day}(st|nd|rd|th)?(\\D|$)`).test(western)) return date;
  }
  if (/first|earliest|soonest|أول|اول|اقرب|أقرب/.test(text)) return days[0]!;
  // F-16 — Arabizi. "awel yom" is the ordinary Latin-script way to say it, and
  // the fixture's own reader knew every other register's word for "first".
  if (/(?<![a-z])(?:awel|awal|2awel|el2awel|elawel|a2rab|akrab)(?![a-z])/.test(text)) {
    return days[0]!;
  }
  return null;
}

/** Reads a clock time. Never pinned to the offered set — that is the guard's job. */
export function resolveFixtureTime(raw: string): string | null {
  const text = raw.trim().toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!text) return null;
  const explicit = /(\d{1,2})\s*[:.]\s*(\d{2})/.exec(text);
  if (explicit) return `${explicit[1]!.padStart(2, "0")}:${explicit[2]}`;
  // F-15/F-16 — the same Arabizi rule the production reader now applies: a digit
  // glued to a Latin letter is a letter. Without the boundary this found the `3`
  // in "el sa3a 10" and read the whole message as three o'clock, which the
  // offered-slot guard then correctly refused — a booking failed by the
  // harness's own parser rather than by the product.
  const hour = /(?<![a-z])(\d{1,2})(?![a-z])\s*(am|pm|صباح|مساء|عصر)?/.exec(text);
  if (!hour) return null;
  let value = Number(hour[1]);
  if (!Number.isFinite(value) || value > 23) return null;
  const meridiem = hour[2];
  if ((meridiem === "pm" || meridiem === "مساء" || meridiem === "عصر") && value < 12) value += 12;
  return `${String(value).padStart(2, "0")}:00`;
}
