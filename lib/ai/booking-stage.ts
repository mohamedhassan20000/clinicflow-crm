/**
 * P9 — the booking workflow, as a type instead of as prose.
 *
 * `collected-state.ts` already answers "what has the patient told us?" at the
 * level of individual fields. What has never existed anywhere in the system is
 * an answer to "where in the booking are we?" — that lived only as English and
 * Arabic sentences inside a ~4,000-token system prompt, and was re-derived ad
 * hoc, three different ways, inside `prepare-booking.ts`, `list-doctors.ts` and
 * `list-available-days.ts`.
 *
 * This module is that answer, and it is deliberately a *pure* one: no database,
 * no `server-only`, no clock it does not receive, no I/O. Every function here is
 * a total function of its arguments, which is what makes the whole workflow
 * exhaustively testable as a table rather than as a conversation.
 *
 * ## The three rules that shape everything below
 *
 * **1. The stage is derived from facts, never read from storage.**
 * `deriveStage()` computes the stage from the collected fields and the identity
 * facts the *server* resolved this turn. The persisted record contributes only
 * things that cannot be derived — the latches (`submitted`, `escalated`,
 * `intake_staged`), the counters, and the record of what was actually offered.
 * A stale, corrupted or model-influenced stage value therefore cannot unlock a
 * tool: at worst it makes the illegal-transition counter tick.
 *
 * **2. Nothing here is an authorization input.** There is no `patientId`, no
 * `clinicId`, no `verified` flag, and no place to put one — `BookingStageState`
 * has a closed shape and `parseBookingStageState` rebuilds it key by key against
 * that shape, exactly as `parseCollectedData` does. Every tool still calls
 * `authorizePatientConversation()` and still re-derives identity from
 * `resolvePatientAiContext` on every single call. `identityVerified` appears in
 * `StageFacts` as an *input the server just computed*, never as something read
 * back out of the stored record.
 *
 * **3. Narrowing only.** `allowedToolsForStage()` returns a subset of the tools
 * that are already mounted. It is wired through the AI SDK's `activeTools`, so
 * the containment property the P6A injection corpus asserts — an unauthorized
 * tool is never in the mount at all — is untouched: a stage can only ever hide
 * a tool the persona was already allowed to call.
 */

import type { BookingBeneficiary } from "@/lib/ai/booking-beneficiary";
import type { CollectedData, SlotField } from "@/lib/ai/collected-state";
import { resolveOptionIndex } from "@/lib/ai/entity-resolution";

// ---------------------------------------------------------------------------
// The stages
// ---------------------------------------------------------------------------

/**
 * The ten stages of a patient booking conversation.
 *
 * Ordered as the happy path runs, with the two terminals last. `idle` is not
 * "nothing is happening" — it is "this conversation has not expressed a booking
 * intent yet", which is the state a pure FAQ turn stays in forever.
 */
export const BOOKING_STAGES = [
  "idle",
  "identifying",
  "intake_collecting",
  "selecting_department",
  "selecting_doctor",
  "selecting_day",
  "selecting_time",
  "confirming",
  "submitted",
  "escalated",
] as const;

export type BookingStage = (typeof BOOKING_STAGES)[number];

const BOOKING_STAGE_SET: ReadonlySet<string> = new Set(BOOKING_STAGES);

export function isBookingStage(value: unknown): value is BookingStage {
  return typeof value === "string" && BOOKING_STAGE_SET.has(value);
}

// ---------------------------------------------------------------------------
// The persisted record
// ---------------------------------------------------------------------------

/**
 * One tool call, reduced to what is safe to keep.
 *
 * A tool *name* and an outcome *label*, both drawn from closed sets, plus an
 * instant. No arguments, no results, no free text — this record is written to a
 * jsonb column and read back into audit telemetry, and neither is a place for a
 * patient's words.
 */
export type BookingStageToolOutcome = {
  tool: string;
  outcome: string;
  at: string;
};

/**
 * The server-owned metadata that travels with a conversation between turns.
 *
 * Everything in here is written by ClinicFlow and by nothing else. In
 * particular the model has no tool, no argument and no prompt through which it
 * can name a stage, add an offered slot, or move a latch — every field is set
 * from a server-computed value in `booking-stage-store.ts`.
 */
export type BookingStageState = {
  /** The stage as of the *end* of the previous turn. Advisory: see rule 1. */
  stage: BookingStage;
  /** When the conversation entered `stage`. ISO instant. */
  stageEnteredAt: string;
  /**
   * V2-CONTAINMENT — when an inbound turn last reached this booking.
   *
   * Distinct from `stageEnteredAt`, which moves only when the stage does and
   * therefore says nothing about whether anybody is still talking. This is the
   * silence clock {@link isBookingStateStale} reads. Null on a record written
   * before the field existed, which reads as *unknown* rather than as stale.
   */
  lastTurnAt: string | null;
  /** Inbound turns observed by the stage machine on this conversation. */
  turnCount: number;
  /**
   * Latches. Not derivable from `ai_collected_data`, so they are the one thing
   * the record genuinely carries rather than mirrors.
   */
  intakeStaged: boolean;
  submitted: boolean;
  escalated: boolean;
  /**
   * P9C — this conversation is booking for somebody other than the sender.
   *
   * A latch, and necessarily one: it is the single fact about a third-party
   * booking that `ai_collected_data` cannot carry, because the collected fields
   * describe the *sender*. Without it a linked patient booking for a friend
   * derives as `selecting_day` and `register_patient` is never mounted, so the
   * friend can never be staged and the appointment has nowhere to go but the
   * sender's own record.
   */
  bookingForOther: boolean;
  /**
   * Who this booking draft is *for*, as the patient themself said it.
   *
   * Separate from `bookingForOther` on purpose. That latch answers "does this
   * need a new file?"; this one records that the question was *put and
   * answered*, which is the fact the beneficiary question is gated on. Without
   * it there is nothing to distinguish "the patient said it is for them" from
   * "nobody ever asked", and a linked sender's `patient_id` silently filled the
   * gap — see `booking-beneficiary.ts`.
   *
   * Null means unestablished. Never set from linkage, only from words.
   */
  beneficiary: BookingBeneficiary | null;
  /**
   * The day an amendment is waiting on an answer about, and the times that were
   * genuinely bookable on it.
   *
   * State rather than a per-turn value for the same reason
   * `pendingNameConfirmation` is: «تقصد 10 صباحًا ولا 10 مساءً؟» and «الصبح» are
   * two different turns, and the second carries neither an hour nor a day. It
   * does the same work for the other half-finished amendment — the requested
   * time was taken, alternatives on *that* day were offered, and the patient
   * picks one — which without a record would be matched against the day the
   * draft still holds.
   *
   * Every time in here came from a live availability read on the turn it was
   * written, so an answer resolved against it can only ever land on a slot the
   * clinic actually had free.
   */
  pendingAmendmentTime: { date: string; times: readonly string[] } | null;
  /**
   * P11J — isolated, server-owned intake memory for the person being booked.
   *
   * These values never merge into `ai_collected_data`, whose identity is the
   * sender. They exist so a parent/friend can provide two details per message
   * without the model having to reconstruct PHI from an increasingly long
   * transcript, and so no sender field can silently fill a third-party field.
   */
  thirdPartyIntake: ThirdPartyIntakeDraft | null;
  /**
   * P11J-2 — the last intake question this conversation asked, and how many
   * times in a row it has asked it.
   *
   * The no-loop invariant needs a memory: without one, "which details are still
   * unreadable?" is recomputed from scratch every turn and an answer the parser
   * cannot read produces the identical question forever, which is what a patient
   * experiences as the assistant ignoring them. The signature is the sorted list
   * of outstanding field keys — schema constants, never anything the patient
   * wrote — so nothing here is PHI.
   */
  intakeAsk: IntakeAskRecord | null;
  /**
   * The English spelling of a new patient's name that has been *shown* to them
   * and is waiting on their answer.
   *
   * Deliberately state rather than a per-turn value, for the same reason
   * `pendingSelection` is: the proposal and the answer to it are two different
   * turns, and without a record the second turn has nothing to resolve against
   * but the model's reading of the transcript. `proposed` is always a value the
   * server itself composed (`proposeLatinName`), never one the model wrote.
   */
  pendingNameConfirmation: NameConfirmationDraft | null;
  /**
   * Latch: the patient has settled the Latin spelling of their name — either by
   * confirming the proposal or by supplying their own. Once set, the stored
   * name is authoritative for this intake and is never transliterated again.
   */
  nameSpellingConfirmed: boolean;
  /**
   * How many times the blood-type question has been asked on this intake, and
   * whether it has been answered or explicitly declined.
   *
   * Blood type stays optional — `bloodTypeResolved` is set by "لا أعرف" exactly
   * as it is by "O+" — but the *asking* is not: a new patient file used to be
   * staged without the question ever being put, which is what manual QA found.
   */
  bloodTypeAsks: number;
  bloodTypeResolved: boolean;
  /** Doctor ids actually presented to the patient by a roster tool. */
  offeredDoctorIds: readonly string[];
  /** Days actually presented, `YYYY-MM-DD`. */
  offeredDays: readonly string[];
  /** Last seven-day availability window shown; powers deterministic next-window navigation. */
  availabilityWindowStart?: string | null;
  availabilityWindowEnd?: string | null;
  /**
   * Slots actually presented, `YYYY-MM-DDTHH:mm` in the clinic's timezone.
   *
   * This is the anti-hallucination record. `create_preliminary_booking`
   * refuses a time that is not in here once anything is in here — see
   * `checkOfferedSlot`.
   */
  offeredSlots: readonly string[];
  /**
   * P11B — the half-finished "when is my appointment?" identity check.
   *
   * A patient may answer "عايز أعرف ميعادي" with their name on one turn and
   * their national id on the next, and the lookup needs both in one call. Before
   * this, the only thing carrying the first value across the turn was the
   * model's own view of the transcript — the same unreliable channel this phase
   * exists to stop trusting — and a model that lost it re-asked, or worse, slid
   * into new-patient registration for somebody who already has a file.
   *
   * Deliberately **not** in `ai_collected_data`. That object is the booking and
   * registration state: a name written there is a name `register_patient` will
   * open a file with, and `prepare_booking` reads it as the person being booked.
   * A value supplied to *identify an existing record* must not be able to become
   * a value used to *create* one, so it lives in its own slot in a different
   * column, is read only by `lookup_appointment`, and is erased the moment the
   * lookup resolves either way.
   */
  appointmentLookup: AppointmentLookupDraft | null;
  /**
   * A verified, read-only reschedule proposal. The original appointment and
   * replacement slot both come from server reads; the model cannot manufacture
   * either half. It remains a proposal until a later explicit-confirmation
   * turn calls the dedicated mutation tool.
   */
  appointmentChange: AppointmentChangeDraft | null;
  /**
   * F-2 — the competing readings of an answer the server could not narrow to
   * one, carried to the turn that asks about them and cleared the moment
   * anything commits.
   *
   * It is deliberately *state* rather than a per-turn value. The clarification
   * and the answer to it are two different turns, and without a record the
   * second turn has nothing to resolve against except the model's reading of the
   * transcript — the exact channel the whole stage machine exists to stop
   * trusting. Ids and names only, both of which the server itself offered.
   */
  pendingSelection: PendingSelection | null;
  /**
   * P12 — the booking rung this conversation was on when the patient asked
   * about something else, held so it can be resumed exactly.
   *
   * A side question does not clear the booking: `ai_collected_data` and every
   * latch survive it untouched. What did *not* survive was the knowledge that
   * an interruption happened at all, so the turn after it had no way to tell
   * «اه» meaning "yes, carry on with the booking" from «اه» meaning an answer to
   * whatever the booking last asked — and the model, having only the transcript,
   * frequently restarted the funnel or skipped a rung.
   *
   * `step` is a ladder rung (a schema constant, never patient words) and
   * `offeredResume` records that the assistant actually put «تحب نكمل الحجز؟»
   * to them, which is what makes the next turn's agreement readable. Null
   * whenever no booking is interrupted.
   */
  interruptedBooking: InterruptedBooking | null;
  /** The last tool the stage machine saw, for the per-turn trace. */
  lastToolOutcome: BookingStageToolOutcome | null;
  /** How many times a turn moved between two stages with no legal edge. */
  illegalTransitions: number;
};

/** Caps. The column is bounded at 4 KB; these keep it far below that. */
const MAX_OFFERED_DOCTORS = 24;
const MAX_OFFERED_DAYS = 60;
const MAX_OFFERED_SLOTS = 120;
const MAX_TURN_COUNT = 1_000_000;

/**
 * One or both halves of an appointment-identity check, as the patient wrote
 * them. Never evidence: the server folds and matches both, exactly as it did
 * when they arrived in a single call.
 */
/**
 * F-2 — an ambiguous selection the server owes the patient a question about.
 *
 * `candidates` is always a subset of what a server tool actually offered:
 * `resolveOfferedDoctor` is closed over the offered roster and structurally
 * cannot return anybody else, so nothing downstream can widen it into a name
 * this conversation has never seen.
 */
export type PendingSelection = {
  field: "doctor";
  candidates: readonly { id: string; name: string }[];
};

const MAX_PENDING_CANDIDATES = 6;
const MAX_CANDIDATE_NAME = 120;

function parsePendingSelection(value: unknown): PendingSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.field !== "doctor") return null;
  if (!Array.isArray(raw.candidates)) return null;
  const candidates: { id: string; name: string }[] = [];
  for (const item of raw.candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!UUID_RE.test(id) || !name) continue;
    candidates.push({ id, name: name.slice(0, MAX_CANDIDATE_NAME) });
    if (candidates.length >= MAX_PENDING_CANDIDATES) break;
  }
  return candidates.length > 1 ? { field: "doctor", candidates } : null;
}

/**
 * A booking paused by a side question. Rung labels only — nothing here is PHI.
 */
export type InterruptedBooking = {
  /** The ladder rung the booking was on, e.g. "doctor", "day", "confirm". */
  step: string;
  /** True once the assistant has asked whether to continue. */
  offeredResume: boolean;
};

const BOOKING_STEP_RE = /^[a-z_]{1,32}$/;

function parseInterruptedBooking(value: unknown): InterruptedBooking | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const step = typeof raw.step === "string" ? raw.step.trim() : "";
  if (!BOOKING_STEP_RE.test(step)) return null;
  return { step, offeredResume: raw.offeredResume === true };
}

export type AppointmentLookupDraft = {
  fullName: string | null;
  nationalId: string | null;
};

export type AppointmentChangeDraft = {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  departmentId: string | null;
  serviceId: string | null;
  durationMinutes: number;
  date: string;
  time: string | null;
};

/**
 * A Latin-script name proposed to the patient, beside what they actually wrote.
 *
 * Both halves come from `proposeLatinName`, which is a lookup over a curated
 * table plus a plain character mapping. Nothing here is model output.
 */
export type NameConfirmationDraft = {
  proposed: string;
  original: string;
};

const MAX_CONFIRMATION_NAME = 120;

function parseNameConfirmation(value: unknown): NameConfirmationDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const read = (field: unknown): string | null => {
    if (typeof field !== "string") return null;
    const trimmed = field.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_CONFIRMATION_NAME ? trimmed : null;
  };
  const proposed = read(raw.proposed);
  const original = read(raw.original);
  return proposed ? { proposed, original: original ?? proposed } : null;
}

/** Three identical asks is a loop; the field is optional, so it stops asking. */
export const MAX_BLOOD_TYPE_ASKS = 3;

export type IntakeAskRecord = {
  /** Sorted, comma-joined field keys. A schema constant, not patient data. */
  signature: string;
  /** Consecutive turns this exact question has been asked. */
  repeats: number;
};

export type ThirdPartyIntakeDraft = {
  fullName: string | null;
  nationalId: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  bloodType: string | null;
  nameSpellingConfirmed: boolean;
};

/** Caps for the lookup draft, matching the tool's own input schema. */
const MAX_LOOKUP_NAME = 120;
const MAX_LOOKUP_ID = 40;

const THIRD_PARTY_LIMITS = {
  fullName: 120,
  nationalId: 40,
  dateOfBirth: 10,
  email: 320,
  phone: 40,
  bloodType: 24,
} as const;

function parseThirdPartyIntake(value: unknown): ThirdPartyIntakeDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const read = (key: keyof typeof THIRD_PARTY_LIMITS): string | null => {
    const field = raw[key];
    if (typeof field !== "string") return null;
    const trimmed = field.trim();
    return trimmed.length > 0 && trimmed.length <= THIRD_PARTY_LIMITS[key]
      ? trimmed
      : null;
  };
  const draft: ThirdPartyIntakeDraft = {
    fullName: read("fullName"),
    nationalId: read("nationalId"),
    dateOfBirth: read("dateOfBirth"),
    email: read("email"),
    phone: read("phone"),
    bloodType: read("bloodType"),
    nameSpellingConfirmed: raw.nameSpellingConfirmed === true,
  };
  return Object.values(draft).some(Boolean) ? draft : null;
}

/** Bounded like every other stage field: the column is 4 KB and shared. */
const MAX_INTAKE_ASK_SIGNATURE = 160;
const MAX_INTAKE_ASK_REPEATS = 16;

function parseIntakeAsk(value: unknown): IntakeAskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const signature = typeof raw.signature === "string" ? raw.signature.trim() : "";
  if (!signature || signature.length > MAX_INTAKE_ASK_SIGNATURE) return null;
  // Field keys only. A signature carrying anything else is a corrupt or
  // tampered payload and is dropped rather than trusted.
  if (!/^[a-z_]+(?:,[a-z_]+)*$/.test(signature)) return null;
  const repeats =
    typeof raw.repeats === "number" && Number.isInteger(raw.repeats) && raw.repeats > 0
      ? Math.min(raw.repeats, MAX_INTAKE_ASK_REPEATS)
      : 1;
  return { signature, repeats };
}

function parseAppointmentLookup(value: unknown): AppointmentLookupDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const read = (field: unknown, max: number): string | null => {
    if (typeof field !== "string") return null;
    const trimmed = field.trim();
    return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
  };
  const fullName = read(raw.fullName, MAX_LOOKUP_NAME);
  const nationalId = read(raw.nationalId, MAX_LOOKUP_ID);
  return fullName || nationalId ? { fullName, nationalId } : null;
}

function parseAppointmentChange(value: unknown): AppointmentChangeDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const appointmentId = typeof raw.appointmentId === "string" ? raw.appointmentId : "";
  const doctorId = typeof raw.doctorId === "string" ? raw.doctorId : "";
  const doctorName = typeof raw.doctorName === "string" ? raw.doctorName.trim() : "";
  const departmentId = typeof raw.departmentId === "string" && UUID_RE.test(raw.departmentId)
    ? raw.departmentId
    : null;
  const serviceId = typeof raw.serviceId === "string" && UUID_RE.test(raw.serviceId)
    ? raw.serviceId
    : null;
  const durationMinutes = typeof raw.durationMinutes === "number"
    && Number.isInteger(raw.durationMinutes)
    && raw.durationMinutes >= 15
    && raw.durationMinutes <= 240
    && raw.durationMinutes % 15 === 0
    ? raw.durationMinutes
    : 0;
  const date = typeof raw.date === "string" && isCalendarDate(raw.date) ? raw.date : "";
  const time = typeof raw.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)
    ? raw.time
    : null;
  if (!UUID_RE.test(appointmentId) || !UUID_RE.test(doctorId) || !doctorName || !durationMinutes || !date) {
    return null;
  }
  return {
    appointmentId,
    doctorId,
    doctorName: doctorName.slice(0, 120),
    departmentId,
    serviceId,
    durationMinutes,
    date,
    time,
  };
}

/** How many bookable times a pending amendment may carry forward. */
const MAX_AMENDMENT_TIMES = 8;

/**
 * The pending amendment question, rebuilt from the column.
 *
 * Held to the same standard as every other record here: a day that is not a
 * real calendar day, or a time that is not `HH:mm`, is dropped rather than
 * trusted, and the list is bounded.
 */
function parsePendingAmendmentTime(
  value: unknown,
): { date: string; times: readonly string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (!ISO_DATE_RE.test(date) || !isCalendarDate(date)) return null;
  const times = Array.isArray(raw.times)
    ? raw.times.filter(
        (item): item is string =>
          typeof item === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item),
      )
    : [];
  const unique = [...new Set(times)].slice(0, MAX_AMENDMENT_TIMES);
  return unique.length > 0 ? { date, times: unique } : null;
}

export const EMPTY_BOOKING_STAGE_STATE: BookingStageState = {
  stage: "idle",
  stageEnteredAt: new Date(0).toISOString(),
  lastTurnAt: null,
  turnCount: 0,
  intakeStaged: false,
  submitted: false,
  escalated: false,
  bookingForOther: false,
  beneficiary: null,
  pendingAmendmentTime: null,
  thirdPartyIntake: null,
  intakeAsk: null,
  pendingNameConfirmation: null,
  nameSpellingConfirmed: false,
  bloodTypeAsks: 0,
  bloodTypeResolved: false,
  offeredDoctorIds: [],
  offeredDays: [],
  availabilityWindowStart: null,
  availabilityWindowEnd: null,
  offeredSlots: [],
  appointmentLookup: null,
  appointmentChange: null,
  pendingSelection: null,
  interruptedBooking: null,
  lastToolOutcome: null,
  illegalTransitions: 0,
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_SLOT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_LABEL_RE = /^[a-z0-9_]{1,48}$/;

function parseIsoInstant(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/**
 * A real day, not merely a `YYYY-MM-DD`-shaped string.
 *
 * `2026-13-01` matches the shape and is not a date. An offer record that
 * accepted it would compare unequal to everything forever, which is a quiet way
 * for the guard to stop guarding.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

function parseStringList(
  value: unknown,
  pattern: RegExp,
  limit: number,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!pattern.test(trimmed)) continue;
    // Shape is not enough for a day: see `isCalendarDate`.
    if (pattern === ISO_DATE_RE && !isCalendarDate(trimmed)) continue;
    if (pattern === ISO_SLOT_RE && !isCalendarDate(trimmed.slice(0, 10))) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rebuilds the stage record from the jsonb column, key by key.
 *
 * Written to the same standard as `parseCollectedData` and for the same reason:
 * this column is application-written today, but it is still the one place a
 * malformed — or, in the worst case, an injected — value could survive a deploy
 * and reach a decision. An unknown key is dropped, an out-of-union stage falls
 * back to `idle`, a non-`YYYY-MM-DDTHH:mm` "offered slot" is discarded rather
 * than trusted, and nothing that is not on this list can exist in the result.
 */
export function parseBookingStageState(value: unknown): BookingStageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_BOOKING_STAGE_STATE;
  }
  const raw = value as Record<string, unknown>;
  const lastToolRaw =
    raw.lastToolOutcome &&
    typeof raw.lastToolOutcome === "object" &&
    !Array.isArray(raw.lastToolOutcome)
      ? (raw.lastToolOutcome as Record<string, unknown>)
      : null;
  const lastToolOutcome: BookingStageToolOutcome | null =
    lastToolRaw &&
    typeof lastToolRaw.tool === "string" &&
    SAFE_LABEL_RE.test(lastToolRaw.tool) &&
    typeof lastToolRaw.outcome === "string" &&
    SAFE_LABEL_RE.test(lastToolRaw.outcome)
      ? {
          tool: lastToolRaw.tool,
          outcome: lastToolRaw.outcome,
          at: parseIsoInstant(lastToolRaw.at, EMPTY_BOOKING_STAGE_STATE.stageEnteredAt),
        }
      : null;

  const turnCount =
    typeof raw.turnCount === "number" && Number.isInteger(raw.turnCount) && raw.turnCount >= 0
      ? Math.min(raw.turnCount, MAX_TURN_COUNT)
      : 0;
  const illegalTransitions =
    typeof raw.illegalTransitions === "number" &&
    Number.isInteger(raw.illegalTransitions) &&
    raw.illegalTransitions >= 0
      ? Math.min(raw.illegalTransitions, MAX_TURN_COUNT)
      : 0;

  return {
    stage: isBookingStage(raw.stage) ? raw.stage : "idle",
    stageEnteredAt: parseIsoInstant(
      raw.stageEnteredAt,
      EMPTY_BOOKING_STAGE_STATE.stageEnteredAt,
    ),
    // Absent, malformed or non-string all collapse to null, which
    // `isBookingStateStale` reads as "unknown, do not park".
    lastTurnAt:
      typeof raw.lastTurnAt === "string" &&
      Number.isFinite(Date.parse(raw.lastTurnAt))
        ? raw.lastTurnAt
        : null,
    turnCount,
    intakeStaged: raw.intakeStaged === true,
    submitted: raw.submitted === true,
    escalated: raw.escalated === true,
    bookingForOther: raw.bookingForOther === true,
    beneficiary:
      raw.beneficiary === "self" || raw.beneficiary === "other" ? raw.beneficiary : null,
    pendingAmendmentTime: parsePendingAmendmentTime(raw.pendingAmendmentTime),
    thirdPartyIntake: parseThirdPartyIntake(raw.thirdPartyIntake),
    intakeAsk: parseIntakeAsk(raw.intakeAsk),
    pendingNameConfirmation: parseNameConfirmation(raw.pendingNameConfirmation),
    nameSpellingConfirmed: raw.nameSpellingConfirmed === true,
    bloodTypeAsks:
      typeof raw.bloodTypeAsks === "number" &&
      Number.isInteger(raw.bloodTypeAsks) &&
      raw.bloodTypeAsks >= 0
        ? Math.min(raw.bloodTypeAsks, MAX_BLOOD_TYPE_ASKS)
        : 0,
    bloodTypeResolved: raw.bloodTypeResolved === true,
    offeredDoctorIds: parseStringList(raw.offeredDoctorIds, UUID_RE, MAX_OFFERED_DOCTORS),
    offeredDays: parseStringList(raw.offeredDays, ISO_DATE_RE, MAX_OFFERED_DAYS),
    availabilityWindowStart:
      typeof raw.availabilityWindowStart === "string" && isCalendarDate(raw.availabilityWindowStart)
        ? raw.availabilityWindowStart
        : null,
    availabilityWindowEnd:
      typeof raw.availabilityWindowEnd === "string" && isCalendarDate(raw.availabilityWindowEnd)
        ? raw.availabilityWindowEnd
        : null,
    offeredSlots: parseStringList(raw.offeredSlots, ISO_SLOT_RE, MAX_OFFERED_SLOTS),
    appointmentLookup: parseAppointmentLookup(raw.appointmentLookup),
    appointmentChange: parseAppointmentChange(raw.appointmentChange),
    pendingSelection: parsePendingSelection(raw.pendingSelection),
    interruptedBooking: parseInterruptedBooking(raw.interruptedBooking),
    lastToolOutcome,
    illegalTransitions,
  };
}

/** The jsonb payload for the column. Plain data, no undefined, no extras. */
export function serializeBookingStageState(
  state: BookingStageState,
): Record<string, unknown> {
  return {
    stage: state.stage,
    stageEnteredAt: state.stageEnteredAt,
    lastTurnAt: state.lastTurnAt,
    turnCount: state.turnCount,
    intakeStaged: state.intakeStaged,
    submitted: state.submitted,
    escalated: state.escalated,
    bookingForOther: state.bookingForOther,
    beneficiary: state.beneficiary,
    pendingAmendmentTime: state.pendingAmendmentTime
      ? {
          date: state.pendingAmendmentTime.date,
          times: [...state.pendingAmendmentTime.times],
        }
      : null,
    thirdPartyIntake: state.thirdPartyIntake
      ? { ...state.thirdPartyIntake }
      : null,
    intakeAsk: state.intakeAsk ? { ...state.intakeAsk } : null,
    pendingNameConfirmation: state.pendingNameConfirmation
      ? { ...state.pendingNameConfirmation }
      : null,
    nameSpellingConfirmed: state.nameSpellingConfirmed,
    bloodTypeAsks: state.bloodTypeAsks,
    bloodTypeResolved: state.bloodTypeResolved,
    offeredDoctorIds: [...state.offeredDoctorIds],
    offeredDays: [...state.offeredDays],
    availabilityWindowStart: state.availabilityWindowStart ?? null,
    availabilityWindowEnd: state.availabilityWindowEnd ?? null,
    offeredSlots: [...state.offeredSlots],
    appointmentLookup: state.appointmentLookup
      ? {
          fullName: state.appointmentLookup.fullName,
          nationalId: state.appointmentLookup.nationalId,
        }
      : null,
    appointmentChange: state.appointmentChange
      ? { ...state.appointmentChange }
      : null,
    pendingSelection: state.pendingSelection
      ? {
          field: state.pendingSelection.field,
          candidates: state.pendingSelection.candidates.map((item) => ({
            id: item.id,
            name: item.name,
          })),
        }
      : null,
    interruptedBooking: state.interruptedBooking
      ? {
          step: state.interruptedBooking.step,
          offeredResume: state.interruptedBooking.offeredResume,
        }
      : null,
    lastToolOutcome: state.lastToolOutcome
      ? {
          tool: state.lastToolOutcome.tool,
          outcome: state.lastToolOutcome.outcome,
          at: state.lastToolOutcome.at,
        }
      : null,
    illegalTransitions: state.illegalTransitions,
  };
}

// ---------------------------------------------------------------------------
// Deriving the stage
// ---------------------------------------------------------------------------

/**
 * Everything `deriveStage` is allowed to look at.
 *
 * `linked`, `identityVerified` and `identityLocked` are the values
 * `authorizePatientConversation()` resolved *this turn* from
 * `resolvePatientAiContext`. They are passed in rather than stored precisely so
 * that no caller can be tempted to read a cached verification flag: there is
 * nowhere to cache one.
 */
export type StageFacts = {
  collected: CollectedData;
  linked: boolean;
  identityVerified: boolean;
  identityLocked: boolean;
  intakeStaged: boolean;
  submitted: boolean;
  escalated: boolean;
  /** P9C: the appointment is for somebody other than the sender. */
  bookingForOther: boolean;
  /**
   * Whether this conversation has expressed any booking intent yet. Derived by
   * the caller from "has a booking tool ever run, or is a booking field set".
   * False keeps a pure-FAQ thread in `idle` instead of parking it in
   * `selecting_department` from its first "hello".
   */
  bookingIntent: boolean;
};

function has(collected: CollectedData, field: SlotField): boolean {
  const value = collected[field];
  return typeof value === "string" ? value.trim().length > 0 : typeof value === "number";
}

/**
 * The stage this conversation is actually in.
 *
 * The order of the branches is the specification. Read top to bottom:
 *
 *   1. The two terminals win outright.
 *   2. A linked patient whose booking identity is not settled is `identifying`
 *      and nothing else. The server adapter supplies true for either the
 *      stronger clinical check or the separate booking-only confirmation;
 *      disclosure tools still inspect the stronger fact directly.
 *   3. Then the booking selections, in the order the clinic works in:
 *      department, doctor, (intake, for a stranger), day, time.
 *   4. Everything established → `confirming`.
 *
 * Note where intake sits: *after* the doctor. That is not arbitrary — it is the
 * order `register_patient` itself enforces, which refuses with
 * `assignment_required` unless a department and a doctor are already collected.
 */
export function deriveStage(facts: StageFacts): BookingStage {
  if (facts.escalated) return "escalated";
  if (facts.submitted) return "submitted";
  if (facts.linked && !facts.identityVerified) return "identifying";
  if (!facts.bookingIntent) return "idle";
  if (!has(facts.collected, "department_id")) return "selecting_department";
  if (!has(facts.collected, "doctor_id")) return "selecting_doctor";
  // A stranger has no file. So, for the purpose of this branch, does a friend
  // the sender is booking for: linked says something about the person holding
  // the phone, and on a third-party booking that person is not the patient.
  if ((!facts.linked || facts.bookingForOther) && !facts.intakeStaged) {
    return "intake_collecting";
  }
  if (!has(facts.collected, "appointment_date")) return "selecting_day";
  if (!has(facts.collected, "appointment_time")) return "selecting_time";
  return "confirming";
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * The things that can happen to a booking, named as events rather than as tool
 * calls, so the machine does not have to change when a tool is renamed or a new
 * tool produces an existing effect.
 */
export type StageEvent =
  | { type: "booking_intent" }
  | { type: "identity_required" }
  | { type: "identity_verified" }
  | { type: "department_selected" }
  | { type: "department_cleared" }
  | { type: "doctor_selected" }
  /** "مين غيره؟" — back to the roster, never back to the department. */
  | { type: "doctor_alternatives_requested" }
  | { type: "doctor_cleared" }
  | { type: "intake_required" }
  | { type: "intake_staged" }
  | { type: "day_selected" }
  | { type: "day_cleared" }
  | { type: "time_selected" }
  | { type: "time_cleared" }
  | { type: "booking_submitted" }
  | { type: "escalated" }
  /** Staff returned an escalated conversation to the assistant. */
  | { type: "de_escalated" }
  | { type: "reset" };

export type StageEventType = StageEvent["type"];

/**
 * The legal edges, as an adjacency map.
 *
 * Written out in full rather than computed, because the value of this table is
 * that a reviewer can read it and disagree with it. Two properties are worth
 * naming explicitly:
 *
 *   * **`selecting_doctor` has no edge back to `selecting_department` except
 *     through an explicit `department_cleared`.** That single omission is the
 *     structural fix for "'other doctors' restarts the flow" — the restart is
 *     not discouraged, it is unreachable.
 *   * **Every stage may reach `escalated`.** Degradation to a human is always
 *     legal, from anywhere, unconditionally. That property must survive any
 *     future edit to this table.
 */
const LEGAL_EDGES: Readonly<Record<BookingStage, readonly BookingStage[]>> = {
  // P9B: a single `prepare_booking` call can settle a department and hand back
  // the roster (→ `selecting_doctor`), or open on a returning patient's treating
  // doctor and settle both (→ `selecting_day`). Those are one tool call, not a
  // skipped step, and counting them as illegal made the counter measure the
  // table's own omissions instead of the model's behaviour. `idle → confirming`
  // stays unreachable: nothing produces a day and a time in one move.
  idle: [
    "idle",
    "identifying",
    "selecting_department",
    "selecting_doctor",
    "selecting_day",
    "submitted",
    "escalated",
  ],
  identifying: [
    "identifying",
    "idle",
    "selecting_department",
    "selecting_doctor",
    "selecting_day",
    "selecting_time",
    "confirming",
    "submitted",
    "escalated",
  ],
  intake_collecting: [
    "intake_collecting",
    "identifying",
    "selecting_doctor",
    "selecting_department",
    "selecting_day",
    "escalated",
  ],
  selecting_department: [
    "selecting_department",
    "identifying",
    "selecting_doctor",
    // The treating-doctor opening again: department and doctor in one call.
    "selecting_day",
    "escalated",
  ],
  selecting_doctor: [
    "selecting_doctor",
    "identifying",
    // A department correction is the only way back, and it is explicit.
    "selecting_department",
    "intake_collecting",
    "selecting_day",
    "escalated",
  ],
  selecting_day: [
    "selecting_day",
    "identifying",
    "selecting_doctor",
    "selecting_department",
    "intake_collecting",
    "selecting_time",
    "escalated",
  ],
  selecting_time: [
    "selecting_time",
    "identifying",
    "selecting_day",
    "selecting_doctor",
    "selecting_department",
    // P9C: "actually, this one is for my friend" is legal at any point of a
    // booking, and it sends the conversation back to opening a file for them.
    "intake_collecting",
    "confirming",
    // `create_preliminary_booking` is deliberately mounted from `selecting_time`
    // — see STAGE_WORKFLOW_TOOLS — so the booking it creates lands here. Without
    // this edge every successful booking in the system was counted as an illegal
    // transition.
    "submitted",
    "escalated",
  ],
  confirming: [
    "confirming",
    "identifying",
    "selecting_time",
    "selecting_day",
    "selecting_doctor",
    "selecting_department",
    "intake_collecting",
    "submitted",
    "escalated",
  ],
  submitted: ["submitted", "idle", "selecting_department", "escalated"],
  /**
   * P11B — `escalated` is terminal *for the machine*, and is no longer terminal
   * for the conversation.
   *
   * The single self-edge was correct about the one thing it modelled: nothing
   * the patient says and nothing the model calls may lift an escalation. It was
   * silently wrong about a second thing, because staff can — pressing "return
   * to AI" in the inbox clears `ai_escalated_at` and the assistant starts
   * replying again on the next inbound message.
   *
   * With no edge out, the *stage* stayed `escalated` forever after that, and
   * `STAGE_WORKFLOW_TOOLS.escalated` is the empty list. The result was an
   * assistant that answered every subsequent turn with no booking tool mounted
   * at all — including "مين الدكاترة المتاحين؟", which it then answered from
   * pre-training. That is the reproduced phantom-doctor defect, and it lived
   * here.
   *
   * Handing a conversation back re-enters whatever stage the collected facts
   * imply, so every stage is reachable. It cannot be triggered from inside a
   * turn: `recordStageTurn` clears the latch only when the caller passes the
   * conversation's own un-escalated state, which only the reply entrypoint and
   * the staff action know.
   */
  escalated: [
    "escalated",
    "idle",
    "identifying",
    "intake_collecting",
    "selecting_department",
    "selecting_doctor",
    "selecting_day",
    "selecting_time",
    "confirming",
    "submitted",
  ],
};

/** Whether the machine has an edge from `from` to `to`. */
export function isLegalTransition(from: BookingStage, to: BookingStage): boolean {
  return LEGAL_EDGES[from].includes(to);
}

/** The stages reachable in one step. Exposed for exhaustive tests. */
export function legalNextStages(from: BookingStage): readonly BookingStage[] {
  return LEGAL_EDGES[from];
}

/**
 * Where one event takes the conversation.
 *
 * A total function: every (stage, event) pair has an answer, and an event that
 * means nothing in the current stage returns the current stage rather than
 * throwing. Illegality is reported by `classifyTransition`, not by exceptions —
 * a state machine that can throw inside a model loop is a state machine that
 * turns a conversational oddity into a "technical problem" reply.
 */
export function nextStage(current: BookingStage, event: StageEvent): BookingStage {
  if (event.type === "escalated") return "escalated";
  // P11B — `de_escalated` is the only event that leaves `escalated`, and only
  // staff can cause it (see LEGAL_EDGES.escalated). It resets to `idle` so the
  // next derivation rebuilds the stage from the collected facts rather than
  // resuming a stage the conversation may have left days ago.
  if (event.type === "de_escalated") return current === "escalated" ? "idle" : current;
  if (current === "escalated") return "escalated";
  if (event.type === "reset") return "idle";

  switch (event.type) {
    case "booking_intent":
      return current === "idle" || current === "submitted"
        ? "selecting_department"
        : current;
    case "identity_required":
      return "identifying";
    case "identity_verified":
      // Verification does not choose a stage; it un-blocks the one the facts
      // already imply. The caller re-derives immediately afterwards.
      return current === "identifying" ? "selecting_department" : current;
    case "department_selected":
      return current === "selecting_department" ||
        current === "idle" ||
        current === "identifying" ||
        current === "submitted"
        ? "selecting_doctor"
        : current;
    case "department_cleared":
      return "selecting_department";
    case "doctor_selected":
      return current === "selecting_doctor" ||
        current === "selecting_department" ||
        current === "identifying"
        ? "selecting_day"
        : current;
    case "doctor_alternatives_requested":
      // The whole point: asking for alternatives lands on the roster, and the
      // roster is where it already was. A self-loop, never a restart.
      return "selecting_doctor";
    case "doctor_cleared":
      return "selecting_doctor";
    case "intake_required":
      return "intake_collecting";
    case "intake_staged":
      return "selecting_day";
    case "day_selected":
      return current === "selecting_day" ||
        current === "selecting_doctor" ||
        current === "intake_collecting"
        ? "selecting_time"
        : current;
    case "day_cleared":
      return "selecting_day";
    case "time_selected":
      return current === "selecting_time" || current === "selecting_day"
        ? "confirming"
        : current;
    case "time_cleared":
      return "selecting_time";
    case "booking_submitted":
      return "submitted";
  }
}

export type TransitionClassification = {
  from: BookingStage;
  to: BookingStage;
  legal: boolean;
  /** True when nothing moved. Used to keep `stageEnteredAt` stable. */
  unchanged: boolean;
};

/**
 * Names a move without performing one.
 *
 * Used in two places: after `deriveStage` on a new turn (to notice that the
 * conversation jumped somewhere the machine has no edge for, which is a bug
 * worth a counter) and in the tests, where it is the assertion.
 */
export function classifyTransition(
  from: BookingStage,
  to: BookingStage,
): TransitionClassification {
  return {
    from,
    to,
    legal: isLegalTransition(from, to),
    unchanged: from === to,
  };
}

// ---------------------------------------------------------------------------
// What a stage may do
// ---------------------------------------------------------------------------

/**
 * The tools that are not part of the booking workflow and are therefore never
 * scoped away.
 *
 * The scoping exists to stop the model from running the *booking* steps out of
 * order. It does not exist to stop a patient asking where the clinic is, or to
 * make "cancel my appointment" unanswerable because the thread happens to be
 * mid-booking. Each of these is independently guarded server-side — identity
 * verification, entitlement, pause — so leaving them mounted costs nothing and
 * removing them would create a new class of dead end.
 */
export const STAGE_INDEPENDENT_TOOLS = [
  "get_clinic_info",
  "answer_clinic_faq",
  // P11I: clinic-wide facts are not booking state. The currently selected
  // department may scope roster/calendar operations, but it must never hide
  // the complete department directory from a general question.
  "list_clinic_departments",
  // P10: insurance and per-department services are clinic information. A
  // patient may ask "do you take my insurance?" or "how much is a visit?" at
  // any point, including mid-booking, and making either unanswerable because
  // the thread happens to be choosing a day is a dead end with no upside. Both
  // are read-only, clinic-scoped, and disclose nothing patient-specific.
  "list_clinic_insurance",
  "list_department_services",
  // Read-only cross-doctor inquiry. It never records offers or booking state.
  "compare_doctor_availability",
  "verify_patient_identity",
  // P10: establishing WHICH file a booking belongs to is a precondition of the
  // workflow rather than a step inside it, and a returning patient may need to
  // do it at any point — including after the department is already chosen. It
  // is stage-independent for the same reason `verify_patient_identity` is, and
  // it is safe to be: it cannot disclose anything, and the RPC behind it
  // refuses unless the thread's own number selects the file (or the exact
  // name-and-national-id pair does).
  "confirm_booking_identity",
  "list_my_appointments",
  // P11: "ميعادي امتى؟" can arrive at any point — before a booking starts,
  // during one, or after it. It changes no booking state, discloses nothing
  // clinical, and its identity rules live entirely in the RPC behind it, so
  // there is no stage in which withholding it does anything except send a
  // patient who already has a file into a new-patient registration.
  "lookup_appointment",
  "cancel_my_appointment",
  // Existing-request changes are independent of the new-booking ladder. Both
  // tools retain conversation-bound identity and ownership checks; per-turn
  // activeTools decides which one is exposed before/after confirmation.
  "check_reschedule_availability",
  "reschedule_my_appointment",
] as const;

/**
 * The workflow tools, per stage. This is the table that replaces the prompt.
 *
 * Three entries carry the weight:
 *
 *   * **`identifying` mounts no workflow tool at all**, so a linked patient
 *     whose booking identity is unsettled cannot be walked into a booking by
 *     any amount of insistence.
 *   * **`register_patient` exists only in `intake_collecting`**, which is itself
 *     only reachable once a department and a doctor are settled.
 *   * **`create_preliminary_booking` exists only from `selecting_time`**, so the
 *     booking call is unreachable until the department, the doctor *and* a day
 *     are all established. It is deliberately not held back to `confirming`:
 *     nothing else in the system writes `appointment_time`, so a table that
 *     required the time before allowing the tool that establishes it would be a
 *     deadlock rather than a guard. What protects the remaining gap — a time the
 *     patient was never shown — is `checkOfferedSlot`, server-side, in the tool.
 *
 * `check_availability` appears from `selecting_day` for the same reason: it is
 * the move that turns "they chose the 8th" into a stored appointment date, so
 * gating it behind an already-stored date could never fire.
 */
const STAGE_WORKFLOW_TOOLS: Readonly<Record<BookingStage, readonly string[]>> = {
  idle: ["prepare_booking"],
  identifying: [],
  /**
   * P11F — the calendar is readable while the intake is still open.
   *
   * A third-party booking derives as `intake_collecting` the moment a doctor is
   * chosen and stays there through the day and the time, because
   * `deriveStage` puts intake before the calendar (see `nextBookingStep` for
   * why that ordering is right for tools and wrong for presentation). With
   * `list_available_days` and `check_availability` unmounted for that whole
   * window, the model had no way to answer "which days?" or "which times?"
   * truthfully — and in the production trace it answered anyway, with a
   * generic 09:00–18:30 grid it invented, none of which was ever recorded as
   * an offer.
   *
   * Both additions are read-only and clinic-scoped, and `create_preliminary_
   * booking` deliberately stays out: an appointment still may not be created
   * for a patient who has no file yet, and the RPC refuses one regardless.
   */
  intake_collecting: [
    "register_patient",
    "list_available_days",
    "check_availability",
    "prepare_booking",
    "list_doctors",
  ],
  selecting_department: ["prepare_booking", "list_doctors"],
  selecting_doctor: ["prepare_booking", "list_doctors"],
  selecting_day: [
    "list_available_days",
    "check_availability",
    "prepare_booking",
    "list_doctors",
  ],
  selecting_time: [
    "check_availability",
    "list_available_days",
    "create_preliminary_booking",
    "prepare_booking",
    "list_doctors",
  ],
  confirming: [
    "create_preliminary_booking",
    "check_availability",
    "list_available_days",
    "prepare_booking",
    "list_doctors",
  ],
  submitted: ["prepare_booking"],
  escalated: [],
};

/** The workflow tools valid in a stage, without the always-on ones. */
export function workflowToolsForStage(stage: BookingStage): readonly string[] {
  return STAGE_WORKFLOW_TOOLS[stage];
}

/**
 * Every tool the model may call in this stage.
 *
 * `mounted` is the actual mount, so the result is always a subset of it: this
 * function can hide a tool, never conjure one. A task class that mounts only
 * the FAQ pair therefore gets the FAQ pair back regardless of stage.
 */
export function allowedToolsForStage(
  stage: BookingStage,
  mounted: readonly string[],
): readonly string[] {
  const allowed = new Set<string>([
    ...STAGE_INDEPENDENT_TOOLS,
    ...STAGE_WORKFLOW_TOOLS[stage],
  ]);
  return mounted.filter((name) => allowed.has(name));
}

/**
 * The collected fields that must already be established for a conversation to
 * legitimately be in this stage.
 *
 * Derived, never stored (the study's note 4): storing it would create a second
 * source of truth that can disagree with `ai_collected_data`.
 */
const STAGE_REQUIRED_FIELDS: Readonly<Record<BookingStage, readonly SlotField[]>> = {
  idle: [],
  identifying: [],
  intake_collecting: ["department_id", "doctor_id"],
  selecting_department: [],
  selecting_doctor: ["department_id"],
  selecting_day: ["department_id", "doctor_id"],
  selecting_time: ["department_id", "doctor_id", "appointment_date"],
  confirming: ["department_id", "doctor_id", "appointment_date", "appointment_time"],
  submitted: [],
  escalated: [],
};

export function requiredFieldsForStage(stage: BookingStage): readonly SlotField[] {
  return STAGE_REQUIRED_FIELDS[stage];
}

/** The fields a stage requires that are not yet on file. Always derived. */
export function missingFieldsForStage(
  stage: BookingStage,
  collected: CollectedData,
): readonly SlotField[] {
  return STAGE_REQUIRED_FIELDS[stage].filter((field) => !has(collected, field));
}

/**
 * The intake fields `register_patient` needs before it can stage a file.
 *
 * Separate from `requiredFieldsForStage` because these are what the *stage
 * collects*, not what it presupposes.
 */
export const INTAKE_FIELDS: readonly SlotField[] = [
  "full_name",
  "national_id",
  "date_of_birth",
  "email",
];

/**
 * P10 — intake fields worth asking for once that must never block a file.
 *
 * Blood type is on the real New Patient form and on `public.patients`, and the
 * AI intake was the only route into a patient record that could not carry it.
 * It is deliberately *not* in `INTAKE_FIELDS`: `register_patient` must still
 * stage a file for a patient who does not know their blood type, so this list
 * is consulted only to decide what to *ask*, never what to require.
 */
export const OPTIONAL_INTAKE_FIELDS: readonly SlotField[] = ["blood_type"];

/** The optional intake fields not yet collected. Asked once, never insisted on. */
export function missingOptionalIntakeFields(
  collected: CollectedData,
): readonly SlotField[] {
  return OPTIONAL_INTAKE_FIELDS.filter((field) => !has(collected, field));
}

export function missingIntakeFields(collected: CollectedData): readonly SlotField[] {
  return INTAKE_FIELDS.filter((field) => !has(collected, field));
}

/**
 * The department this conversation has settled on, or null.
 *
 * A one-line function with a reason to exist: this exact expression was written
 * out by hand in `prepare-booking.ts`, `list-doctors.ts` and, in doctor form, in
 * `list-available-days.ts` and `create-preliminary-booking.ts`. Four copies of
 * "what has this conversation already chosen?" is how the four of them drifted
 * apart in the first place. There is one copy now, and it is the same one the
 * stage table reads.
 */
export function establishedDepartmentId(collected: CollectedData): string | null {
  const value = collected.department_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The doctor this conversation has settled on, or null. See above. */
export function establishedDoctorId(collected: CollectedData): string | null {
  const value = collected.doctor_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Whether this is the *opening* move of a booking rather than a continuation.
 *
 * The treating-doctor shortcut is only correct here. Firing it on every
 * argument-less call is what made "في دكاترة غيره؟" unanswerable: the follow-up
 * came back with the same one doctor, forever. The condition used to live as an
 * inline boolean in `prepare-booking.ts`; it is the stage question "has a
 * department been established yet?" and now it is asked as one.
 */
export function isBookingOpening(
  collected: CollectedData,
  options: { hasExplicitDepartment: boolean; hasDoctorQuery: boolean; wantsAlternatives: boolean },
): boolean {
  if (options.hasExplicitDepartment || options.hasDoctorQuery || options.wantsAlternatives) {
    return false;
  }
  return missingFieldsForStage("selecting_doctor", collected).includes("department_id");
}

/**
 * Whether the sender's own treating doctor may open this booking.
 *
 * The treating doctor is a fact about the *sender's* file and it is only ever a
 * useful opening when the sender is also the patient. Manual QA found the two
 * collapsed: a thread that had said "الحجز لشخص تاني" and given the person's
 * name was still answered with «طبيبك المعالج هو …», which forces the sender's
 * doctor — and, with it, the sender's department — onto somebody else's
 * booking and skips the department question entirely.
 *
 * So this is the same shape as `isBookingOpening`: one question, asked once,
 * with one implementation. `beneficiary === "other"` is the patient's own words
 * and `bookingForOther` is the server latch; either one is enough, because the
 * latch is set by the third-party detector and the words are recorded before
 * the latch on the turn the patient says them.
 */
export function allowsTreatingDoctorOpening(facts: {
  linked: boolean;
  beneficiary: BookingBeneficiary | null;
  bookingForOther: boolean;
}): boolean {
  if (!facts.linked) return false;
  if (facts.bookingForOther) return false;
  return facts.beneficiary !== "other";
}

// ---------------------------------------------------------------------------
// The offered-options guard
// ---------------------------------------------------------------------------

/** Canonical key for one offered appointment slot. */
export function offeredSlotKey(date: string, time: string): string {
  return `${date}T${time.slice(0, 5)}`;
}

export type OfferedSlotCheck =
  | { status: "allowed"; reason: "no_offers_recorded" | "offered" }
  | { status: "rejected"; reason: "never_offered"; offeredForDate: readonly string[] };

/**
 * Whether a slot the model wants to book was ever actually put in front of the
 * patient.
 *
 * The hole this closes is narrow and real: `ai_requested_slot_is_available`
 * already refuses a slot the clinic cannot serve, so a *hallucinated* time is
 * usually caught. What it does not catch is a time that happens to be free but
 * was never offered — the model inventing "how about 4pm?" and then booking it
 * because 4pm happened to be open. That produces an appointment the patient
 * never chose.
 *
 * The rule is deliberately conditional: **enforcement begins only once this
 * conversation has recorded at least one real offer.** A conversation with no
 * recorded offers falls through untouched, so the guard can never invent a new
 * dead end on a path the availability flow did not run — it only ever holds the
 * model to what the flow already said out loud.
 */
export function checkOfferedSlot(
  state: BookingStageState,
  date: string,
  time: string,
): OfferedSlotCheck {
  if (state.offeredSlots.length === 0) {
    return { status: "allowed", reason: "no_offers_recorded" };
  }
  const key = offeredSlotKey(date, time);
  if (state.offeredSlots.includes(key)) {
    return { status: "allowed", reason: "offered" };
  }
  return {
    status: "rejected",
    reason: "never_offered",
    offeredForDate: state.offeredSlots
      .filter((slot) => slot.startsWith(`${date}T`))
      .map((slot) => slot.slice(11)),
  };
}

/** Records offers without letting the list grow without bound. */
function appendCapped(
  existing: readonly string[],
  additions: readonly string[],
  limit: number,
): readonly string[] {
  if (additions.length === 0) return existing;
  const merged = [...existing];
  for (const item of additions) {
    if (!merged.includes(item)) merged.push(item);
  }
  // Newest wins when the cap bites: a patient books from the last list they
  // were shown, not the first.
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}

export function recordOfferedDoctors(
  state: BookingStageState,
  doctorIds: readonly string[],
): BookingStageState {
  const clean = parseStringList(doctorIds, UUID_RE, MAX_OFFERED_DOCTORS);
  if (clean.length === 0) return state;
  return {
    ...state,
    offeredDoctorIds: appendCapped(state.offeredDoctorIds, clean, MAX_OFFERED_DOCTORS),
  };
}

export function recordOfferedDays(
  state: BookingStageState,
  days: readonly string[],
): BookingStageState {
  const clean = parseStringList(days, ISO_DATE_RE, MAX_OFFERED_DAYS);
  if (clean.length === 0) return state;
  return {
    ...state,
    offeredDays: appendCapped(state.offeredDays, clean, MAX_OFFERED_DAYS),
  };
}

/**
 * P9C — "طيب يوم 24؟", answered from the days this conversation was actually
 * offered.
 *
 * The assistant has just listed real days. The patient replies with one of them,
 * and in ordinary Arabic that reply is a bare number: "24". The conversational
 * date resolver cannot read it — a lone day with no month and no year is not a
 * date, and it correctly refuses to invent one — so the turn degraded into
 * "which day did you mean?" about a day the patient had just picked off a list.
 *
 * The offered-days record removes the ambiguity without guessing anything. A
 * number that matches the day-of-month of exactly one offered day *is* that day;
 * matching two (the 24th of this month and of the next, both offered) resolves
 * nothing and is left to the ordinary resolver to ask about.
 *
 * Deliberately narrow: it reads only days the server itself put in front of this
 * patient, so it can never turn a number into a day nobody mentioned.
 */
export function resolveOfferedDay(
  state: BookingStageState,
  raw: string,
): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (state.offeredDays.includes(text)) return text;

  // Arabic-Indic digits are what a phone keyboard produces in Egypt.
  const western = text.replace(/[\u0660-\u0669]/g, (digit) =>
    String(digit.charCodeAt(0) - 0x0660),
  );
  // F-15 — `STANDALONE_NUMBER` rather than every digit run: the `3` in an
  // Arabizi word is a letter, not a day.
  const digits = standaloneNumbers(western);
  // One number, and nothing that looks like a second one: "24" and "يوم 24" are
  // a day, "24/9" is a date and belongs to the ordinary resolver.
  if (!digits || digits.length !== 1) return null;
  const day = Number(digits[0]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const matches = state.offeredDays.filter((iso) => Number(iso.slice(8, 10)) === day);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * The words that turn "أول يوم متاح" into a position in the offered list.
 *
 * Stripped rather than enumerated: `resolveOptionIndex` already knows every
 * ordinal in both languages and both genders, and it already discards
 * "available"/"متاح". What it did not discard is the noun "day", which is the
 * only reason the most natural way to answer a day question in Egyptian Arabic
 * — "أول يوم متاح" — resolved to nothing and the turn produced silence.
 *
 * Kept local to the day step on purpose. `ordinalIndex` is shared with
 * `resolveNamedEntity`, which reads an ordinal *positionally* against whatever
 * list it is handed, so teaching it the word "يوم" globally would make "يوم"
 * phrases resolve to department one.
 */
const DAY_ORDINAL_NOISE =
  /(?:\b(?:the|a|an|day|days|please|possible|available|earliest|soonest|nearest|yom|youm|yoom|elyom|ayam|eyam|momken|lw|law|sam7t|men|fadlak|motah|mota7)\b|يوم|ايام|أيام|اليوم|الايام|الأيام|من\s*فضلك|لو\s*سمحت|اقرب|أقرب|ممكن|متاح[ةه]?|المتاح[ةه]?|متوفر[ةه]?|المتوفر[ةه]?|متوافر[ةه]?|فاضي|الفاضي)/giu;

/**
 * F-6 — the ordinal reading of a day answer, against the days as offered.
 *
 * Positional against `offeredDays` in the order the patient actually read them,
 * for exactly the reason `resolveOfferedDoctor` is positional against the
 * roster: "the first one" means the first name in the sentence in front of
 * them. An ordinal past the end of the list resolves to nothing rather than
 * being clamped — answering "the fifth day" with day three would be inventing a
 * choice the patient did not make.
 */
export function resolveOrdinalOfferedDay(
  state: BookingStageState,
  raw: string,
): string | null {
  const text = (raw ?? "").replace(DAY_ORDINAL_NOISE, " ").replace(/\s+/g, " ").trim();
  if (!text || state.offeredDays.length === 0) return null;
  const index = resolveOptionIndex(text);
  if (index === null) return null;
  return state.offeredDays[index] ?? null;
}

export function recordOfferedSlots(
  state: BookingStageState,
  date: string,
  times: readonly string[],
): BookingStageState {
  if (!isCalendarDate(date)) return state;
  const clean = parseStringList(
    times.map((time) => offeredSlotKey(date, time)),
    ISO_SLOT_RE,
    MAX_OFFERED_SLOTS,
  );
  if (clean.length === 0) return state;
  return {
    ...state,
    offeredSlots: appendCapped(state.offeredSlots, clean, MAX_OFFERED_SLOTS),
    offeredDays: appendCapped(state.offeredDays, [date], MAX_OFFERED_DAYS),
  };
}

// ---------------------------------------------------------------------------
// Advancing the record
// ---------------------------------------------------------------------------

export type StageAdvance = {
  state: BookingStageState;
  transition: TransitionClassification;
};

/**
 * Moves the record to a newly derived stage, keeping the bookkeeping honest.
 *
 * `stageEnteredAt` only moves when the stage does, so "how long has this
 * conversation been stuck choosing a doctor?" is answerable. An illegal jump is
 * *recorded and then accepted* — the derived stage is the truth, and refusing to
 * follow it would leave the record describing a conversation that is not
 * happening. The counter is what makes the disagreement visible.
 */
export function advanceStage(
  state: BookingStageState,
  derived: BookingStage,
  options: { at: string; countTurn?: boolean },
): StageAdvance {
  const transition = classifyTransition(state.stage, derived);
  return {
    state: {
      ...state,
      stage: derived,
      stageEnteredAt: transition.unchanged ? state.stageEnteredAt : options.at,
      turnCount: options.countTurn
        ? Math.min(state.turnCount + 1, MAX_TURN_COUNT)
        : state.turnCount,
      submitted: state.submitted || derived === "submitted",
      escalated: state.escalated || derived === "escalated",
      illegalTransitions: transition.legal
        ? state.illegalTransitions
        : Math.min(state.illegalTransitions + 1, MAX_TURN_COUNT),
    },
    transition,
  };
}

/** Records one tool outcome. Labels only — see `BookingStageToolOutcome`. */
export function recordToolOutcome(
  state: BookingStageState,
  tool: string,
  outcome: string,
  at: string,
): BookingStageState {
  const safeTool = SAFE_LABEL_RE.test(tool) ? tool : "unknown";
  const safeOutcome = SAFE_LABEL_RE.test(outcome) ? outcome : "unknown";
  return { ...state, lastToolOutcome: { tool: safeTool, outcome: safeOutcome, at } };
}

// ---------------------------------------------------------------------------
// P11F — the monotonic booking ladder
// ---------------------------------------------------------------------------

/**
 * The step a booking is actually *on*, for the purpose of composing a sentence.
 *
 * ## Why this is not `deriveStage`
 *
 * `deriveStage` decides which tools may be mounted, and for that purpose intake
 * comes before the calendar: `register_patient` refuses without a department and
 * a doctor, and a stranger with no file has nothing to attach an appointment to.
 * That ordering is correct and is not changing.
 *
 * It is the wrong ordering for *presentation*. A third-party booking derives as
 * `intake_collecting` from the moment a doctor is chosen and stays there through
 * the day and the time — so a reply generator that switched on the derived stage
 * alone would have no way to tell "we are choosing a day" from "we are choosing a
 * time", and could not tell either of them from "we still need the child's date
 * of birth". In the production trace this is exactly the window the regression
 * lived in: three consecutive turns, all `intake_collecting`, one offering days,
 * one offering times, and one throwing the whole thing away and re-offering the
 * doctor roster.
 *
 * So this is the same facts read as a ladder: department → doctor → day → time →
 * intake → confirm. It is *derived*, never stored, never model-influenced, and —
 * the property the whole phase is about — **monotonic in the collected facts**.
 * A step can only be reached by collecting the field before it, and the only
 * thing that moves it backwards is a field being cleared, which only an explicit
 * change or a failed revalidation ever does.
 */
export const BOOKING_STEPS = [
  "department",
  "doctor",
  "day",
  "time",
  "intake",
  "confirm",
  "done",
] as const;

export type BookingStep = (typeof BOOKING_STEPS)[number];

const BOOKING_STEP_ORDER: ReadonlyMap<BookingStep, number> = new Map(
  BOOKING_STEPS.map((step, index) => [step, index]),
);

/** Where `step` sits on the ladder. Higher is further forward. */
export function bookingStepRank(step: BookingStep): number {
  return BOOKING_STEP_ORDER.get(step) ?? 0;
}

export type BookingLadderFacts = {
  collected: CollectedData;
  /** The sender has a patient file of their own. */
  linked: boolean;
  /** The appointment is for somebody other than the sender (P9C). */
  bookingForOther: boolean;
  /** An intake record has been staged for staff review. */
  intakeStaged: boolean;
  /**
   * Item #6 — whether a staged *third-party* intake really exists for this
   * conversation, read live from `ai_patient_intakes`.
   *
   * This is the exact fact `create_preliminary_booking` refuses on
   * (`getPendingConversationIntake(...).is_third_party`). It is separate from
   * `intakeStaged` because `intakeStaged` is a latch, and `register_patient`
   * also sets that latch on its `linked_existing` outcome — which creates no
   * intake row at all. A third-party booking could therefore reach `confirm`
   * on a latch the write was guaranteed to reject, offer a confirmation,
   * refuse it, and offer it again: the reported confirmation loop.
   *
   * Optional, and `undefined` means "not known here". Only the turn opener can
   * read the database, so every pure caller — the acceptance runner, this
   * module's own tests — keeps the pre-existing behaviour instead of being
   * forced down to `intake` by a fact nobody supplied.
   */
  thirdPartyIntakeStaged?: boolean;
  submitted: boolean;
};

/**
 * The next thing this booking needs from the patient.
 *
 * Total, pure, and the single authority every deterministic reply consults
 * before it composes anything. See `patient-roster-continuation.ts` for the
 * rule it enforces: a reply may answer the step the booking is on, and it may
 * never render the step before it.
 */
export function nextBookingStep(facts: BookingLadderFacts): BookingStep {
  if (facts.submitted) return "done";
  if (!has(facts.collected, "department_id")) return "department";
  if (!has(facts.collected, "doctor_id")) return "doctor";
  if (!has(facts.collected, "appointment_date")) return "day";
  if (!has(facts.collected, "appointment_time")) return "time";
  // A stranger has no file, and neither — for this purpose — does the child or
  // friend a linked patient is booking for.
  if ((!facts.linked || facts.bookingForOther) && !facts.intakeStaged) return "intake";
  // Item #6 — for somebody else, the latch is not enough. The confirm rung is
  // the rung that asks the patient to commit, so it may only be reached when
  // the write behind it can actually run; the staged third-party record is the
  // precondition that write enforces, so it is the precondition the ladder
  // enforces too. One fact, asked once.
  if (facts.bookingForOther && facts.thirdPartyIntakeStaged === false) return "intake";
  return "confirm";
}

// ---------------------------------------------------------------------------
// P11F — resolving a spoken time against the slots actually offered
// ---------------------------------------------------------------------------

/** Arabic-Indic digits are what an Egyptian phone keyboard produces. */
function westernDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * F-15 — a number, as opposed to a letter that happens to be written as a digit.
 *
 * Arabizi spells the Arabic consonants that have no Latin equivalent with
 * digits: "el sa3a 10" is "the hour, 10", and "a7gez" is "I book". Reading every
 * digit run in the message found `3` **and** `10` in the first, concluded "more
 * than one number, so this is not a time", and returned no candidate at all — so
 * every Arabizi time answer deadlocked the turn for a reason that has nothing to
 * do with times, and the same defect read the `3` in "yom 3ashan" as a day.
 *
 * A digit glued to a Latin letter is part of a word. A digit standing on its own
 * is a number. Arabic script never abuts a Latin letter and Arabic-Indic digits
 * are folded to Western ones before this runs, so nothing about an Arabic or an
 * English message changes.
 *
 * An English ordinal suffix is part of the number, not a letter glued to it:
 * "the 10th" is still one number and still a day.
 */
const STANDALONE_NUMBER = /(?<![A-Za-z])\d{1,2}(?:st|nd|rd|th)?(?![A-Za-z])/gi;

/** The standalone numbers in a text, suffixes stripped, or null when there are none. */
function standaloneNumbers(text: string): string[] | null {
  const matches = text.match(STANDALONE_NUMBER);
  if (matches === null) return null;
  return matches.map((match) => match.replace(/[^0-9]/g, ""));
}

/** Words that place an hour in the morning or the afternoon/evening. */
const MORNING = /(?:\bam\b|صباح|الصبح|صبح|بدري)/i;
const EVENING = /(?:\bpm\b|مساء|مسا|بالليل|الليل|العصر|عصر|الضهر|ضهر|الظهر|ظهر|بعد\s*الضهر|بعد\s*الظهر)/i;

/**
 * Does this message, on its own, place an hour in the morning or the evening?
 *
 * Exported because the *answer* to «تقصد 10 صباحًا ولا 10 مساءً؟» carries no
 * hour at all — "الصبح" is the whole message — so the AM/PM half has to be
 * readable without a clock beside it. Same lexicon as the reader above, so the
 * two cannot drift.
 */
export function readsMorning(text: string): boolean {
  return MORNING.test(westernDigits(text ?? ""));
}

export function readsEvening(text: string): boolean {
  return EVENING.test(westernDigits(text ?? ""));
}

/** Half and quarter, the way they are actually spoken. */
const HALF = /(?:\bhalf\b|ونص|و\s*نص|والنص)/i;
const QUARTER_PAST = /(?:وربع|و\s*ربع|والربع)/i;
const QUARTER_TO = /(?:الا\s*ربع|إلا\s*ربع|الاربع)/i;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * F-6 — the hours people say rather than type.
 *
 * `candidateClockTimes` read digits and only digits, so "الساعة عشرة" — the
 * ordinary spoken answer to a list of times — produced no candidate, the
 * pre-commit committed nothing, the authority reported the slot list still
 * satisfied, and the turn went silent. "الساعة ١٠" worked. That is a lexicon
 * gap, not a design decision.
 *
 * Spellings are listed rather than derived, for the same reason the closing
 * lexicon is: reading an unrecognised word as an hour is the one direction this
 * must never fail in. The output is still a *candidate* — both readings of a
 * bare hour survive, and it remains the offered-slot list, never this table,
 * that decides which one the patient meant.
 */
const SPOKEN_HOURS: ReadonlyMap<string, number> = new Map<string, number>([
  ["واحدة", 1], ["الواحدة", 1], ["واحده", 1], ["الواحده", 1], ["one", 1],
  ["اتنين", 2], ["الاتنين", 2], ["اثنين", 2], ["الاثنين", 2], ["تنتين", 2],
  ["ثنتين", 2], ["two", 2],
  ["تلاتة", 3], ["التلاتة", 3], ["تلاته", 3], ["التلاته", 3], ["ثلاثة", 3],
  ["الثلاثة", 3], ["ثلاثه", 3], ["three", 3],
  ["اربعة", 4], ["الاربعة", 4], ["أربعة", 4], ["الأربعة", 4], ["اربعه", 4],
  ["الاربعه", 4], ["four", 4],
  ["خمسة", 5], ["الخمسة", 5], ["خمسه", 5], ["الخمسه", 5], ["five", 5],
  ["ستة", 6], ["الستة", 6], ["سته", 6], ["السته", 6], ["six", 6],
  ["سبعة", 7], ["السبعة", 7], ["سبعه", 7], ["السبعه", 7], ["seven", 7],
  ["تمانية", 8], ["التمانية", 8], ["تمانيه", 8], ["ثمانية", 8], ["الثمانية", 8],
  ["eight", 8],
  ["تسعة", 9], ["التسعة", 9], ["تسعه", 9], ["التسعه", 9], ["nine", 9],
  ["عشرة", 10], ["العشرة", 10], ["عشره", 10], ["العشره", 10], ["ten", 10],
  ["حداشر", 11], ["الحداشر", 11], ["احداشر", 11], ["إحداشر", 11],
  ["احدعشر", 11], ["eleven", 11],
  ["اتناشر", 12], ["الاتناشر", 12], ["اثناشر", 12], ["اتناشرة", 12],
  ["twelve", 12],
  // F-15 — Modern Standard Arabic says the hour as an ORDINAL: "الساعة
  // العاشرة صباحًا", not "الساعة عشرة". Every MSA-register time answer produced
  // no candidate at all, so the pre-commit committed nothing, the authority
  // reported the slot list still satisfied, and the turn went silent — the same
  // F-6 deadlock, reached through a register rather than through a spelling.
  ["الحادية", 11], ["حادية", 11], ["الثانية", 2], ["ثانية", 2],
  ["الثالثة", 3], ["ثالثة", 3], ["الرابعة", 4], ["رابعة", 4],
  ["الخامسة", 5], ["خامسة", 5], ["السادسة", 6], ["سادسة", 6],
  ["السابعة", 7], ["سابعة", 7], ["الثامنة", 8], ["ثامنة", 8],
  ["التاسعة", 9], ["تاسعة", 9], ["العاشرة", 10], ["عاشرة", 10],
  ["العاشره", 10], ["عاشره", 10],
  // Arabizi, which is how a large share of patients type.
  ["wa7da", 1], ["wahda", 1], ["etnen", 2], ["itnin", 2], ["talata", 3],
  ["talta", 3], ["arba3a", 4], ["arbaa", 4], ["khamsa", 5], ["setta", 6],
  ["sitta", 6], ["sab3a", 7], ["saba3a", 7], ["tamanya", 8], ["tes3a", 9],
  ["tisaa", 9], ["3ashara", 10], ["ashara", 10],
]);

/** The one spoken hour in a message, or null when there is none or several. */
function spokenHour(text: string): number | null {
  const words = text
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const hits = new Set<number>();
  for (const word of words) {
    const hour = SPOKEN_HOURS.get(word);
    if (hour !== undefined) hits.add(hour);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/**
 * Every reading of "الساعة ٩ الصبح" that could be a clock time, in `HH:mm`.
 *
 * Deliberately generous and deliberately *not* a decision: a bare "9" produces
 * both `09:00` and `21:00`, and it is the offered-slot list — never this
 * function — that decides which one the patient meant. A morning or evening
 * word narrows it here because that is unambiguous language, not a guess.
 */
export function candidateClockTimes(raw: string): string[] {
  const text = westernDigits((raw ?? "").trim());
  if (text.length === 0) return [];

  const explicit = /(\d{1,2})\s*[:.]\s*(\d{2})/.exec(text);
  let hour: number;
  let minute: number;
  if (explicit) {
    hour = Number(explicit[1]);
    minute = Number(explicit[2]);
  } else {
    const digits = standaloneNumbers(text);
    // One number only. "9 و 30" is not a shape anybody types, and "31" in a
    // day list is a day — the caller has already decided this is a time turn.
    // F-6 — with no digit at all, the hour may still have been spelled out.
    const spoken = digits ? null : spokenHour(text);
    if (spoken === null && (!digits || digits.length !== 1)) return [];
    hour = spoken ?? Number(digits![0]);
    minute = QUARTER_PAST.test(text)
      ? 15
      : HALF.test(text)
        ? 30
        : QUARTER_TO.test(text)
          ? 45
          : 0;
    // "إلا ربع" is a quarter *to* the hour said, so nine-less-a-quarter is 8:45.
    if (QUARTER_TO.test(text)) hour -= 1;
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return [];
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return [];

  const morning = MORNING.test(text);
  const evening = EVENING.test(text);
  if (hour === 0) return [`00:${pad(minute)}`];
  if (hour > 12) return [`${pad(hour)}:${pad(minute)}`];
  if (hour === 12) return evening || morning ? [`12:${pad(minute)}`] : ["12:" + pad(minute), `00:${pad(minute)}`];
  if (morning) return [`${pad(hour)}:${pad(minute)}`];
  if (evening) return [`${pad(hour + 12)}:${pad(minute)}`];
  return [`${pad(hour)}:${pad(minute)}`, `${pad(hour + 12)}:${pad(minute)}`];
}

/**
 * The time the patient just picked, from the slots this conversation was
 * actually shown for `date`.
 *
 * The same device as `resolveOfferedDay`, one rung up the ladder, and for the
 * same reason: the assistant has just listed real times, the patient answers
 * "الساعه ٩ الصبح", and no general-purpose date parser can turn that into an
 * appointment. The offered list removes the ambiguity without inventing
 * anything — a reading that matches exactly one offered slot *is* that slot,
 * and a reading that matches two (9am and 9pm both offered, no morning word)
 * resolves nothing and is asked about.
 *
 * It can never return a time that was not offered, which is the property
 * `checkOfferedSlot` depends on one step later.
 */
export function resolveOfferedTime(
  state: BookingStageState,
  date: string,
  raw: string,
): string | null {
  if (!isCalendarDate(date)) return null;
  const offered = state.offeredSlots
    .filter((slot) => slot.startsWith(`${date}T`))
    .map((slot) => slot.slice(11));
  if (offered.length === 0) return null;
  const matches = candidateClockTimes(raw).filter((time) => offered.includes(time));
  return matches.length === 1 ? matches[0]! : null;
}

// ---------------------------------------------------------------------------
// V2-CONTAINMENT — booking state has a lifetime
// ---------------------------------------------------------------------------

/**
 * How long a booking that nobody is advancing stays authoritative.
 *
 * ## The defect this closes
 *
 * A booking abandoned halfway through was immortal. `resolve_conversation_
 * episode` bounds *messages* and nothing else; `ai_collected_data` and
 * `ai_booking_stage` are cleared only by the close paths, and the five-minute
 * idle close is armed at exactly one call site — a turn on which the lifecycle
 * layer returned `offer_end`, which requires that nothing is outstanding. A
 * half-finished booking reaches `continue` instead and arms nothing at all.
 *
 * So a patient who chose a doctor, was shown some days and then walked away
 * left a thread that would, weeks later, answer *any* message by continuing
 * that booking: `hasBookingIntent` was true because `doctor_id` was still
 * present, the ladder reported `day`, and the authority pinned the calendar.
 *
 * ## Why a timeout rather than another reader
 *
 * The message cannot be made to prove that it is *not* a continuation — that
 * is the same allow-by-default trap in a different place. What can be proven
 * server-side is elapsed time. Thirty minutes is longer than any real pause
 * inside one booking conversation on WhatsApp and far shorter than the gap
 * that produced the live failure.
 */
export const BOOKING_STATE_MAX_IDLE_MS = 30 * 60 * 1000;

/**
 * Is this booking state stale — silent for too long to speak for the turn?
 *
 * ## Why `lastTurnAt` and not `stageEnteredAt`
 *
 * The obvious signal is wrong. `stageEnteredAt` moves only when the *stage*
 * moves, so a patient working steadily through the confirm step for forty
 * minutes — answering every couple of minutes, never leaving `confirming` —
 * carries a forty-minute-old `stageEnteredAt` and would be parked mid-sentence.
 * That is the opposite of the behaviour wanted.
 *
 * What the rule is actually about is *silence*: nobody has spoken to this
 * booking for half an hour. That is `lastTurnAt`, stamped once per inbound turn
 * by the turn opener.
 *
 * ## Why a missing stamp is not stale
 *
 * `lastTurnAt` is null on a record written before this rule existed, and on
 * `EMPTY_BOOKING_STAGE_STATE`. Reading that as stale would park every live
 * conversation in the system on deploy, on no evidence at all. It reads as
 * *unknown* instead: the turn proceeds, the stamp is written, and the rule
 * engages from the following turn onwards. The window that leaves open needs
 * two messages thirty minutes apart, and the other half of the containment —
 * the inverted `department` default in `resolveBookingAuthority` — already
 * covers the turn in between.
 *
 * Pure, and conservative in both directions: a `submitted` or `escalated`
 * state is never stale, because those latches describe something that really
 * exists (a pending request, a human holding the thread) and a clock must not
 * release them.
 */
export function isBookingStateStale(
  state: BookingStageState,
  now: Date = new Date(),
): boolean {
  if (state.submitted || state.escalated) return false;
  if (state.stage === "idle") return false;
  if (!state.lastTurnAt) return false;
  const at = Date.parse(state.lastTurnAt);
  // A stamp we cannot read is not a stamp. Same reasoning as the null case.
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at >= BOOKING_STATE_MAX_IDLE_MS;
}

export function parkBookingState(
  state: BookingStageState,
  at: string = new Date().toISOString(),
): BookingStageState {
  return {
    ...state,
    stage: "idle",
    stageEnteredAt: at,
    lastTurnAt: at,
    offeredDoctorIds: [],
    offeredDays: [],
    availabilityWindowStart: null,
    availabilityWindowEnd: null,
    offeredSlots: [],
    pendingSelection: null,
    pendingAmendmentTime: null,
    interruptedBooking: null,
    appointmentLookup: null,
    appointmentChange: null,
    intakeAsk: null,
  };
}
