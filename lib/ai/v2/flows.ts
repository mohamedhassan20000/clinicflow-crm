/**
 * The flow definitions: ClinicFlow's business logic, as data.
 *
 * ## How to read this file
 *
 * Each flow is an ordered list of steps. The engine runs the first step whose
 * slot is empty, after checking that step's declared preconditions against the
 * frame's own committed slots and the proven identity level. A step's `run`
 * asks an authoritative tool a question and returns what to put in front of the
 * patient; it never decides what the patient meant and never writes flow state.
 *
 * ## The rule that keeps this from becoming the next patch surface
 *
 * **A step's `run` may branch on server facts. It may never branch on the
 * patient's words.** Reading the message is the interpreter's job and it has
 * already happened; by the time any code here executes, the turn is a validated
 * command list. Every `if` below is therefore about data — is this patient
 * linked, did that read return rows, has the summary been affirmed — and none
 * of them is about phrasing. That is the difference from the engine this
 * replaces, where twelve regex readers ran before the model and five of them
 * could mutate the conversation.
 */

import "server-only";

import type { FlowDefinition, SlotResolution } from "@/lib/ai/v2/flow-definition";
import type { FlowRegistry } from "@/lib/ai/v2/engine";
import type { FlowFrame } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";
import * as tools from "@/lib/ai/v2/tools";
import { proposeLatinName } from "@/lib/ai/name-transliteration";

/** Reads a committed slot's canonical value, or null. */
function slot(frame: FlowFrame, name: Parameters<typeof frameSlot>[1]): string | null {
  return frameSlot(frame, name);
}
function frameSlot(
  frame: FlowFrame,
  name:
    | "department"
    | "doctor"
    | "day"
    | "time"
    | "beneficiary"
    | "beneficiary_name"
    | "date_lower_bound"
    | "full_name"
    | "full_name_latin"
    | "national_id"
    | "date_of_birth"
    | "email"
    | "phone"
    | "gender"
    | "blood_type"
    | "service"
    | "package"
    | "document"
    | "appointment",
): string | null {
  const value = frame.slots[name]?.value;
  return value === undefined ? null : String(value);
}

/**
 * One clinic package, as a sentence.
 *
 * The session count and the price are what a patient actually asks about, so
 * both are included when the clinic has configured them and neither is invented
 * when it has not.
 */
function describePackage(entry: {
  name: string;
  departmentName: string;
  totalSessions: number;
  pricePerSession: number | null;
  totalPrice: number | null;
}): string {
  const parts = [`${entry.name} (${entry.departmentName})`, `${entry.totalSessions} جلسات`];
  if (entry.totalPrice !== null) parts.push(`${entry.totalPrice}`);
  else if (entry.pricePerSession !== null) parts.push(`${entry.pricePerSession}/جلسة`);
  return parts.join(" — ");
}

// ---------------------------------------------------------------------------
// book_appointment
// ---------------------------------------------------------------------------

/**
 * The booking flow.
 *
 * The ladder looks like the old one and is a completely different thing: it
 * belongs to a frame that is actually running. `nextBookingStep` answered
 * "which rung?" for every conversation that had ever existed, including one
 * whose patient had only said hello, and that answer was what pinned a tool.
 * Here there is no frame unless `start_flow` created one, so there is no rung
 * to force.
 */
const bookAppointment: FlowDefinition = {
  name: "book_appointment",
  onAbandon: "confirm",
  public: false,
  steps: [
    {
      // Who the appointment is for, asked once and before anything is
      // collected. Never inferred from the thread's linkage: a linked sender
      // typing "عايز احجز" may well be booking for somebody else, and the old
      // engine's collapse of those two facts is how an appointment landed on
      // the wrong file.
      id: "beneficiary",
      fills: "beneficiary",
      pre: { slots: [], identity: "none" },
      invalidates: ["department", "doctor", "day", "time"],
      resolveValue: async ({ spoken }) => {
        const text = spoken.toLowerCase();
        const forSelf = /(?:نفسي|ليا|لي\b|أنا|انا|myself|for me|me\b)/i.test(text);
        const forOther = /(?:صاحب|صديق|بنتي|ابني|زوج|مرات|والدت|والد|أخت|اخت|أخ\b|for my|someone else|for her|for him)/i.test(text);
        if (forSelf && !forOther) return { kind: "resolved", value: "self" };
        if (forOther && !forSelf) return { kind: "resolved", value: "other" };
        return { kind: "unresolved" };
      },
      run: async () => ({
        kind: "offer",
        slot: "beneficiary",
        offerKind: "slot_value",
        options: [
          { value: "self", label: "self", source: "clinic_directory" },
          { value: "other", label: "other", source: "clinic_directory" },
        ],
        say: "booking.who_is_this_for",
      }),
    },
    {
      id: "department",
      fills: "department",
      pre: { slots: ["beneficiary"], identity: "none" },
      invalidates: ["doctor", "day", "time"],
      resolveValue: async ({ spoken, context }) => {
        const departments = await tools.readDepartments(context);
        const matches = departments.filter((department) =>
          department.label.toLowerCase().includes(spoken.toLowerCase().trim()),
        );
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        // The one place a durable fact is allowed near a booking, and it enters
        // as an offer. A returning patient booking for themself is offered the
        // department they are known in *alongside* the full list; the offer is
        // a suggestion, and the slot stays empty until they answer (I-5).
        const departments = await tools.readDepartments(context);
        if (departments.length === 0) {
          return { kind: "handoff", say: "booking.no_departments" };
        }
        const known =
          frame.slots.beneficiary?.value === "self"
            ? await context.durable.knownDepartments()
            : [];
        const knownIds = new Set(known.map((entry) => entry.value));
        const ordered = [
          ...departments.filter((entry) => knownIds.has(entry.value)),
          ...departments.filter((entry) => !knownIds.has(entry.value)),
        ];
        return {
          kind: "offer",
          slot: "department",
          offerKind: "slot_value",
          options: ordered,
          say: "booking.choose_department",
          facts: { previously_seen: known.length > 0 },
        };
      },
    },
    {
      id: "doctor",
      fills: "doctor",
      pre: { slots: ["department"], identity: "none" },
      invalidates: ["day", "time"],
      resolveValue: async ({ spoken, frame, context }) => {
        const resolved = await tools.resolveDoctorSpoken({
          context,
          spoken,
          departmentId: slot(frame, "department"),
          // The negative constraint, applied at the point of resolution: a
          // doctor the patient ruled out cannot be re-selected even by name.
          excluding: frame.rejected.doctor ?? [],
        });
        return resolved.kind === "resolved"
          ? { kind: "resolved", value: resolved.value, label: resolved.label }
          : resolved.kind === "ambiguous"
            ? { kind: "ambiguous", options: resolved.options }
            : { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const departmentId = slot(frame, "department")!;
        const rejected = frame.rejected.doctor ?? [];
        const roster = await tools.readDoctors({
          context,
          departmentId,
          excluding: rejected,
        });
        if (roster.length === 0) {
          // A question, not a report. `inform` re-advances, and this step fills
          // a slot that nothing has filled — so the flow selected it again on
          // every re-entry. Every "there is nothing available, shall we try X?"
          // below is an `ask` for the same reason: the copy asks the patient
          // something, so the turn has to stop and let them answer it.
          return { kind: "ask", slot: null, say: "booking.no_doctors_left" };
        }
        // The treating doctor is offered *first*, and only for a self-booking,
        // and only when the patient has not already ruled them out. This is the
        // convenience the brief asks for and the exact behaviour the old
        // `prepare_booking` write destroyed by committing it.
        const treating =
          frame.slots.beneficiary?.value === "self"
            ? (await context.durable.treatingDoctors()).filter(
                (doctor) =>
                  !rejected.includes(doctor.value) &&
                  roster.some((entry) => entry.value === doctor.value),
              )
            : [];
        const ordered = [
          ...treating,
          ...roster.filter(
            (entry) => !treating.some((doctor) => doctor.value === entry.value),
          ),
        ];
        return {
          kind: "offer",
          slot: "doctor",
          offerKind: "slot_value",
          options: ordered,
          say: treating.length > 0 ? "booking.choose_doctor_with_previous" : "booking.choose_doctor",
          // The copy for a returning patient asks a yes/no about the first
          // name — "that's the one you saw before, shall we keep them?" — so a
          // bare «اه» has an unambiguous referent and is accepted. The plain
          // roster copy asks no such question and sets no primary, so a yes
          // against it is answered with "which one?", which is correct.
          ...(treating.length > 0 ? { primary: 0 } : {}),
          facts: { has_previous_doctor: treating.length > 0 },
        };
      },
    },
    {
      // The worked precondition from the brief. Unreachable until department
      // and doctor are *committed slots on this live frame*.
      id: "day",
      fills: "day",
      pre: { slots: ["department", "doctor"], identity: "none" },
      invalidates: ["time"],
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await tools.readAvailableDays({
          context,
          doctorId: slot(frame, "doctor")!,
          after: slot(frame, "date_lower_bound"),
        });
        if (!result.ok) return { kind: "unresolved" };
        // A day is committable only if it is a day the server actually offered.
        // The patient's words are matched against real calendar days, never
        // parsed into one.
        const matches = result.days.filter(
          (day) => day.value === spoken.trim() || day.label === spoken.trim(),
        );
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await tools.readAvailableDays({
          context,
          doctorId: slot(frame, "doctor")!,
          after: slot(frame, "date_lower_bound"),
        });
        if (!result.ok) {
          return { kind: "ask", slot: null, say: "booking.calendar_unavailable" };
        }
        if (result.days.length === 0) {
          // A real answer about the clinic, not a failure. The patient is told
          // plainly and offered a wider search or another doctor.
          return {
            kind: "ask",
            slot: null,
            say: "booking.no_days",
            facts: { window_start: result.windowStart, window_end: result.windowEnd },
          };
        }
        return {
          kind: "offer",
          slot: "day",
          offerKind: "slot_value",
          options: result.days,
          say: "booking.choose_day",
          facts: { window_start: result.windowStart, window_end: result.windowEnd },
        };
      },
    },
    {
      id: "time",
      fills: "time",
      pre: { slots: ["department", "doctor", "day"], identity: "none" },
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await tools.readAvailableSlots({
          context,
          doctorId: slot(frame, "doctor")!,
          date: slot(frame, "day")!,
        });
        if (!result.ok) return { kind: "unresolved" };
        const wanted = spoken.trim();
        const matches = result.times.filter(
          (time) => time.value === wanted || time.label === wanted,
        );
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        // Two readings of the same hour — 10 in the morning and 10 at night —
        // is an ambiguity the server owes a question about, not a coin toss.
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await tools.readAvailableSlots({
          context,
          doctorId: slot(frame, "doctor")!,
          date: slot(frame, "day")!,
        });
        if (!result.ok || result.times.length === 0) {
          return { kind: "ask", slot: null, say: "booking.no_times" };
        }
        return {
          kind: "offer",
          slot: "time",
          offerKind: "slot_value",
          options: result.times,
          say: "booking.choose_time",
        };
      },
    },
    {
      /**
       * The package offer, and the decision it records.
       *
       * Runs once, after the appointment is fully specified and before the
       * summary, so the patient is asked about payment for something concrete.
       *
       * **`fills: null`, deliberately.** This step does not settle a slot; it
       * settles a *question*, and the two are not the same. It shipped as
       * `fills: "package"` with `inform` exits, which meant the only way past
       * it was for a real package to be selected — so a patient who owned none,
       * or who declined the one they had, could never reach the summary. Every
       * exit below therefore either asks (and returns next turn to read the
       * answer) or records the decision with `inform`, which is what
       * `nextStep` reads to move on. Nothing here fills `package` with a
       * sentinel: a slot that says a package was chosen when none was is a lie
       * the confirmation step would go on to repeat.
       *
       * **Ownership is a disclosure; booking is not.** Knowing which packages
       * somebody owns is patient-record data and stays at `verified`. But
       * needing that answer must not become a precondition for an ordinary
       * booking — the step's own precondition is `identity: "none"` and the
       * disclosure gate is the check inside `run`, so a `linked` patient books
       * exactly as before and is simply never offered a package. Gating the
       * step itself at `verified` stopped every linked patient at "we need to
       * verify your identity first" on a turn that was about neither.
       *
       * Three properties the brief requires, all structural:
       *
       *   * ownership never selects — the package arrives as an offer and the
       *     slot stays empty unless the patient affirms it;
       *   * a decline is recorded (`package_declined`), so the question is not
       *     asked again on every subsequent turn;
       *   * the offer is skipped entirely when the patient owns no applicable
       *     package, which is the ordinary case and costs nothing.
       */
      id: "package_offer",
      fills: null,
      pre: { slots: ["department", "doctor", "day", "time"], identity: "none" },
      run: async ({ context, frame }) => {
        if (frame.memo.package_accepted === true) {
          // Answered, and answered yes. The `package` slot and the memo were
          // both written by `affirm_offer`; recording the step done is what
          // carries the flow to the summary.
          return { kind: "inform", say: "booking.package_accepted" };
        }
        if (frame.memo.package_declined === true) {
          return { kind: "inform", say: "booking.package_skipped" };
        }
        if (context.identity !== "verified") {
          // The disclosure gate. Not an error and not a question: a booking at
          // `linked` proceeds without a package, and the patient is told
          // nothing about what they may or may not own — including whether
          // there was anything to tell.
          return { kind: "inform", say: "booking.package_not_offered" };
        }
        const packages = await tools.readPatientPackages({
          context,
          departmentId: slot(frame, "department"),
          serviceId: slot(frame, "service"),
        });
        if (packages.length === 0) {
          return { kind: "inform", say: "booking.package_none" };
        }
        return {
          kind: "offer",
          slot: "package",
          // A distinct offer kind, because accepting it is permission to
          // consume a session and must not be confusable with choosing a value.
          offerKind: "package_use",
          options: packages,
          say: "booking.package_offer",
        };
      },
    },
    {
      /**
       * The intake, for a patient with no file.
       *
       * Reached only when the beneficiary has no record here — a stranger, or
       * the friend a linked patient is booking for. `stageIntake` requires a
       * department and a doctor, which this step's precondition guarantees, and
       * it stages for review rather than creating a file outright.
       */
      id: "intake",
      fills: null,
      pre: {
        slots: ["department", "doctor", "day", "time"],
        identity: "none",
      },
      run: async ({ context, frame }) => {
        const needsFile =
          frame.slots.beneficiary?.value === "other" || context.identity === "anonymous";
        if (!needsFile || frame.memo.intake_staged === true) {
          return { kind: "inform", say: "booking.intake_not_needed" };
        }
        const missing = (
          ["full_name", "national_id", "date_of_birth", "email"] as const
        ).filter((field) => !frame.slots[field]);
        if (missing.length > 0) {
          return {
            kind: "ask",
            slot: missing[0]!,
            say: "intake.need_field",
            facts: { field: missing[0]!, remaining: missing.length },
          };
        }
        const staged = await tools.stageIntake({
          context,
          fullName: slot(frame, "full_name_latin") ?? slot(frame, "full_name")!,
          fullNameOriginal: slot(frame, "full_name"),
          nationalId: slot(frame, "national_id")!,
          dateOfBirth: slot(frame, "date_of_birth")!,
          email: slot(frame, "email")!,
          departmentId: slot(frame, "department")!,
          doctorId: slot(frame, "doctor")!,
          forThirdParty: frame.slots.beneficiary?.value === "other",
          phone: slot(frame, "phone"),
          bloodType: slot(frame, "blood_type"),
        });
        if (!staged.ok) return { kind: "handoff", say: "intake.failed" };
        return { kind: "inform", say: "intake.staged" };
      },
    },
    {
      /**
       * The summary and the write.
       *
       * Two turns, always. The first composes the review and offers it; the
       * second — and only after `affirm_offer` has written `confirmed` — calls
       * the booking. There is no path that reaches the write on the same turn
       * as the summary, which is what "no booking before confirmation" means
       * when it is a property rather than a prompt instruction.
       */
      id: "confirm",
      fills: null,
      pre: {
        slots: ["department", "doctor", "day", "time"],
        identity: "linked",
      },
      run: async ({ context, frame }) => {
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "confirm", label: "confirm", source: "clinic_directory" }],
            say: "booking.review",
            facts: {
              doctor: frame.slots.doctor?.label ?? null,
              day: slot(frame, "day"),
              time: slot(frame, "time"),
              uses_package: frame.memo.package_accepted === true,
            },
          };
        }
        const result = await tools.commitBooking({
          context,
          doctorId: slot(frame, "doctor")!,
          scheduledAt: `${slot(frame, "day")}T${slot(frame, "time")}:00`,
          durationMinutes: 30,
          serviceId: slot(frame, "service"),
          // A session is consumed only on an affirmed `package_use` offer.
          // Ownership alone reaches neither this argument nor the decrement.
          packageId:
            frame.memo.package_accepted === true ? String(frame.memo.package_id) : null,
        });
        if (!result.ok) {
          // The slot went while the patient was confirming it. Nothing was
          // created — `create_patient_preliminary_booking` refuses and the
          // package decrement rolls back with it — so the booking is not
          // finished, it is one step behind where it thought it was.
          //
          // `time` goes, and `confirmed` goes with it: the patient consented to
          // a specific appointment, and that consent cannot be carried over to
          // a different one. The engine re-advances straight into the time step,
          // so the same message that says "that one's taken" also offers the
          // times that are not.
          //
          // Everything upstream survives — department, doctor, day, and the
          // package the patient accepted, which was never consumed. They are
          // not asked to build the booking again.
          return {
            kind: "invalidate",
            slots: ["time"],
            memo: ["confirmed", "confirmed_at"],
            say: "booking.slot_gone",
            facts: { reason: result.reason },
          };
        }
        return {
          kind: "complete",
          say: "booking.created",
          facts: {
            doctor: frame.slots.doctor?.label ?? null,
            day: slot(frame, "day"),
            time: slot(frame, "time"),
            package_session: result.packageSessionNumber,
          },
        };
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// register_patient — the unified identity workflow
// ---------------------------------------------------------------------------

/**
 * Registration, and the one place identity is decided.
 *
 * The rules the brief sets out, in the order they are enforced:
 *
 *   1. **the national/civil id is the strongest discovery key.** It is asked
 *      for first and matched exactly, by `find_clinic_patient_by_identity`;
 *   2. **an exact id plus a plausible rendering of the name continues the
 *      existing file** rather than opening a second one. `resolveIdentity`
 *      returning `matched` ends the flow — there is no branch below it that
 *      creates anything;
 *   3. **a genuinely new file with an uncertain name asks for the Latin
 *      spelling before it is created**, using the existing `proposeLatinName`
 *      and the P10 behaviour of keeping the original beside it;
 *   4. **nothing is disclosed about anyone else.** Every non-match is the same
 *      `none`, so a caller cannot tell "no such id" from "that id belongs to
 *      somebody whose name you got wrong". The anti-existence-oracle property
 *      is a consequence of the RPC's shape, not of a check here.
 */
const registerPatient: FlowDefinition = {
  name: "register_patient",
  onAbandon: "confirm",
  public: true,
  steps: [
    {
      id: "full_name",
      fills: "full_name",
      pre: { slots: [], identity: "none" },
      invalidates: ["full_name_latin"],
      run: async () => ({ kind: "ask", slot: "full_name", say: "intake.ask_name" }),
    },
    {
      id: "national_id",
      fills: "national_id",
      pre: { slots: ["full_name"], identity: "none" },
      resolveValue: async ({ spoken }) => {
        const digits = spoken.replace(/[^0-9]/g, "");
        // Length is the only shape check here. Whether it names anybody is the
        // database's question, and asking it is the next step.
        return digits.length >= 10 && digits.length <= 20
          ? { kind: "resolved", value: digits }
          : { kind: "unresolved" };
      },
      run: async () => ({ kind: "ask", slot: "national_id", say: "intake.ask_national_id" }),
    },
    {
      id: "identity_check",
      fills: null,
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      run: async ({ context, frame }) => {
        if (frame.memo.identity_checked === true) {
          return { kind: "inform", say: "identity.already_checked" };
        }
        const resolution = await tools.resolveIdentity({
          context,
          nationalId: slot(frame, "national_id")!,
          fullName: slot(frame, "full_name")!,
        });
        if (resolution.kind === "matched") {
          // The existing file, continued. Nothing is created, and the canonical
          // name on record is what the assistant may greet them by — the name
          // ClinicFlow stores, never the one the patient typed.
          return {
            kind: "complete",
            say: "identity.existing_patient",
            facts: { canonical_name: resolution.canonicalName },
          };
        }
        if (resolution.kind === "ambiguous_department") {
          return {
            kind: "offer",
            slot: "department",
            offerKind: "identity_match",
            options: resolution.departments.map((department) => ({
              value: department.id,
              label: department.name,
              source: "identity_match" as const,
            })),
            say: "identity.which_department",
            facts: { canonical_name: resolution.canonicalName },
          };
        }
        return { kind: "inform", say: "identity.new_patient" };
      },
    },
    {
      /**
       * The Latin spelling, asked before a new file is created.
       *
       * Only on the *new patient* path — step 3 above ends the flow for a
       * matched one, so this can never fire for somebody who already has a
       * record. `proposeLatinName` returns null when the name is already
       * unambiguous Latin, and the step is skipped.
       */
      id: "full_name_latin",
      fills: "full_name_latin",
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      run: async ({ frame }) => {
        const typed = slot(frame, "full_name")!;
        const proposal = proposeLatinName(typed);
        if (!proposal) {
          // Nothing readable to propose. Ask outright rather than file a guess.
          return { kind: "ask", slot: "full_name_latin", say: "intake.ask_latin_name" };
        }
        if (!proposal.needsConfirmation) {
          // Every part had a curated reading, so the spelling is a derivation
          // from a name the patient already gave rather than a guess about it.
          // Filing it silently is correct and costs them no turn; the engine
          // re-advances straight to the next question.
          return {
            kind: "fill",
            slot: "full_name_latin",
            value: proposal.proposed,
            label: proposal.proposed,
          };
        }
        // At least one part is a character-level guess — a missing letter, an
        // Arabic spelling with no settled English form, a transliteration that
        // could go two ways. The brief's rule applies: confirm before creating
        // the file. The original stays beside it either way (P10), so nothing
        // the patient wrote is lost.
        return {
          kind: "offer",
          slot: "full_name_latin",
          offerKind: "slot_value",
          options: [
            {
              value: proposal.proposed,
              label: proposal.proposed,
              source: "clinic_directory" as const,
            },
          ],
          say: "intake.confirm_latin_name",
          facts: {
            proposed: proposal.proposed,
            typed,
            uncertain_parts: proposal.uncertainParts,
          },
        };
      },
    },
    {
      id: "date_of_birth",
      fills: "date_of_birth",
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      run: async () => ({ kind: "ask", slot: "date_of_birth", say: "intake.ask_dob" }),
    },
    {
      id: "email",
      fills: "email",
      pre: { slots: ["full_name", "national_id", "date_of_birth"], identity: "none" },
      run: async () => ({ kind: "ask", slot: "email", say: "intake.ask_email" }),
    },
    {
      id: "done",
      fills: null,
      pre: {
        slots: ["full_name", "full_name_latin", "national_id", "date_of_birth", "email"],
        identity: "none",
      },
      // Registration on its own stages nothing: a file exists to hold a
      // request, and the booking flow's intake step is what stages it against
      // one. Ending here rather than writing keeps a single staging path.
      run: async () => ({ kind: "complete", say: "intake.collected" }),
    },
  ],
};

// ---------------------------------------------------------------------------
// answer_question — every read-only topic
// ---------------------------------------------------------------------------

const answerQuestion: FlowDefinition = {
  name: "answer_question",
  onAbandon: "discard",
  public: true,
  steps: [
    {
      id: "answer",
      fills: null,
      // `identity: "none"` is correct for the flow; the three patient-scoped
      // topics check identity themselves below and refuse rather than
      // disclosing, because the requirement varies per topic rather than per
      // flow.
      pre: { slots: [], identity: "none" },
      run: async ({ context, frame }) => {
        const topic = frame.topic;
        switch (topic) {
          case "departments": {
            const departments = await tools.readDepartments(context);
            return {
              kind: "complete",
              say: "info.departments",
              facts: { departments: departments.map((entry) => entry.label) },
            };
          }
          case "doctors": {
            const departmentId = slot(frame, "department");
            if (!departmentId) {
              const departments = await tools.readDepartments(context);
              return {
                kind: "offer",
                slot: "department",
                offerKind: "slot_value",
                options: departments,
                say: "info.which_department",
              };
            }
            const doctors = await tools.readDoctors({ context, departmentId });
            return {
              kind: "complete",
              say: "info.doctors",
              facts: { doctors: doctors.map((entry) => entry.label) },
            };
          }
          case "packages": {
            // A stranger's package question is answered from clinic
            // configuration. A patient's own packages are `my_packages`, a
            // different topic with a different identity requirement — the two
            // are separate so no argument mistake can turn one into the other.
            const packages = await tools.readPublicPackages({ context });
            return {
              kind: "complete",
              say: "info.packages",
              // Rendered here rather than in the composer: the composer fills
              // placeholders and must never have to know the shape of a
              // domain row.
              facts: { packages: packages.map(describePackage) },
            };
          }
          case "my_packages": {
            if (context.identity !== "verified") {
              return { kind: "ask", slot: null, say: "identity.required", facts: { level: "verified" } };
            }
            const packages = await tools.readPatientPackages({ context });
            return {
              kind: "complete",
              say: "info.my_packages",
              facts: { packages: packages.map((entry) => entry.label) },
            };
          }
          case "my_appointments": {
            if (context.identity !== "verified") {
              return { kind: "ask", slot: null, say: "identity.required", facts: { level: "verified" } };
            }
            const appointments = await tools.readMyAppointments(context);
            return {
              kind: "complete",
              say: "info.my_appointments",
              facts: { count: appointments.length, appointments },
            };
          }
          case "my_documents":
            // Delegated rather than duplicated: retrieving a document is a flow
            // with a selection step in it, not a one-shot answer.
            return { kind: "complete", say: "info.see_documents_flow" };
          case "privacy":
            return { kind: "complete", say: "info.privacy" };
          case "prices":
          case "services": {
            const departments = await tools.readDepartments(context);
            return {
              kind: "complete",
              say: topic === "prices" ? "info.prices" : "info.services",
              facts: { departments: departments.map((entry) => entry.label) },
            };
          }
          default: {
            const info = await tools.readClinicInfo(context);
            if (!info) return { kind: "inform", say: "info.unavailable" };
            return { kind: "complete", say: `info.${topic ?? "clinic_other"}`, facts: { clinic: info } };
          }
        }
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// package_inquiry, retrieve_document, cancel, reschedule, relationship lookup
// ---------------------------------------------------------------------------

const packageInquiry: FlowDefinition = {
  name: "package_inquiry",
  onAbandon: "discard",
  public: true,
  steps: [
    {
      id: "list",
      fills: null,
      pre: { slots: [], identity: "none" },
      run: async ({ context, frame }) => {
        const packages = await tools.readPublicPackages({
          context,
          departmentId: slot(frame, "department"),
        });
        return {
          kind: "complete",
          say: "info.packages",
          facts: { packages: packages.map(describePackage) },
        };
      },
    },
  ],
};

/**
 * Document retrieval — delivery only, never issuance.
 *
 * `verified` on every step, because a document is the patient's own record.
 * The list comes from `list_patient_ai_documents`, which selects only
 * `status = 'issued'` rows belonging to the conversation's own patient, so
 * there is no argument by which another person's document could be listed and
 * no branch anywhere that creates one. A patient asking to be *issued*
 * something new never reaches this flow: the interpreter is instructed to emit
 * `request_handoff`, and even if it did not, no step here can write.
 */
const retrieveDocument: FlowDefinition = {
  name: "retrieve_document",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "document",
      pre: { slots: [], identity: "verified" },
      run: async ({ context }) => {
        const documents = await tools.readPatientDocuments({ context });
        if (documents.length === 0) {
          return { kind: "complete", say: "documents.none" };
        }
        return {
          kind: "offer",
          slot: "document",
          offerKind: "document_choice",
          options: documents,
          say: "documents.choose",
        };
      },
    },
    {
      id: "deliver",
      fills: null,
      pre: { slots: ["document"], identity: "verified" },
      run: async ({ context, frame }) => {
        const link = await tools.readDocumentLink({
          context,
          documentId: slot(frame, "document")!,
        });
        if (!link) return { kind: "inform", say: "documents.unavailable" };
        return {
          kind: "complete",
          say: "documents.delivered",
          facts: { url: link.url, label: link.label },
        };
      },
    },
  ],
};

/**
 * Grounds a spoken appointment reference against the patient's own list.
 *
 * Shared by cancel and reschedule. Without it, `set_slot(appointment, …)`
 * committed whatever the patient said as an appointment id — the same
 * ungrounded-commit class as the reschedule date. The write behind it would
 * have refused, so nothing unsafe reached the database; but "I couldn't cancel
 * that, the team will help" is a much worse answer than "which one?", and a
 * slot that holds a phrase where an id belongs is a lie the rest of the flow
 * reads as truth.
 */
async function resolveSpokenAppointment(input: {
  spoken: string;
  context: TurnContext;
}): Promise<SlotResolution> {
  const appointments = await tools.readMyAppointments(input.context);
  const options = appointments.map((appointment) => ({
    value: String(appointment.appointment_id ?? appointment.id),
    label: String(appointment.scheduled_at ?? ""),
    source: "patient_appointments" as const,
  }));
  const wanted = input.spoken.trim();
  const matches = options.filter(
    (option) => option.value === wanted || option.label === wanted,
  );
  if (matches.length === 1) {
    return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
  }
  if (matches.length > 1) return { kind: "ambiguous", options: matches };
  return { kind: "unresolved" };
}

const cancelAppointment: FlowDefinition = {
  name: "cancel_appointment",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "appointment",
      pre: { slots: [], identity: "linked" },
      resolveValue: resolveSpokenAppointment,
      run: async ({ context }) => {
        const appointments = await tools.readMyAppointments(context);
        if (appointments.length === 0) {
          return { kind: "complete", say: "appointments.none" };
        }
        return {
          kind: "offer",
          slot: "appointment",
          offerKind: "slot_value",
          options: appointments.map((appointment) => ({
            value: String(appointment.appointment_id ?? appointment.id),
            label: String(appointment.scheduled_at ?? ""),
            source: "patient_appointments" as const,
          })),
          say: "cancel.choose",
        };
      },
    },
    {
      id: "confirm",
      fills: null,
      pre: { slots: ["appointment"], identity: "linked" },
      run: async ({ context, frame }) => {
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "cancel", label: "cancel", source: "clinic_directory" }],
            say: "cancel.review",
          };
        }
        const result = await tools.commitCancellation({
          context,
          appointmentId: slot(frame, "appointment")!,
        });
        // The copy says the clinic team will help. Before, nothing made that
        // true: `inform` ended the turn with a promise nobody was on the other
        // end of. A failed write here is not something the patient can retry
        // their way out of, so it hands over — which is what the sentence has
        // always claimed.
        return result.ok
          ? { kind: "complete", say: "cancel.done" }
          : { kind: "handoff", say: "cancel.failed" };
      },
    },
  ],
};

/**
 * Reschedule — the same grounding discipline as booking, for the same reason.
 *
 * Days and times come from the clinic's own calendar, read against the doctor
 * `prepare_patient_ai_reschedule` reports for this appointment, and the
 * patient's words are *matched* against what was offered rather than parsed
 * into a date. The version this replaces had no resolver on `day` at all, so
 * "بكرة" was committed verbatim and handed to an RPC that does not take a date;
 * the `time` step then offered the appointment row itself as a time option.
 *
 * `memo.reschedule_*` holds the server-issued identifiers between turns —
 * scalars the server put there, never anything the model wrote — so the
 * calendar reads on the day and time steps ask about the same doctor the
 * confirmation will move.
 */
const rescheduleAppointment: FlowDefinition = {
  name: "reschedule_appointment",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "appointment",
      pre: { slots: [], identity: "linked" },
      resolveValue: resolveSpokenAppointment,
      invalidates: ["day", "time"],
      run: async ({ context }) => {
        const appointments = await tools.readMyAppointments(context);
        if (appointments.length === 0) {
          return { kind: "complete", say: "appointments.none" };
        }
        return {
          kind: "offer",
          slot: "appointment",
          offerKind: "slot_value",
          options: appointments.map((appointment) => ({
            value: String(appointment.appointment_id ?? appointment.id),
            label: String(appointment.scheduled_at ?? ""),
            source: "patient_appointments" as const,
          })),
          say: "reschedule.choose",
        };
      },
    },
    {
      id: "day",
      fills: "day",
      pre: { slots: ["appointment"], identity: "linked" },
      invalidates: ["time"],
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await rescheduleDays(context, frame);
        if (!result.ok) return { kind: "unresolved" };
        // Committable only if the server offered it. Same rule as booking.
        const wanted = spoken.trim();
        const matches = result.days.filter(
          (day) => day.value === wanted || day.label === wanted,
        );
        return matches.length === 1
          ? { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label }
          : { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await rescheduleDays(context, frame);
        // The appointment could not be resolved at all — a cancelled row, a
        // verification that lapsed. Nothing the patient can answer, so a person
        // takes it rather than the flow asking a question with no answer.
        if (!result.ok) return { kind: "handoff", say: "reschedule.unavailable" };
        if (result.days.length === 0) {
          return { kind: "ask", slot: null, say: "reschedule.no_days" };
        }
        return {
          kind: "offer",
          slot: "day",
          offerKind: "slot_value",
          options: result.days,
          say: "reschedule.choose_day",
        };
      },
    },
    {
      id: "time",
      fills: "time",
      pre: { slots: ["appointment", "day"], identity: "linked" },
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await rescheduleTimes(context, frame);
        if (!result.ok) return { kind: "unresolved" };
        const wanted = spoken.trim();
        const matches = result.times.filter(
          (time) => time.value === wanted || time.label === wanted,
        );
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await rescheduleTimes(context, frame);
        if (!result.ok || result.times.length === 0) {
          return { kind: "ask", slot: null, say: "reschedule.no_times" };
        }
        return {
          kind: "offer",
          slot: "time",
          offerKind: "slot_value",
          options: result.times,
          say: "reschedule.choose_time",
        };
      },
    },
    {
      id: "confirm",
      fills: null,
      pre: { slots: ["appointment", "day", "time"], identity: "linked" },
      run: async ({ context, frame }) => {
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "reschedule", label: "reschedule", source: "clinic_directory" }],
            say: "reschedule.review",
            facts: { day: slot(frame, "day"), time: slot(frame, "time") },
          };
        }
        // Day and time are separate committed slots and the RPC takes one
        // instant. Composed here from both, exactly as the booking flow does —
        // the version this replaces sent the bare time, which is not a
        // timestamp at all.
        const result = await tools.commitReschedule({
          context,
          appointmentId: slot(frame, "appointment")!,
          scheduledAt: `${slot(frame, "day")}T${slot(frame, "time")}:00`,
        });
        return result.ok
          ? {
              kind: "complete",
              say: "reschedule.done",
              facts: { day: slot(frame, "day"), time: slot(frame, "time") },
            }
          : { kind: "handoff", say: "reschedule.failed" };
      },
    },
  ],
};

/**
 * The appointment this reschedule is about, resolved from the committed slot.
 *
 * Read on every calendar access rather than cached on the frame. Caching it
 * would create a staleness class the flow has no way to invalidate: `choose`
 * declares `invalidates: ["day", "time"]`, but the correction cascade clears
 * *slots*, not memo entries, so a patient who changed their mind about which
 * appointment to move would have kept the previous one's doctor and been shown
 * the wrong diary. One extra read per calendar step is the cheaper side of that
 * trade by a wide margin.
 */
async function rescheduleTarget(context: TurnContext, frame: FlowFrame) {
  const appointmentId = slot(frame, "appointment");
  if (!appointmentId) return null;
  const target = await tools.readRescheduleTarget({ context, appointmentId });
  return target.ok ? target : null;
}

async function rescheduleDays(context: TurnContext, frame: FlowFrame) {
  const target = await rescheduleTarget(context, frame);
  if (!target) return { ok: false as const, reason: "no_target" };
  return tools.readAvailableDays({
    context,
    doctorId: target.doctorId,
    serviceId: target.serviceId,
    durationMinutes: target.durationMinutes,
  });
}

async function rescheduleTimes(context: TurnContext, frame: FlowFrame) {
  const target = await rescheduleTarget(context, frame);
  const date = slot(frame, "day");
  if (!target || !date) return { ok: false as const, reason: "no_target" };
  return tools.readAvailableSlots({
    context,
    doctorId: target.doctorId,
    date,
    serviceId: target.serviceId,
    durationMinutes: target.durationMinutes,
  });
}

/**
 * "مين الدكتور اللي كنت بتابع معاه؟" — the explicit history question.
 *
 * A flow of its own precisely because it is the one turn on which the patient's
 * treating doctor is *the answer* rather than a suggestion. It requires
 * `verified`, because naming the doctor somebody has been seeing is a
 * disclosure about their record. It starts no booking and offers nothing.
 */
const patientRelationshipLookup: FlowDefinition = {
  name: "patient_relationship_lookup",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "lookup",
      fills: null,
      pre: { slots: [], identity: "verified" },
      run: async ({ context }) => {
        const doctors = await context.durable.treatingDoctors();
        if (doctors.length === 0) {
          return { kind: "complete", say: "relationship.none" };
        }
        return {
          kind: "complete",
          say: "relationship.doctors",
          facts: { doctors: doctors.map((doctor) => doctor.label) },
        };
      },
    },
  ],
};

export const FLOW_REGISTRY: FlowRegistry = {
  book_appointment: bookAppointment,
  register_patient: registerPatient,
  answer_question: answerQuestion,
  package_inquiry: packageInquiry,
  retrieve_document: retrieveDocument,
  cancel_appointment: cancelAppointment,
  reschedule_appointment: rescheduleAppointment,
  patient_relationship_lookup: patientRelationshipLookup,
};
