import "server-only";

import {
  advanceStage,
  candidateClockTimes,
  checkOfferedSlot,
  deriveStage,
  isBookingStateStale,
  parkBookingState,
  missingFieldsForStage,
  missingIntakeFields,
  missingOptionalIntakeFields,
  nextBookingStep,
  parseBookingStageState,
  recordOfferedDays,
  recordOfferedDoctors,
  recordOfferedSlots,
  readsEvening,
  readsMorning,
  recordToolOutcome,
  serializeBookingStageState,
  type BookingStage,
  type BookingStageState,
  type OfferedSlotCheck,
  type PendingSelection,
  type AppointmentChangeDraft,
  type NameConfirmationDraft,
  MAX_BLOOD_TYPE_ASKS,
} from "@/lib/ai/booking-stage";
import type { CollectedData, SlotField } from "@/lib/ai/collected-state";
import { resolveField } from "@/lib/ai/collected-state";
import { logAgentTool } from "@/lib/ai/audit";
import {
  authorizePatientConversation,
  type PatientToolContext,
  type ResolvedPatientAiContext,
} from "@/lib/ai/patient-authorization";
import {
  getPendingConversationIntake,
  resolvePatientAiContext,
  setConversationAiState,
} from "@/lib/supabase/admin";
import {
  detectConversationClosure,
  type ClosureDetection,
} from "@/lib/ai/conversation-closure";
import { buildTurnBriefing } from "@/lib/ai/turn-briefing";
import {
  resolveBookingAuthority,
  type BookingAuthority,
} from "@/lib/ai/booking-authority";
import type { CommunicationStyle } from "@/lib/ai/communication-style";
import { isClinicDirectoryQuestion } from "@/lib/ai/clinic-directory";
import {
  availableDoctorsInDepartment,
  loadDoctorDirectory,
  toDoctorOption,
} from "@/lib/ai/doctor-directory";
import {
  looksLikeChoiceAnswer,
  pendingSelectionFor,
  resolveOfferedSelection,
} from "@/lib/ai/offered-selection";
import { isClinicInformationQuestion } from "@/lib/ai/clinic-information-intent";
import { isCancellationRequest } from "@/lib/ai/cancellation-intent";
import { readDateBoundary } from "@/lib/ai/day-of-month";
import { isRosterQuestion } from "@/lib/ai/roster-intent";
import {
  classifyPatientTurn,
  toolsForInformationalTurn,
  type PatientTurnClassification,
} from "@/lib/ai/patient-turn-intent";
import {
  readTranslationRequest,
  type TranslationRequest,
} from "@/lib/ai/translation-request";
import {
  minutesToPatientTime,
  type BookingAmendmentAlternatives,
  type PatientBookingConfirmation,
} from "@/lib/ai/patient-booking-confirmation";
import {
  parseBookingAmendment,
  type BookingAmendmentRequest,
} from "@/lib/ai/booking-amendment";
import {
  detectBookingBeneficiary,
  type BookingBeneficiary,
} from "@/lib/ai/booking-beneficiary";
import {
  isBloodTypeDeclined,
  buildNameCorrectionQuestion,
  readNameConfirmation,
} from "@/lib/ai/intake-answers";
import { getPatientAvailableSlots } from "@/lib/booking/patient";

/**
 * P9 — the durable half of the booking stage machine.
 *
 * `booking-stage.ts` is pure and knows nothing about a database. This module is
 * the only thing that writes the stage column, the only thing that emits stage
 * telemetry, and the only thing that reads the feature switch. Keeping the two
 * apart is what lets the whole workflow be tested as a table of transitions
 * rather than as a sequence of round trips.
 *
 * Three properties hold throughout:
 *
 *   * **Every write is best-effort.** A failed stage write must never fail a
 *     turn. The worst consequence of losing one is that the next turn re-derives
 *     the same stage from the collected fields, which is the behaviour that
 *     existed before this module.
 *   * **Every read re-derives.** The persisted stage is an input to the
 *     transition classifier, never the answer. `deriveConversationStage` recomputes
 *     from this turn's server-resolved identity facts every single time.
 *   * **Nothing logged here is PHI.** The telemetry payload is four enumerated
 *     labels and three integers. No name, no phone, no id, no date, no message
 *     body, no tool arguments, no tool results.
 */

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/**
 * How much of the stage machine is live.
 *
 *   * `off` — nothing. The assistant behaves exactly as it did before P9: flat
 *     tool mount, whole prompt, ad-hoc guards falling back to their original
 *     collected-field checks. This is the instant rollback.
 *   * `shadow` — the stage is derived, persisted and traced, the consolidated
 *     guards read it, and the offered-slot guard is enforced. The model's view
 *     of the world is unchanged: same mount, same prompt.
 *   * `on` — additionally scopes the mount (`activeTools`) and the prompt to
 *     the current stage.
 *
 * P11 — the default is now `on`, and that is the fix for a defect, not a
 * rollout step. `shadow` derives the stage, persists it, traces it and enforces
 * the offered-slot guard, and then returns `null` to the agent — so the model
 * ran with a flat mount and the whole ~4,000-token prompt, and every rule about
 * *what happens next* in a booking was a sentence competing for attention
 * rather than a tool that was absent. That is why a valid department name could
 * resolve and the conversation still not move on to that
 * department's roster: nothing structural required it to. `on` makes the stage
 * table the thing that decides, which is what it was built for.
 *
 * `shadow` and `off` remain, unchanged, as the rollback: `AI_PATIENT_STAGE_ORCHESTRATION=shadow`
 * restores the flat mount exactly, and `off` restores pre-P9 behaviour entirely.
 */
export type StageOrchestrationMode = "off" | "shadow" | "on";

export function stageOrchestrationMode(): StageOrchestrationMode {
  const raw = process.env.AI_PATIENT_STAGE_ORCHESTRATION?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "shadow") return "shadow";
  return "on";
}

/** Whether the stage may be derived, persisted and traced at all. */
export function stageTrackingEnabled(): boolean {
  return stageOrchestrationMode() !== "off";
}

/** Whether the mount and the prompt are narrowed to the stage. */
export function stageScopedMountEnabled(): boolean {
  return stageOrchestrationMode() === "on";
}

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

/**
 * Has this conversation expressed any booking intent yet?
 *
 * Kept out of `deriveStage` because it is the one input that is genuinely a
 * judgement about history rather than a fact about now. A thread that has only
 * ever asked "what time do you open?" must stay in `idle`; the moment a booking
 * field exists, a latch is set, or the previous turn already left `idle`, it has.
 */
function hasBookingIntent(identity: ResolvedPatientAiContext): boolean {
  const state = identity.bookingStage;
  if (state.stage !== "idle") return true;
  if (state.intakeStaged || state.submitted || state.bookingForOther) return true;
  const collected = identity.collectedData;
  return (
    typeof collected.department_id === "string" ||
    typeof collected.doctor_id === "string" ||
    typeof collected.appointment_date === "string" ||
    typeof collected.appointment_time === "number"
  );
}

export type ConversationStage = {
  /** The stage the facts imply right now. This is the one tools act on. */
  stage: BookingStage;
  /** The stage the record carried into this turn. Advisory only. */
  previousStage: BookingStage;
  /** True when the move from `previousStage` to `stage` has no legal edge. */
  illegal: boolean;
  state: BookingStageState;
};

/**
 * The stage this conversation is in, computed from this turn's facts.
 *
 * `bookingIntent` may be forced true by a caller that knows a booking tool is
 * running — `prepare_booking` being invoked *is* the intent, and waiting for the
 * next turn to notice would leave the opening move of every booking in `idle`.
 */
/**
 * The one place identity facts are turned into `StageFacts`.
 *
 * Shared by the read path and the write path so the two can never disagree
 * about what the stage is — which, given that the write path is what the trace
 * reports and the read path is what the mount is built from, is a disagreement
 * that would be invisible until it mattered.
 */
function deriveFrom(
  identity: ResolvedPatientAiContext,
  collected: CollectedData,
  state: BookingStageState,
  forceIntent: boolean,
): BookingStage {
  return deriveStage({
    collected,
    linked: identity.linked,
    // Booking identity is intentionally narrower than clinical verification,
    // but it is sufficient to progress the pending-booking state machine. It
    // never reaches disclosure tools, which still require identityVerifiedAt.
    identityVerified: Boolean(
      identity.identityVerifiedAt ||
      identity.bookingIdentityConfirmedAt ||
      state.bookingForOther,
    ),
    identityLocked:
      identity.identityLockedUntil !== null &&
      new Date(identity.identityLockedUntil).getTime() > Date.now(),
    intakeStaged: state.intakeStaged,
    submitted: state.submitted,
    escalated: state.escalated,
    bookingForOther: state.bookingForOther,
    bookingIntent:
      forceIntent ||
      hasBookingIntent({ ...identity, collectedData: collected, bookingStage: state }),
  });
}

export function deriveConversationStage(
  identity: ResolvedPatientAiContext,
  options: { bookingIntent?: boolean } = {},
): ConversationStage {
  const state = identity.bookingStage;
  const stage = deriveFrom(
    identity,
    identity.collectedData,
    state,
    options.bookingIntent === true,
  );
  const advanced = advanceStage(state, stage, { at: new Date().toISOString() });
  return {
    stage,
    previousStage: state.stage,
    illegal: !advanced.transition.legal,
    state: advanced.state,
  };
}

// ---------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------

type StagePatch = {
  /** Force the derived stage to be computed as though intent is established. */
  bookingIntent?: boolean;
  /**
   * Fields this tool has just written through `set_conversation_ai_state`.
   *
   * `identity` was resolved at the top of the tool call and is a snapshot: a
   * department chosen two lines ago is not in it. Without this the derived
   * stage would lag one write behind the collected state it is derived from,
   * and every tool would record the stage it was leaving rather than the one it
   * had just reached.
   */
  collectedOverride?: CollectedData;
  /** Latch: the intake was staged for review this turn. */
  intakeStaged?: boolean;
  /** Latch: this booking is for somebody other than the sender (P9C). */
  bookingForOther?: boolean;
  /**
   * P12-QA — release that latch, because the patient has just said the booking
   * is for *them*.
   *
   * The latch is one-way on purpose: "ليا" must never quietly move an
   * appointment already staged for somebody else onto the sender's own file.
   * That is still true — the caller only ever sets this when nothing has been
   * staged or submitted for the other person, and it clears the isolated
   * third-party draft along with the latch, so no part of that person's
   * identity survives the correction. Never set from linkage or from silence;
   * only from an explicit self answer.
   */
  releaseBookingForOther?: boolean;
  /**
   * Record who the patient said this booking is for. Latching, like
   * `bookingForOther`: once established it is only ever replaced by the patient
   * saying the other thing, never cleared by omission.
   */
  beneficiary?: BookingBeneficiary;
  /**
   * Record (or clear, with `null`) the AM/PM question owed on an amendment.
   * `undefined` leaves it alone, for the same reason `pendingSelection` does.
   */
  pendingAmendmentTime?: { date: string; times: readonly string[] } | null;
  /** Merge an isolated third-party intake draft, or clear it after staging. */
  thirdPartyIntake?: import("@/lib/ai/booking-stage").ThirdPartyIntakeDraft | null;
  /**
   * P11J-2 — record (or clear, with `null`) the intake question just asked, so
   * the same question asked three turns running can be recognised as a loop.
   * `undefined` leaves it alone, for the same reason `appointmentLookup` does.
   */
  intakeAsk?: import("@/lib/ai/booking-stage").IntakeAskRecord | null;
  /** Latch: a pending booking or request was created this turn. */
  submitted?: boolean;
  /** Latch: this conversation went to a human. */
  escalated?: boolean;
  /**
   * P11B — staff returned this conversation to the assistant.
   *
   * The one release of the `escalated` latch, and the reason it needs to exist:
   * `clearConversationEscalation` clears `conversations.ai_escalated_at`, the
   * reply path resumes, and nothing used to clear the stage. A conversation
   * could therefore sit in `escalated` — whose workflow mount is the empty list
   * — for the rest of its life, answering booking questions with no booking
   * tool available. Set only from a caller that has read the conversation's own
   * un-escalated state; never from inside a model turn.
   */
  unescalated?: boolean;
  /**
   * P11B — the half-finished appointment-identity check, or `null` to erase it.
   *
   * `undefined` leaves it alone; `null` clears it. The distinction matters:
   * every tool that is not `lookup_appointment` writes patches through this
   * type and none of them should be able to disturb the draft by omission.
   */
  appointmentLookup?: import("@/lib/ai/booking-stage").AppointmentLookupDraft | null;
  /** Persist or clear a server-verified pending-appointment change proposal. */
  appointmentChange?: AppointmentChangeDraft | null;
  /**
   * F-2 — record (or clear, with `null`) the ambiguous selection the server
   * owes a question about. `undefined` leaves it alone, for the same reason
   * `appointmentLookup` does: every tool writes patches through this type and
   * none of them should disturb the record by omission.
   */
  pendingSelection?: PendingSelection | null;
  /**
   * P12 — record (or clear, with `null`) the booking rung a side question
   * interrupted. `undefined` leaves it alone, like every other record here.
   */
  interruptedBooking?: import("@/lib/ai/booking-stage").InterruptedBooking | null;
  /**
   * Record (or clear, with `null`) the English spelling of a name the patient
   * has been shown and has not answered yet. `undefined` leaves it alone, for
   * the same reason `pendingSelection` does.
   */
  pendingNameConfirmation?: NameConfirmationDraft | null;
  /** Latch: the Latin spelling of the name is settled by the patient. */
  nameSpellingConfirmed?: boolean;
  /** Count one blood-type ask. Bounded by `MAX_BLOOD_TYPE_ASKS`. */
  bloodTypeAsk?: boolean;
  /** Latch: blood type was supplied, or explicitly declined. Both are answers. */
  bloodTypeResolved?: boolean;
  offeredDoctorIds?: readonly string[];
  offeredDays?: readonly string[];
  availabilityWindow?: { start: string; end: string };
  offeredSlots?: { date: string; times: readonly string[] };
  /** Invalidate offers that belonged to a selection the patient changed. */
  clearOfferedDays?: boolean;
  clearOfferedSlots?: boolean;
  /** The tool that produced this patch, and how it went. Labels only. */
  tool?: string;
  outcome?: string;
  /** Count this as an inbound turn. Set once per turn, by the turn opener. */
  countTurn?: boolean;
};

/**
 * Applies a patch, writes the record, and emits the trace. Never throws.
 *
 * Returns the stage that was recorded so a caller can act on it, or `null` when
 * stage tracking is switched off — in which case nothing was written, nothing
 * was logged, and the caller must fall back to its pre-P9 behaviour.
 */
export async function recordStageTurn(
  identity: ResolvedPatientAiContext,
  patch: StagePatch = {},
): Promise<ConversationStage | null> {
  if (!stageTrackingEnabled()) return null;
  const at = new Date().toISOString();
  try {
    let state = parseBookingStageState(
      serializeBookingStageState(identity.bookingStage),
    );
    if (patch.intakeStaged) state = { ...state, intakeStaged: true };
    if (patch.bookingForOther) state = { ...state, bookingForOther: true };
    // Order matters: an explicit release cannot be undone by a stale latch in
    // the same patch, and it takes the other person's draft with it.
    if (patch.releaseBookingForOther) {
      state = { ...state, bookingForOther: false, thirdPartyIntake: null, intakeAsk: null };
    }
    if (patch.beneficiary) state = { ...state, beneficiary: patch.beneficiary };
    if (patch.pendingAmendmentTime !== undefined) {
      state = { ...state, pendingAmendmentTime: patch.pendingAmendmentTime };
    }
    if (patch.thirdPartyIntake !== undefined) {
      state = { ...state, thirdPartyIntake: patch.thirdPartyIntake };
    }
    if (patch.intakeAsk !== undefined) state = { ...state, intakeAsk: patch.intakeAsk };
    if (patch.submitted) state = { ...state, submitted: true };
    if (patch.escalated) state = { ...state, escalated: true };
    // Order matters: an explicit escalation this turn always wins over a stale
    // release, so a turn that escalates and is somehow also marked un-escalated
    // stays escalated.
    if (patch.unescalated && !patch.escalated && state.escalated) {
      state = { ...state, escalated: false, stage: "escalated" };
    }
    if (patch.appointmentLookup !== undefined) {
      state = { ...state, appointmentLookup: patch.appointmentLookup };
    }
    if (patch.appointmentChange !== undefined) {
      state = { ...state, appointmentChange: patch.appointmentChange };
    }
    if (patch.pendingSelection !== undefined) {
      state = { ...state, pendingSelection: patch.pendingSelection };
    }
    if (patch.interruptedBooking !== undefined) {
      state = { ...state, interruptedBooking: patch.interruptedBooking };
    }
    if (patch.pendingNameConfirmation !== undefined) {
      state = { ...state, pendingNameConfirmation: patch.pendingNameConfirmation };
    }
    if (patch.nameSpellingConfirmed) state = { ...state, nameSpellingConfirmed: true };
    if (patch.bloodTypeAsk) {
      state = {
        ...state,
        bloodTypeAsks: Math.min(state.bloodTypeAsks + 1, MAX_BLOOD_TYPE_ASKS),
      };
    }
    if (patch.bloodTypeResolved) state = { ...state, bloodTypeResolved: true };
    if (patch.clearOfferedDays) state = { ...state, offeredDays: [] };
    if (patch.clearOfferedSlots) state = { ...state, offeredSlots: [] };
    if (patch.offeredDoctorIds) {
      state = recordOfferedDoctors(state, patch.offeredDoctorIds);
    }
    if (patch.offeredDays) state = recordOfferedDays(state, patch.offeredDays);
    if (patch.availabilityWindow) {
      state = {
        ...state,
        availabilityWindowStart: patch.availabilityWindow.start,
        availabilityWindowEnd: patch.availabilityWindow.end,
      };
    }
    if (patch.offeredSlots) {
      state = recordOfferedSlots(
        state,
        patch.offeredSlots.date,
        patch.offeredSlots.times,
      );
    }
    if (patch.tool) {
      state = recordToolOutcome(state, patch.tool, patch.outcome ?? "unknown", at);
    }

    const collected: CollectedData = patch.collectedOverride
      ? { ...identity.collectedData, ...patch.collectedOverride }
      : identity.collectedData;
    const derived = deriveFrom(identity, collected, state, patch.bookingIntent === true);
    const advanced = advanceStage(state, derived, {
      at,
      countTurn: patch.countTurn === true,
    });
    // V2-CONTAINMENT — the silence clock. Stamped on the turn opener's call
    // (the one that counts the turn) and nowhere else, so it measures inbound
    // messages rather than the several intra-turn writes each turn makes.
    const stamped = patch.countTurn === true
      ? { ...advanced.state, lastTurnAt: at }
      : advanced.state;

    const stageWrite = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      stage: serializeBookingStageState(stamped),
    });
    if (stageWrite?.error) return null;
    await emitStageTrace({
      clinicId: identity.clinicId,
      from: identity.bookingStage.stage,
      to: advanced.state.stage,
      tool: patch.tool ?? null,
      outcome: patch.outcome ?? null,
      legal: advanced.transition.legal,
      turnCount: advanced.state.turnCount,
      missingFieldCount: missingFieldsForStage(derived, collected).length,
      illegalTransitions: advanced.state.illegalTransitions,
    });
    return {
      stage: stamped.stage,
      previousStage: identity.bookingStage.stage,
      illegal: !advanced.transition.legal,
      state: stamped,
    };
  } catch {
    // Bookkeeping must never break a booking. The next turn re-derives.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * One privacy-safe line per stage movement.
 *
 * This is the artefact the study named as the single most expensive gap: there
 * was nowhere that said "on turn N the state was X, the model called Y, and the
 * state became Z". It now exists, in `audit_logs`, next to the tool calls it
 * explains, under the same `actor_type='ai'` provenance.
 *
 * What is in it: two stage names from a ten-value union, a tool name from an
 * eleven-value union, an outcome label, and four integers. What is deliberately
 * not in it: the patient, the conversation body, the phone number, any id, any
 * date, any tool argument, any tool result. `toolAuditSummary` would strip a
 * leaked email or long digit run anyway, but nothing here has one to strip.
 */
async function emitStageTrace(input: {
  clinicId: string;
  from: BookingStage;
  to: BookingStage;
  tool: string | null;
  outcome: string | null;
  legal: boolean;
  turnCount: number;
  missingFieldCount: number;
  illegalTransitions: number;
}): Promise<void> {
  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_booking_stage",
    params: {
      stage_before: input.from,
      stage_after: input.to,
      changed: input.from !== input.to,
      tool_called: input.tool ?? "none",
      tool_outcome: input.outcome ?? "none",
      legal_transition: input.legal,
      turn: input.turnCount,
      missing_required_fields: input.missingFieldCount,
      illegal_transitions_total: input.illegalTransitions,
    },
  });
}

// ---------------------------------------------------------------------------
// The offered-options guard
// ---------------------------------------------------------------------------

/**
 * Whether a slot may be booked, given what this conversation was actually shown.
 *
 * Switched off entirely when stage tracking is off, so the rollback really is a
 * rollback. See `checkOfferedSlot` for why enforcement is conditional on there
 * being a recorded offer at all.
 */
export function checkConversationOfferedSlot(
  identity: ResolvedPatientAiContext,
  date: string,
  time: string,
): OfferedSlotCheck {
  if (!stageTrackingEnabled()) {
    return { status: "allowed", reason: "no_offers_recorded" };
  }
  return checkOfferedSlot(identity.bookingStage, date, time);
}

// ---------------------------------------------------------------------------
// Turn boundaries
// ---------------------------------------------------------------------------

/**
 * Opens a turn: resolves the conversation, counts it, persists the derived
 * stage and emits the trace. Returns the stage the model should be scoped to,
 * or `null` when tracking is off, the task is not booking, or the conversation
 * could not be authorized.
 *
 * `null` is a complete answer, not an error path — `createPatientAgent` treats
 * it as "no scoping", which is exactly today's behaviour. Every failure mode
 * here degrades to the certified flat mount rather than to a refusal.
 */
/**
 * P10 — everything the model needs about *this* turn, resolved once.
 *
 * `stage` keeps its old meaning exactly: null unless stage-scoped mounting is
 * switched on. The other two are new and are returned regardless of that
 * switch, because neither narrows anything — the communication style is
 * configuration the clinic asked for, and the briefing is a restatement of
 * facts the conversation already stored. Withholding either behind the
 * orchestration flag would mean a clinic that set "Egyptian Arabic, formal" in
 * Settings did not get it, which is not a rollback of anything.
 */
export type PatientTurnContext = {
  stage: BookingStage | null;
  style: CommunicationStyle | null;
  briefing: string | null;
  /**
   * P11G — the authoritative operation this turn needs, or a `none` value.
   *
   * Returned regardless of the orchestration switch, for the same reason the
   * style and the briefing are: it narrows nothing and unlocks nothing. It is
   * `null` only when the turn could not be resolved at all, which is the same
   * condition that already produces a null stage and a null briefing.
   */
  authority: BookingAuthority | null;
  /**
   * P11N — is the workflow still waiting on the patient for something?
   *
   * True while a clarification is pending or a booking/intake rung is
   * unfinished; false when the turn leaves nothing outstanding. `null` means
   * the turn could not be resolved at all, and the lifecycle layer treats that
   * as "assume there is work" rather than proposing an ending it cannot
   * justify. This is the single precondition on asking «أقدر أساعدك في حاجة
   * تانية؟» and on ending a thread — see `conversation-lifecycle.ts`.
   */
  outstanding: boolean | null;
  /**
   * P11N — is this conversation a multi-step exchange rather than a one-shot
   * question?
   *
   * True once the thread is actually working through a booking; false for a
   * thread that has only ever asked things. Paired with `outstanding`, it is
   * what tells the lifecycle layer the difference between "a workflow just
   * finished" and "a question was just answered" — only the first is worth
   * following with «أقدر أساعدك في حاجة تانية؟». `null` alongside a null
   * `outstanding`, for the same reason.
   */
  workflowEngaged: boolean | null;
  /** Deterministic scope classification used only to narrow stale workflow tools. */
  classification: PatientTurnClassification | null;
  /** Exact informational-tool allow-list; null leaves ordinary stage scoping intact. */
  informationalTools: readonly string[] | null;
  /** Complete, server-owned details awaiting an explicit final confirmation. */
  bookingConfirmation: PatientBookingConfirmation | null;
  /**
   * The patient edited the day or the time of the booking sitting in the final
   * review, and the server has already re-checked the schedule for the *same*
   * doctor. Null on every turn that is not that.
   */
  bookingAmendment: BookingAmendmentTurn | null;
  /**
   * P12 — the patient asked for the previous reply again in another language.
   *
   * Carried so the reply layer can say so in the briefing and, more
   * importantly, so nothing else on the turn treats the message as an answer:
   * every deterministic reader that could consume it is skipped when this is
   * set. Null on every ordinary turn.
   */
  translationRequest: TranslationRequest | null;
  /**
   * P12 — a booking paused by a side question, and whether this turn is the one
   * resuming it. Both halves are server state, never the model's reading of the
   * transcript. Null when no booking is interrupted.
   */
  bookingInterruption: BookingInterruptionTurn | null;
  /**
   * P12 — the patient sent a partial name correction the server could not place
   * against the name already staged, and owes them one short question. Null
   * otherwise.
   */
  nameCorrectionQuestion: string | null;
};

/**
 * What a side question has done to a booking in progress.
 *
 * `paused` is the turn the interruption happened on: answer the question, then
 * ask whether to continue. `resuming` is the turn the patient agreed on: pick
 * the booking back up at `step`, which is the rung it was actually on.
 */
export type BookingInterruptionTurn =
  | { kind: "paused"; step: string }
  | { kind: "resuming"; step: string };

/**
 * What a booking amendment turn owes the patient, decided entirely server-side.
 *
 * Every one of the three is composed from a live availability read taken on
 * this turn. None of them commits a booking: the draft moves, the review comes
 * back, and the explicit-confirmation rule is untouched.
 */
export type BookingAmendmentTurn =
  /** The requested day/time is real and free. The draft now holds it. */
  | { kind: "updated"; confirmation: PatientBookingConfirmation }
  /** It is not free. The draft is unchanged and real alternatives are offered. */
  | { kind: "unavailable"; value: BookingAmendmentAlternatives }
  /** Several real times fit what was asked. The patient picks one. */
  | { kind: "choose_time"; value: { doctorName: string; date: string; slots: readonly string[] } }
  /**
   * "الساعة 10" is 10:00 and 22:00, and the doctor's schedule has *both*. The
   * draft is untouched, the requested day is held, and the only thing asked is
   * which of the two readings was meant.
   */
  | { kind: "clarify_meridiem"; value: { date: string; times: readonly string[] } };

const EMPTY_TURN_CONTEXT: PatientTurnContext = {
  stage: null,
  style: null,
  briefing: null,
  authority: null,
  outstanding: null,
  workflowEngaged: null,
  classification: null,
  informationalTools: null,
  bookingConfirmation: null,
  bookingAmendment: null,
  translationRequest: null,
  bookingInterruption: null,
  nameCorrectionQuestion: null,
};

/**
 * Parks a booking nobody has advanced inside {@link BOOKING_STATE_MAX_IDLE_MS}.
 *
 * The one writer of the containment rule, so the read path and the write path
 * cannot disagree about whether a thread is still booking. Returns the identity
 * unchanged when the state is live, when tracking is off, or when the write
 * fails — a failed park leaves the pre-existing behaviour rather than a half
 * cleared record, and the next turn tries again.
 */
async function parkStaleBookingState(
  identity: ResolvedPatientAiContext,
): Promise<ResolvedPatientAiContext> {
  const state = identity.bookingStage;
  if (!isBookingStateStale(state)) return identity;
  const parked = parkBookingState(state);
  // `ai_collected_data` merges, so "absent" is written as an empty string —
  // the same convention `booking-target.ts` uses to release a doctor. Only the
  // four transactional slots are released; intake fields are facts about the
  // person and are left exactly where they are.
  const released = {
    department_id: "",
    department_name: "",
    doctor_id: "",
    doctor_name: "",
    appointment_date: "",
  } as const;
  try {
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: released,
      stage: serializeBookingStageState(parked) as Record<string, unknown>,
    });
    if (write.error) return identity;
    await logAgentTool({
      clinicId: identity.clinicId,
      actorId: null,
      tool: "patient_booking_parked",
      // Labels only. No ids, no patient words.
      params: { reason: "max_idle", stage_before: state.stage },
    });
    const next: CollectedData = { ...identity.collectedData };
    delete next.department_id;
    delete next.department_name;
    delete next.doctor_id;
    delete next.doctor_name;
    delete next.appointment_date;
    delete next.appointment_time;
    return { ...identity, collectedData: next, bookingStage: parked };
  } catch {
    return identity;
  }
}

export async function openBookingStageTurn(
  ctx: PatientToolContext,
  task: "patient_booking" | "patient_faq",
  options: {
    latestPatientText?: string | null;
    /**
     * The conversation's own escalation state, as the caller read it. `false`
     * releases a stale stage latch (see `StagePatch.unescalated`); omitting it
     * leaves the latch exactly as it was, which is what every caller that has
     * not read `ai_escalated_at` should do.
     */
    conversationEscalated?: boolean;
  } = {},
): Promise<PatientTurnContext> {
  if (!stageTrackingEnabled()) return EMPTY_TURN_CONTEXT;
  try {
    let identity = await authorizePatientConversation(ctx);
    // V2-CONTAINMENT — a booking nobody has advanced for half an hour stops
    // speaking for the turn.
    //
    // This runs before every reader, before the classifier and before the
    // ladder, because all three of them treat a stale doctor exactly as they
    // treat one the patient named a second ago. Parking clears the stage,
    // the offers and the drafts (`parkBookingState`) and blanks the four
    // booking slots — the established convention for "absent" in
    // `ai_collected_data`, which merges and cannot delete keys. Everything
    // about the *person* survives: the beneficiary latch, the third-party
    // draft, the staged-intake latch, the settled name, the linkage.
    //
    // A patient who still wants that booking says so and it starts cleanly.
    // Nothing can resume it because a message merely arrived.
    identity = await parkStaleBookingState(identity);
    // F-3 — closure is context-aware. "تمام" answering «تحب أشوف المواعيد
    // المتاحة معاه؟» is an acknowledgement, and reading it as a goodbye is what
    // stripped the turn of its authority and stalled the booking where it
    // stood. The context is server-owned state read a moment ago, never the
    // sentence: an unfinished booking on this thread, or a clarification the
    // clinic is still waiting on an answer to.
    const outstandingWork =
      Boolean(identity.pendingClarification) ||
      (hasBookingIntent(identity) && !identity.bookingStage.submitted);
    const closure: ClosureDetection = detectConversationClosure(
      options.latestPatientText,
      { outstandingWork },
    );
    const clinicDirectoryQuery = isClinicDirectoryQuestion(
      options.latestPatientText,
    );
    // P12 — «مش فاهم قولها بالعربي» is about the previous *reply*, not about
    // the booking. Read before anything else on the turn, because every
    // deterministic reader below — the beneficiary detector, the intake answer
    // reader, the offered-selection pre-commit, the amendment reader — would
    // otherwise be handed a message that answers none of their questions and
    // could only guess. Nothing on a restatement turn moves.
    const translationRequest = readTranslationRequest(options.latestPatientText);
    const openingClassification = classifyPatientTurn(options.latestPatientText, {
      workflowEngaged: hasBookingIntent(identity),
    });
    // A pure-FAQ mount has no booking to stage, but it still has a clinic style
    // and it can still be closed politely — both of which used to be dropped on
    // the floor for exactly the conversations most likely to end in "شكراً".
    if (task !== "patient_booking") {
      return {
        stage: null,
        style: identity.communicationStyle,
        // A FAQ mount has no ladder; the only thing it can be waiting on is an
        // outstanding clarification, and there is no workflow to finish.
        outstanding: Boolean(identity.pendingClarification),
        workflowEngaged: false,
        authority: clinicDirectoryQuery
          ? resolveBookingAuthority({
              step: "department",
              collected: {},
              offeredDoctorIds: [],
              offeredDays: [],
              offeredSlots: [],
              closing: closure.isClosing,
              terminal: false,
              clinicDirectoryQuery: true,
            })
          : null,
        briefing: buildTurnBriefing({
          locale: ctx.locale,
          stage: "idle",
          collected: {},
          pending: null,
          missingRequired: [],
          missingOptional: [],
          intakeStaged: identity.bookingStage.intakeStaged,
          closure,
        }),
        classification: openingClassification,
        informationalTools: openingClassification.informationalOnly
          ? toolsForInformationalTurn(openingClassification.topic)
          : null,
        bookingConfirmation: null,
        bookingAmendment: null,
        translationRequest,
        bookingInterruption: null,
        nameCorrectionQuestion: null,
      };
    }
    // P11J — a server offer plus a unique natural answer is enough to commit
    // the selected doctor/day/time before authority is computed. Previously a
    // valid answer remained only in prose, so `nextBookingStep` kept seeing the
    // old rung and repeatedly forced the read tool that produced the same list.
    // This pre-commit is deliberately narrow: it accepts only a value from the
    // server-owned offer set, skips questions/closings/directory side turns,
    // and performs no booking write.
    let pendingSelection: PendingSelection | null =
      identity.bookingStage.pendingSelection;
    let unresolvedAnswer = false;
    let nameCorrectionQuestion: string | null = null;
    // "بعد يوم 9" is a *lower bound* on the search, and it has to be read
    // before the pre-commit rather than after it.
    //
    // `readDateBoundary` has been correct since P12, but its only consumer was
    // the `list_available_days` tool — and the turn never got that far. A short
    // declarative message reaches `commitLatestOfferedSelection` first, which
    // reads it as an answer to the offer in front of the patient, so the `9`
    // matched an offered day or was read as an hour against the offered slots
    // and the booking moved on with a day nobody chose. Manual QA saw it land
    // on the 10th.
    //
    // A boundary is not an answer to anything. Recognising it here does three
    // things and no more: the pre-commit is skipped so no number in the message
    // is mistaken for a selection, the day and time already held are cleared
    // (and only those — the department, the doctor, the beneficiary and every
    // intake field are facts about *who and where*, which a date bound says
    // nothing about), and the offer is withdrawn so the authority stops
    // reporting `committed_days` and pins `list_available_days` again. That
    // tool then reads the same sentence with the same reader and answers it
    // from the clinic's real calendar.
    const dateBoundary =
      !closure.isClosing &&
      !translationRequest &&
      !identity.bookingStage.submitted &&
      !identity.bookingStage.escalated
        ? readDateBoundary(options.latestPatientText, {
            timeZone: identity.clinicTimezone,
          })
        : null;
    if (
      !dateBoundary &&
      !closure.isClosing &&
      !clinicDirectoryQuery &&
      !translationRequest &&
      !openingClassification.informationalOnly &&
      openingClassification.topic !== "reschedule" &&
      !identity.bookingStage.submitted &&
      !identity.bookingStage.escalated
    ) {
      // The two intake answers the server owns the reading of — the English
      // spelling of a name it proposed, and blood type — are read before the
      // offered-selection pre-commit, because neither is a selection and both
      // would otherwise be left to the model to interpret.
      const intakeAnswers = await resolveIntakeAnswers(
        identity,
        options.latestPatientText ?? null,
        ctx.locale,
      );
      identity = intakeAnswers.identity;
      nameCorrectionQuestion = intakeAnswers.nameCorrectionQuestion;
      const commit = await commitLatestOfferedSelection(
        identity,
        options.latestPatientText ?? null,
      );
      identity = commit.identity;
      pendingSelection = commit.pendingSelection;
      unresolvedAnswer = commit.unresolved;
    }
    if (dateBoundary) {
      identity = await invalidateForDateBoundary(identity);
    }
    const recorded = await recordStageTurn(identity, {
      countTurn: true,
      ...(options.conversationEscalated === false ? { unescalated: true } : {}),
    });
    const stage = recorded?.stage ?? deriveConversationStage(identity).stage;
    let state = recorded?.state ?? identity.bookingStage;
    // A — who this booking is *for*, established before anything is collected
    // and never inferred from `conversations.patient_id`.
    //
    // The sender's linkage proves who is holding the phone. It says nothing
    // about whose appointment this is, and the two were collapsed: a linked
    // sender typing "عايز احجز" was taken to be booking for themself. So the
    // patient's own words are read here, deterministically, and the fact is
    // latched. A message that already says it — "عايز احجز لصاحبي" — settles it
    // outright and the self/other question is never put; one that does not
    // leaves `beneficiary` null and the question outstanding.
    //
    // The message itself counts as booking intent, not only the state: the very
    // first thing a stranger says is "عايز احجز لصاحبي", and at that point
    // nothing has been collected and the stage is still `idle`.
    if (
      (hasBookingIntent({ ...identity, bookingStage: state }) ||
        openingClassification.topic === "booking") &&
      !openingClassification.informationalOnly &&
      !translationRequest &&
      !closure.isClosing
    ) {
      const said = detectBookingBeneficiary(options.latestPatientText);
      if (said && said !== state.beneficiary) {
        // P12-QA — "أنا قصدي أحجز لنفسي مش لشخص تاني" is a correction, and it
        // has to be able to land. The latch stays one-way for anything already
        // staged or submitted: those have a real file or a real request behind
        // them and only clinic staff may move them. Before that point nothing
        // exists but a draft, so the correction releases the latch and drops
        // the other person's collected details with it.
        const releasable =
          said === "self" &&
          state.bookingForOther &&
          !state.intakeStaged &&
          !state.submitted;
        const recordedBeneficiary = await recordStageTurn(identity, {
          bookingIntent: true,
          beneficiary: said,
          ...(said === "other" ? { bookingForOther: true } : {}),
          ...(releasable ? { releaseBookingForOther: true } : {}),
          tool: "patient_booking_beneficiary",
          outcome:
            said === "other" ? "for_other" : releasable ? "released_to_self" : "for_self",
        });
        if (recordedBeneficiary) {
          state = recordedBeneficiary.state;
          identity = { ...identity, bookingStage: recordedBeneficiary.state };
        }
      }
    }
    const intakeStaged = state.intakeStaged;
    const hasExistingSelfFile = identity.linked && !state.bookingForOther;
    const intakeCollected = state.bookingForOther
      ? collectedFromThirdPartyDraft(state.thirdPartyIntake)
      : identity.collectedData;
    const thirdPartyMissing = state.bookingForOther
      ? [
          ...missingIntakeFields(intakeCollected),
          ...(typeof intakeCollected.phone === "string" ? [] : ["phone" as SlotField]),
        ]
      : missingIntakeFields(intakeCollected);
    // The turn is counted, the stage is persisted and the trace is emitted in
    // `shadow` as well as `on` — that is the whole point of `shadow`. What
    // `shadow` withholds is the *stage*: with none the agent builds itself
    // exactly as it did before P9, flat mount and whole certified prompt.
    // Narrowing the model's view is the one thing that needs an explicit opt-in.
    // P11G — the ladder step, and from it the authoritative operation this turn
    // needs. Deliberately computed from `nextBookingStep` rather than from
    // `stage`: the two disagree for the whole day-and-time window of a new or
    // third-party booking (see `deriveStage`), and it is the ladder that says
    // what the patient is actually being asked for. The stage still decides
    // what is *mounted*; this decides what is *needed*.
    // Item #6 — the live staged-file fact, read once per turn and only when it
    // can change an answer.
    //
    // `create_preliminary_booking` refuses a third-party booking that has no
    // `ai_patient_intakes` row of its own, and until now the ladder did not
    // know that: it reached `confirm` from the `intakeStaged` latch, which
    // `register_patient` also sets on `linked_existing` — an outcome that
    // creates no row. The confirmation was then offered, refused, and offered
    // again. This is the same read the write performs, so the two can no longer
    // disagree. Only third-party bookings pay for it; a booking for the sender
    // never reaches this branch, and a failed read leaves the fact unknown,
    // which is exactly the pre-existing behaviour.
    const thirdPartyIntakeStaged = state.bookingForOther
      ? await readThirdPartyIntakeStaged(identity)
      : undefined;
    let step = nextBookingStep({
      collected: identity.collectedData,
      linked: identity.linked,
      bookingForOther: state.bookingForOther,
      intakeStaged: state.intakeStaged,
      ...(thirdPartyIntakeStaged === undefined ? {} : { thirdPartyIntakeStaged }),
      submitted: state.submitted,
    });
    // P11N — what the lifecycle layer is allowed to act on.
    //
    // `nextBookingStep` answers "which rung is next" for every conversation,
    // including one that has never expressed booking intent — a thread that
    // only ever asked about opening hours still reports `department`. So the
    // ladder alone cannot say whether anything is *outstanding*; it is
    // outstanding only once this conversation is actually booking, and only
    // until the request is submitted.
    const workflowEngaged = hasBookingIntent({ ...identity, bookingStage: state });
    const classification = classifyPatientTurn(options.latestPatientText, {
      workflowEngaged,
    });
    const activeAppointmentChange = state.appointmentChange && !classification.informationalOnly
      ? state.appointmentChange
      : null;
    // P12 — a side question in the middle of a booking.
    //
    // `classification.relation` has said "side_question" since P11R and nothing
    // has ever read it, which is precisely the gap manual QA fell into: the
    // booking state survived the interruption perfectly, but nothing recorded
    // that an interruption had happened, so the turn *after* it had no way to
    // read «اه» as "yes, carry on with the booking" rather than as an answer to
    // whatever rung was open. It is recorded here, from the server's own
    // classification and the server's own ladder — the rung label is a schema
    // constant and carries no patient words.
    //
    // A translation request is deliberately not an interruption: nothing is
    // paused by it, because nothing on that turn moves at all.
    let bookingInterruption: BookingInterruptionTurn | null = null;
    const interrupted = state.interruptedBooking;
    if (
      !translationRequest &&
      workflowEngaged &&
      !state.submitted &&
      !state.escalated &&
      step !== "done"
    ) {
      if (classification.relation === "side_question") {
        bookingInterruption = { kind: "paused", step };
        if (interrupted?.step !== step || interrupted.offeredResume !== true) {
          const recordedPause = await recordStageTurn(identity, {
            bookingIntent: true,
            interruptedBooking: { step, offeredResume: true },
            tool: "patient_booking_interruption",
            outcome: "paused",
          });
          if (recordedPause) {
            state = recordedPause.state;
            identity = { ...identity, bookingStage: recordedPause.state };
          }
        }
      } else if (
        interrupted &&
        interrupted.offeredResume &&
        classification.explicitBookingConfirmation
      ) {
        // "اه" answering «تحب نكمل الحجز؟». The rung comes from the record, not
        // from the transcript, so the booking resumes exactly where it stopped
        // — no restart, no skipped rung, no question asked twice.
        bookingInterruption = { kind: "resuming", step: interrupted.step };
        const recordedResume = await recordStageTurn(identity, {
          bookingIntent: true,
          interruptedBooking: null,
          tool: "patient_booking_interruption",
          outcome: "resumed",
        });
        if (recordedResume) {
          state = recordedResume.state;
          identity = { ...identity, bookingStage: recordedResume.state };
        }
      } else if (interrupted) {
        // The patient carried on with the booking themselves. Nothing is
        // pending any more.
        const recordedClear = await recordStageTurn(identity, {
          bookingIntent: true,
          interruptedBooking: null,
          tool: "patient_booking_interruption",
          outcome: "continued",
        });
        if (recordedClear) {
          state = recordedClear.state;
          identity = { ...identity, bookingStage: recordedClear.state };
        }
      }
    }
    // The patient answered the final review by moving the day or the time.
    //
    // This is an *edit* to the draft in front of them, and the whole point of
    // handling it here is that nothing about the booking except the day and the
    // time may change: the doctor, the department, the patient — new file or
    // existing — and every collected intake field are read, never written. The
    // schedule is re-read authoritatively for that same doctor before anything
    // moves, and no path below creates an appointment.
    let bookingAmendment: BookingAmendmentTurn | null = null;
    // Item #4 — the reader also runs at the *time* rung.
    //
    // It was gated on `confirm` alone, so a patient correcting the day while
    // still choosing an hour reached nothing that could re-read the schedule.
    // Their message went to the offered-slot pre-commit instead, which is the
    // ordering defect: the day number in the correction was matched against the
    // old day's slot list. The pre-commit now declines that shape, and this is
    // where it lands.
    const amendableRung = step === "confirm" || step === "time";
    if (
      amendableRung &&
      !translationRequest &&
      !classification.explicitBookingConfirmation &&
      !classification.informationalOnly &&
      classification.topic !== "reschedule" &&
      !closure.isClosing &&
      !state.submitted &&
      !state.escalated
    ) {
      const amended = await applyBookingAmendment(
        identity,
        state,
        options.latestPatientText ?? null,
        step === "confirm",
      );
      if (amended) {
        bookingAmendment = amended.turn;
        identity = amended.identity;
        state = amended.state;
        step = nextBookingStep({
          collected: identity.collectedData,
          linked: identity.linked,
          bookingForOther: state.bookingForOther,
          intakeStaged: state.intakeStaged,
          ...(thirdPartyIntakeStaged === undefined ? {} : { thirdPartyIntakeStaged }),
          submitted: state.submitted,
        });
      }
    }
    // F-2 — an unanswered clarification the *server* owes is outstanding work
    // in exactly the way an unfinished rung is: the thread cannot end on it.
    const outstanding =
      Boolean(identity.pendingClarification) ||
      Boolean(pendingSelection) ||
      (workflowEngaged && !state.submitted && step !== "done");
    // P11S — the two booking questions the server owns the wording of.
    //
    // Both are computed here rather than left to the prompt because both are
    // about *which record a booking lands on*, and a model that guesses at that
    // writes an appointment onto the wrong person's file. Composed after the
    // classification so they can be suppressed on a turn that is only asking
    // for information.
    //
    // The target question is asked at the very start of a booking and nowhere
    // else: once the patient answers, either `bookingForOther` is set by the
    // third-party detector or `booking_identity_confirmed_at` is written by
    // `confirm_booking_identity`, and the condition below stops holding.
    //
    // `beneficiary` is the whole condition on the patient's side, and the two
    // things that used to be in its place are deliberately gone:
    // `bookingIdentityConfirmedAt`, which is a fact about the *sender* and
    // closed this question for every linked patient before it was ever asked,
    // and the "nothing collected yet" test, which a single stray field
    // silenced.
    const bookingTargetUnsettled =
      workflowEngaged &&
      !classification.informationalOnly &&
      step === "department" &&
      state.beneficiary === null &&
      !state.bookingForOther &&
      !state.intakeStaged;
    // The masked confirmation, for a linked sender booking for themself. Never
    // for a third-party booking: that one opens a new file and must not surface
    // anything about the sender's own record.
    //
    // Never on the same turn as the beneficiary question. Putting "is this you?"
    // and "is this for you?" in one message is what let a patient answer «أيوه»
    // to the first and be recorded as having answered the second — which is the
    // exact path a booking for somebody's wife took onto their own file.
    const identityConfirmation =
      workflowEngaged &&
      !classification.informationalOnly &&
      !bookingTargetUnsettled &&
      identity.linked &&
      identity.patientDisplayName &&
      !state.bookingForOther &&
      !identity.bookingIdentityConfirmedAt &&
      !identity.identityVerifiedAt
        ? {
            name: identity.patientDisplayName,
            nationalIdSuffix: identity.patientNationalIdSuffix,
          }
        : null;
    const briefing = buildTurnBriefing({
      locale: ctx.locale,
      stage,
      collected: identity.collectedData,
      pending: identity.pendingClarification,
      // A linked patient has a file already; the intake list is about opening
      // one, so it is empty for them rather than a list of things to ask.
      missingRequired:
        hasExistingSelfFile || intakeStaged
          ? []
          : thirdPartyMissing,
      missingOptional:
        hasExistingSelfFile || intakeStaged
          ? []
          : missingOptionalIntakeFields(intakeCollected),
      intakeStaged: intakeStaged || hasExistingSelfFile,
      closure,
      askBookingTarget: bookingTargetUnsettled,
      identityConfirmation,
      interruption: bookingInterruption,
      translationRequest,
      nameCorrectionQuestion,
    });
    const authority = resolveBookingAuthority({
      step,
      collected: identity.collectedData,
      offeredDoctorIds: state.offeredDoctorIds,
      offeredDays: state.offeredDays,
      offeredSlots: state.offeredSlots,
      closing: closure.isClosing,
      terminal: state.submitted || state.escalated || stage === "escalated",
      clinicDirectoryQuery,
      // F-4 — a clinic-information question is not a booking, and the ladder
      // cannot tell the difference on its own.
      clinicInformationQuery: isClinicInformationQuestion(
        options.latestPatientText,
      ) || classification.informationalOnly,
      bookingIntent: workflowEngaged,
      // V2-CONTAINMENT — positive, current-turn evidence that this is a
      // booking. `topic` comes from the message the patient just sent and from
      // nothing else, which is exactly the property the `department` rung now
      // depends on. A resumed thread carrying an old doctor no longer supplies
      // it, and neither does silence.
      bookingOpening:
        !classification.informationalOnly &&
        (classification.topic === "booking" ||
          classification.topic === "availability" ||
          classification.topic === "reschedule"),
      // F-9 — a cancellation request is not the first rung of a booking. The
      // pin it produces is a *read* of this patient's own appointments;
      // `cancel_my_appointment` is never pinned and keeps every check it has.
      cancellationRequest: isCancellationRequest(options.latestPatientText),
      linked: identity.linked,
      // F-10 — "في دكاترة غيره؟" continues the roster of the department this
      // conversation already settled, instead of restarting the funnel.
      rosterQuestion: isRosterQuestion(options.latestPatientText),
      explicitBookingConfirmation: classification.explicitBookingConfirmation,
      appointmentChangeRequest: classification.topic === "reschedule",
      appointmentChange: activeAppointmentChange
        ? { selectedTime: activeAppointmentChange.time !== null }
        : null,
      // F-2 / F-6 — what the pre-commit decided a moment ago.
      pendingSelection,
      unresolvedAnswer,
    });
    const bookingConfirmation =
      bookingAmendment?.kind === "updated"
        ? bookingAmendment.confirmation
        : authority.reason === "needs_booking_confirmation"
          ? await confirmationFromCollected(identity)
          : null;
    return {
      stage: stageScopedMountEnabled() ? stage : null,
      style: identity.communicationStyle,
      briefing,
      authority,
      outstanding,
      workflowEngaged,
      classification,
      // An amendment turn answers itself, deterministically, from a read the
      // server has already done. Mounting nothing is what makes "no booking is
      // written before the patient confirms" a property of the turn rather than
      // a promise about the prompt.
      informationalTools: bookingAmendment
        ? []
        : authority.reason === "needs_reschedule"
        ? ["reschedule_my_appointment"]
        : authority.reason === "needs_reschedule_availability"
          ? ["check_reschedule_availability"]
          : authority.reason === "needs_reschedule_confirmation"
            ? ["check_reschedule_availability"]
            : authority.reason === "needs_reschedule_target" || classification.topic === "reschedule"
              ? ["list_my_appointments", "check_reschedule_availability"]
        : classification.informationalOnly
          ? toolsForInformationalTurn(classification.topic)
          : null,
      bookingConfirmation,
      bookingAmendment,
      translationRequest,
      bookingInterruption,
      nameCorrectionQuestion,
    };
  } catch {
    return EMPTY_TURN_CONTEXT;
  }
}

/**
 * Reads the two intake answers the server owns, and commits them.
 *
 * Both were the model's job before, and both are the kind of job it should not
 * have: a spelling it "confirms" on the patient's behalf is a name nobody
 * chose, written onto a medical file, and a blood type it decides to skip is a
 * question that was never asked. The reading is a pure function
 * (`intake-answers.ts`); this half is the database.
 *
 * Nothing here can create a patient. It writes `ai_collected_data` and two
 * latches; `register_patient` still performs every validation and the staging
 * RPC still performs every identity check.
 */
type IntakeAnswerResolution = {
  identity: ResolvedPatientAiContext;
  /**
   * P12 — the one short question a partial name correction we could not place
   * deserves, or null. Composed by `buildNameCorrectionQuestion` from the name
   * already staged and what the patient just wrote; nothing is filed either
   * way, so the staged identity is untouched while it waits for an answer.
   */
  nameCorrectionQuestion: string | null;
};

async function resolveIntakeAnswers(
  identity: ResolvedPatientAiContext,
  latestPatientText: string | null,
  locale: "ar" | "en",
): Promise<IntakeAnswerResolution> {
  const text = (latestPatientText ?? "").trim();
  if (!text) return { identity, nameCorrectionQuestion: null };
  const state = identity.bookingStage;

  // The record outlives the confirmation (it carries the original spelling to
  // the staged intake), so the latch — not the record — is what says whether a
  // question is still open. Without that, every later "تمام" on the thread
  // would be read as an answer to a question nobody is asking.
  const pendingName = state.nameSpellingConfirmed ? null : state.pendingNameConfirmation;
  if (pendingName) {
    const reading = readNameConfirmation(text, pendingName.proposed);
    // P12 — a partial correction the server could not place against the name
    // already staged. Nothing is filed and nothing is replaced: the staged
    // beneficiary identity stays exactly as it is while one short question is
    // put to the patient. See `mergeNameCorrection`.
    if (reading.status === "ambiguous_correction") {
      return {
        identity,
        nameCorrectionQuestion: buildNameCorrectionQuestion(
          locale,
          reading.existing,
          reading.offered,
        ),
      };
    }
    // A "no" with no replacement, or anything that is not an answer at all,
    // leaves the question standing. `register_patient` asks it again.
    if (reading.status !== "confirmed" && reading.status !== "corrected") {
      return { identity, nameCorrectionQuestion: null };
    }
    // The patient's own spelling is authoritative for this intake; the
    // proposal is only ever filed when they said it was right.
    const filed = reading.status === "corrected" ? reading.name : pendingName.proposed;
    if (state.bookingForOther) {
      const recorded = await recordStageTurn(identity, {
        bookingIntent: true,
        bookingForOther: true,
        thirdPartyIntake: {
          ...(state.thirdPartyIntake ?? {
            fullName: null,
            nationalId: null,
            dateOfBirth: null,
            email: null,
            phone: null,
            bloodType: null,
            nameSpellingConfirmed: false,
          }),
          fullName: filed,
          nameSpellingConfirmed: true,
        },
        // Kept, not cleared: `nameSpellingConfirmed` is what stops the question
        // being asked again, and the record is what carries the patient's own
        // original spelling to `full_name_original` on the staged intake.
        pendingNameConfirmation: { proposed: filed, original: pendingName.original },
        nameSpellingConfirmed: true,
        tool: "patient_input_commit",
        outcome: "name_spelling_confirmed",
      });
      return {
        identity: recorded ? { ...identity, bookingStage: recorded.state } : identity,
        nameCorrectionQuestion: null,
      };
    }
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: { full_name: filed },
    });
    if (write.error) return { identity, nameCorrectionQuestion: null };
    const recorded = await recordStageTurn(identity, {
      bookingIntent: true,
      collectedOverride: { full_name: filed },
      pendingNameConfirmation: { proposed: filed, original: pendingName.original },
      nameSpellingConfirmed: true,
      tool: "patient_input_commit",
      outcome: "name_spelling_confirmed",
    });
    return {
      identity: {
        ...identity,
        collectedData: { ...identity.collectedData, full_name: filed },
        bookingStage: recorded?.state ?? identity.bookingStage,
      },
      nameCorrectionQuestion: null,
    };
  }

  // Blood type: asked, not yet answered. "لا أعرف" is an answer.
  if (state.bloodTypeAsks > 0 && !state.bloodTypeResolved) {
    if (isBloodTypeDeclined(text)) {
      const recorded = await recordStageTurn(identity, {
        bookingIntent: true,
        bloodTypeResolved: true,
        tool: "patient_input_commit",
        outcome: "blood_type_declined",
      });
      return {
        identity: recorded ? { ...identity, bookingStage: recorded.state } : identity,
        nameCorrectionQuestion: null,
      };
    }
    const resolved = resolveField({
      field: "blood_type",
      raw: text,
      collected: {},
      pending: null,
      country: identity.clinicCountry,
      timeZone: identity.clinicTimezone,
    });
    if (resolved.status !== "resolved" || typeof resolved.value !== "string") {
      // Unreadable is not a decline. The tool asks once more.
      return { identity, nameCorrectionQuestion: null };
    }
    const value = resolved.value;
    if (state.bookingForOther) {
      const recorded = await recordStageTurn(identity, {
        bookingIntent: true,
        bookingForOther: true,
        thirdPartyIntake: {
          ...(state.thirdPartyIntake ?? {
            fullName: null,
            nationalId: null,
            dateOfBirth: null,
            email: null,
            phone: null,
            bloodType: null,
            nameSpellingConfirmed: false,
          }),
          bloodType: value,
        },
        bloodTypeResolved: true,
        tool: "patient_input_commit",
        outcome: "blood_type_collected",
      });
      return {
        identity: recorded ? { ...identity, bookingStage: recorded.state } : identity,
        nameCorrectionQuestion: null,
      };
    }
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: { blood_type: value },
    });
    if (write.error) return { identity, nameCorrectionQuestion: null };
    const recorded = await recordStageTurn(identity, {
      bookingIntent: true,
      collectedOverride: { blood_type: value },
      bloodTypeResolved: true,
      tool: "patient_input_commit",
      outcome: "blood_type_collected",
    });
    return {
      identity: {
        ...identity,
        collectedData: { ...identity.collectedData, blood_type: value },
        bookingStage: recorded?.state ?? identity.bookingStage,
      },
      nameCorrectionQuestion: null,
    };
  }

  return { identity, nameCorrectionQuestion: null };
}

/** How many alternatives a "that time is taken" message may name. */
const MAX_AMENDMENT_ALTERNATIVES = 8;

function readCollected(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Applies a day/time edit to the booking waiting in the final review.
 *
 * The order is the guarantee: parse what was asked for, re-read the real
 * schedule for the doctor the conversation already holds, and only then move
 * the draft. Availability is never taken from the model, from the offer record,
 * or from the request itself — `getPatientAvailableSlots` is the same engine
 * `check_availability` and the booking RPC use.
 *
 * Returns null when the message is not an amendment, or when the schedule could
 * not be read: in both cases the turn proceeds exactly as it did before, with
 * the draft untouched.
 */
/**
 * Clears exactly the booking state a date lower bound invalidates, and no more.
 *
 * The day and the time go, because the patient has just said the day they were
 * looking at is not one they want. The offered days and slots go with them:
 * while an offer stands, `resolveBookingAuthority` reports `committed_days` /
 * `committed_slots` and pins nothing, so the turn would end without asking the
 * schedule anything — the offer *is* the thing being rejected.
 *
 * Everything upstream stays. The department, the doctor, the beneficiary and
 * every intake field answer "who, and where", and "not before the 9th" is not
 * an opinion about any of them. A boundary that restarted the funnel would be
 * the same defect in the other direction.
 *
 * A failed write leaves the draft exactly as it was rather than half-cleared:
 * the identity is only advanced once the state it describes is really stored.
 */
/**
 * Does a staged third-party intake really exist for this conversation?
 *
 * The same read `create_preliminary_booking` performs before it refuses, so the
 * ladder and the write cannot hold different opinions about whether the booking
 * is executable. `undefined` on any failure: an unreadable row is not evidence
 * that the file is missing, and reporting it as missing would send a patient
 * back to collect details they have already given.
 */
async function readThirdPartyIntakeStaged(
  identity: ResolvedPatientAiContext,
): Promise<boolean | undefined> {
  try {
    const pending = await getPendingConversationIntake({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
    });
    if (pending.error) return undefined;
    return pending.data?.is_third_party === true;
  } catch {
    return undefined;
  }
}

async function invalidateForDateBoundary(
  identity: ResolvedPatientAiContext,
): Promise<ResolvedPatientAiContext> {
  const state = identity.bookingStage;
  const holdsDay = readCollected(identity.collectedData.appointment_date) !== null;
  const holdsTime = identity.collectedData.appointment_time !== undefined
    && identity.collectedData.appointment_time !== null
    && identity.collectedData.appointment_time !== "";
  const holdsOffer = state.offeredDays.length > 0 || state.offeredSlots.length > 0;
  if (!holdsDay && !holdsTime && !holdsOffer) return identity;

  const collected: CollectedData = { appointment_date: "", appointment_time: "" };
  let next = identity;
  if (holdsDay || holdsTime) {
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: collected as Record<string, string | number>,
    });
    if (write.error) return identity;
    next = { ...identity, collectedData: { ...identity.collectedData, ...collected } };
  }
  const recorded = await recordStageTurn(next, {
    bookingIntent: true,
    ...(holdsDay || holdsTime ? { collectedOverride: collected } : {}),
    clearOfferedDays: true,
    clearOfferedSlots: true,
    // A bound is not an answer to an outstanding clarification either, and a
    // half-answered AM/PM question about a day that is being left behind is
    // meaningless.
    pendingAmendmentTime: null,
    tool: "patient_date_boundary",
    outcome: "date_boundary",
  });
  return recorded ? { ...next, bookingStage: recorded.state } : next;
}

async function applyBookingAmendment(
  identity: ResolvedPatientAiContext,
  state: BookingStageState,
  latestPatientText: string | null,
  /**
   * Item #4 — the rung this amendment arrived on.
   *
   * At `confirm` the patient is looking at a finished review and any edit to it
   * is theirs to make, so every amendment shape is accepted. At the *time* rung
   * there is no review yet and the offered-slot pre-commit already owns the
   * ordinary answers, so only a shape that moves the **day** is taken here —
   * which is precisely the shape the pre-commit is not allowed to read (see
   * `namesADifferentDay` in `offered-selection.ts`). Narrowing it this way is
   * what keeps un-gating the reader from re-interpreting turns that already
   * work.
   */
  atConfirmRung: boolean,
): Promise<{
  identity: ResolvedPatientAiContext;
  state: BookingStageState;
  turn: BookingAmendmentTurn;
} | null> {
  const doctorId = readCollected(identity.collectedData.doctor_id);
  const currentDate = readCollected(identity.collectedData.appointment_date);
  // Optional now. A booking at the time rung holds a day and no hour, and that
  // is exactly the state a day correction has to be able to reach: requiring an
  // hour here is what made the reader unreachable anywhere but `confirm`.
  const currentTime = minutesToPatientTime(identity.collectedData.appointment_time);
  if (!doctorId || !currentDate) return null;
  if (!currentTime && atConfirmRung) return null;

  // The answer to «تقصد 10 صباحًا ولا 10 مساءً؟» carries no hour and no day —
  // "الصبح" is the whole message — so it can only be read against the question
  // the server asked, which is why that question is state. Resolved here, ahead
  // of the ordinary parse, so the day the patient already settled is kept and
  // the booking is never restarted.
  const pendingMeridiem = state.pendingAmendmentTime;
  const answeredMeridiem = pendingMeridiem
    ? resolveMeridiemAnswer(latestPatientText, pendingMeridiem.times)
    : null;
  const request: BookingAmendmentRequest = answeredMeridiem
    ? { kind: "date_time", date: pendingMeridiem!.date, times: [answeredMeridiem] }
    : parseBookingAmendment({
        text: latestPatientText,
        currentDate,
        timeZone: identity.clinicTimezone,
        resolveDate: (value) => {
          const resolved = resolveField({
            field: "appointment_date",
            raw: value,
            collected: {},
            pending: null,
            country: identity.clinicCountry,
            timeZone: identity.clinicTimezone,
            offeredDays: state.offeredDays,
          });
          return resolved.status === "resolved" && typeof resolved.value === "string"
            ? resolved.value
            : null;
        },
      });
  // "الموعد اللي بعده" is defined relative to the slot being held. With no held
  // slot it names nothing, and guessing would be inventing a time.
  if (request.kind === "next_slot" && !currentTime) return null;
  // Away from the review, only a day move is this reader's business.
  if (!atConfirmRung && request.kind !== "date" && request.kind !== "date_time") {
    return null;
  }
  if (request.kind === "none") {
    // An unreadable message is not an answer to the outstanding AM/PM question,
    // and the question is not withdrawn because of it. The draft, the day and
    // the question all stay exactly as they were.
    return null;
  }

  const targetDate =
    request.kind === "date" || request.kind === "date_time" ? request.date : currentDate;
  const availability = await getPatientAvailableSlots({
    identity,
    date: targetDate,
    doctorId,
  }).catch(() => null);
  // A schedule that could not be read is not an answer about availability. The
  // draft stays exactly as it is and the ordinary turn continues.
  if (!availability || !availability.ok) return null;
  const doctorName =
    availability.doctorName || readCollected(identity.collectedData.doctor_name) || "";
  if (!doctorName) return null;
  const slots = [...availability.availableSlots].sort((a, b) => a.localeCompare(b));

  // Whatever happens next, the times the patient is about to be shown — or the
  // one about to enter the draft — are recorded as offered, so the existing
  // anti-hallucination guard on `create_preliminary_booking` still holds.
  const offer = slots.length > 0 ? { date: targetDate, times: slots } : undefined;

  const wanted: readonly string[] =
    request.kind === "time" || request.kind === "date_time"
      ? request.times.filter((time) => slots.includes(time))
      : request.kind === "next_slot"
        ? slots.filter((time) => time > currentTime!).slice(0, 1)
        : slots;

  const commit = async (
    time: string,
  ): Promise<{
    identity: ResolvedPatientAiContext;
    state: BookingStageState;
    turn: BookingAmendmentTurn;
  } | null> => {
    const minutes = minutesForTime(time);
    if (minutes === null) return null;
    const collected: CollectedData = {
      appointment_date: targetDate,
      appointment_time: minutes,
    };
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: collected as Record<string, string | number>,
    });
    if (write.error) return null;
    const recorded = await recordStageTurn(identity, {
      bookingIntent: true,
      collectedOverride: collected,
      ...(offer ? { offeredSlots: offer } : {}),
      // Whatever question was outstanding, a committed time answers it.
      pendingAmendmentTime: null,
      tool: "patient_booking_amendment",
      outcome: "amended",
    });
    const next: ResolvedPatientAiContext = {
      ...identity,
      collectedData: { ...identity.collectedData, ...collected },
      bookingStage: recorded?.state ?? identity.bookingStage,
    };
    const confirmation = await confirmationFromCollected(next);
    if (!confirmation) return null;
    return {
      identity: next,
      state: recorded?.state ?? identity.bookingStage,
      turn: { kind: "updated", confirmation },
    };
  };

  if (wanted.length === 1 && request.kind !== "date") {
    return commit(wanted[0]!);
  }
  // A day with exactly one free time needs no question: naming it and asking
  // again would be a question with one answer.
  if (request.kind === "date" && slots.length === 1) {
    return commit(slots[0]!);
  }

  // C2 — one hour, two readings, and the doctor's own schedule has both of
  // them free.
  //
  // This is the only case where the server genuinely cannot tell, and it is
  // answered with the one question that resolves it. Not with the day's slot
  // list: the patient has already named the hour, and listing everything throws
  // that away and asks them to pick the time from scratch. Nothing is written —
  // not the day, not the time — so the booking they are holding is exactly the
  // one they were reviewing, and `pendingAmendmentTime` carries the requested
  // day forward so "الصبح" on the next turn lands on it.
  if (wanted.length > 1 && (request.kind === "time" || request.kind === "date_time")) {
    const recorded = await recordStageTurn(identity, {
      bookingIntent: true,
      ...(offer ? { offeredSlots: offer } : {}),
      pendingAmendmentTime: { date: targetDate, times: wanted },
      tool: "patient_booking_amendment",
      outcome: "meridiem_clarification",
    });
    return {
      identity: {
        ...identity,
        bookingStage: recorded?.state ?? identity.bookingStage,
      },
      state: recorded?.state ?? state,
      turn: { kind: "clarify_meridiem", value: { date: targetDate, times: wanted } },
    };
  }

  // Nothing committed a time. Two shapes are left, and they differ in what
  // happens to the draft.
  //
  // A day the patient asked to move to, which has real times on it, *is*
  // settled — so the day is written and the time is cleared, which drops the
  // booking back to the time rung and lets the ordinary offered-time pre-commit
  // read their next message. Without that, their pick would be matched against
  // the day they had just left.
  //
  // A day with nothing free on it settles nothing. The draft is left exactly as
  // it was, so the patient still holds the booking they were reviewing.
  //
  // Only when the patient named a *day and no time*. A patient who named both
  // and was told the time is taken still holds the booking they were reviewing
  // — moving their day out from under them would silently change a draft they
  // never agreed to change. `pendingAmendmentTime` below is what lets them pick
  // one of the offered alternatives on the requested day without the draft
  // having moved at all.
  const dateMoved =
    request.kind === "date" && targetDate !== currentDate && slots.length > 0;
  let collectedPatch: CollectedData | null = null;
  if (dateMoved) {
    const write = await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: { appointment_date: targetDate, appointment_time: "" },
    });
    if (!write.error) {
      collectedPatch = { appointment_date: targetDate, appointment_time: "" };
    }
  }
  // The alternatives about to be named, remembered against the day they are on.
  // Without this a patient answering "11:00" to a list of times on the 16th has
  // that read as a time on the day the draft still holds.
  const pendingAlternatives =
    slots.length > 0 ? { date: targetDate, times: slots.slice(0, MAX_AMENDMENT_ALTERNATIVES) } : null;
  const recorded = offer || collectedPatch || state.pendingAmendmentTime
    ? await recordStageTurn(identity, {
        bookingIntent: true,
        ...(collectedPatch ? { collectedOverride: collectedPatch } : {}),
        ...(offer ? { offeredSlots: offer } : {}),
        pendingAmendmentTime: pendingAlternatives,
        tool: "patient_booking_amendment",
        outcome: wanted.length === 0 ? "unavailable" : "ambiguous",
      })
    : null;
  const nextState = recorded?.state ?? state;
  const nextIdentity: ResolvedPatientAiContext = {
    ...identity,
    ...(collectedPatch
      ? { collectedData: { ...identity.collectedData, ...collectedPatch } }
      : {}),
    bookingStage: recorded?.state ?? identity.bookingStage,
  };

  if (wanted.length > 1) {
    return {
      identity: nextIdentity,
      state: nextState,
      turn: {
        kind: "choose_time",
        value: { doctorName, date: targetDate, slots: wanted },
      },
    };
  }
  if (request.kind === "date" && slots.length > 1) {
    return {
      identity: nextIdentity,
      state: nextState,
      turn: {
        kind: "choose_time",
        value: {
          doctorName,
          date: targetDate,
          slots: slots.slice(0, MAX_AMENDMENT_ALTERNATIVES),
        },
      },
    };
  }
  // Which of the competing clock readings to name back to them. "الساعة 4" is
  // 04:00 and 16:00 until something disambiguates it; the reading nearest the
  // time they are already holding is the one they meant, and naming it is
  // strictly better than the vaguer "that time is not available".
  const currentMinutes = currentTime ? minutesForTime(currentTime) ?? 0 : 0;
  const requestedTime =
    request.kind === "time" || request.kind === "date_time"
      ? [...request.times].sort(
          (a, b) =>
            Math.abs((minutesForTime(a) ?? 0) - currentMinutes) -
            Math.abs((minutesForTime(b) ?? 0) - currentMinutes),
        )[0] ?? null
      : null;
  return {
    identity: nextIdentity,
    state: nextState,
    turn: {
      kind: "unavailable",
      value: {
        doctorName,
        date: targetDate,
        requestedTime,
        slots: slots.slice(0, MAX_AMENDMENT_ALTERNATIVES),
      },
    },
  };
}

/**
 * Which of the two readings «الصبح» / «بالليل» / "PM" picks, or null.
 *
 * Both candidates came from a live availability read, so nothing this returns
 * can be a time the doctor does not have free. A message that names neither
 * side — or, impossibly, both — resolves nothing and leaves the question
 * standing, which is strictly better than picking one.
 */
function resolveMeridiemAnswer(
  text: string | null | undefined,
  times: readonly string[],
): string | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 60) return null;
  // "10 صباحًا" names the hour as well, and is the same answer.
  const named = candidateClockTimes(raw).filter((time) => times.includes(time));
  if (named.length === 1) return named[0]!;
  const morning = readsMorning(raw);
  const evening = readsEvening(raw);
  if (morning === evening) return null;
  const matched = times.filter((time) => (Number(time.slice(0, 2)) < 12) === morning);
  return matched.length === 1 ? matched[0]! : null;
}

async function confirmationFromCollected(
  identity: ResolvedPatientAiContext,
): Promise<PatientBookingConfirmation | null> {
  const date = typeof identity.collectedData.appointment_date === "string"
    ? identity.collectedData.appointment_date
    : null;
  const time = minutesToPatientTime(identity.collectedData.appointment_time);
  let doctorName = typeof identity.collectedData.doctor_name === "string"
    ? identity.collectedData.doctor_name.trim()
    : "";
  if (!doctorName && typeof identity.collectedData.doctor_id === "string") {
    const directory = await loadDoctorDirectory(identity.clinicId).catch(() => null);
    doctorName = directory?.doctors.find(
      (doctor) => doctor.id === identity.collectedData.doctor_id,
    )?.name ?? "";
  }
  if (!date || !time || !doctorName) return null;
  return { doctorName, date, time };
}

function collectedFromThirdPartyDraft(
  draft: import("@/lib/ai/booking-stage").ThirdPartyIntakeDraft | null,
): CollectedData {
  if (!draft) return {};
  return {
    ...(draft.fullName ? { full_name: draft.fullName } : {}),
    ...(draft.nationalId ? { national_id: draft.nationalId } : {}),
    ...(draft.dateOfBirth ? { date_of_birth: draft.dateOfBirth } : {}),
    ...(draft.email ? { email: draft.email } : {}),
    ...(draft.phone ? { phone: draft.phone } : {}),
    ...(draft.bloodType ? { blood_type: draft.bloodType } : {}),
  };
}

function minutesForTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The result of reading this turn's message against the server's own offer.
 *
 * `identity` is a fresh snapshot: the original one when nothing committed, and
 * one carrying the committed field when something did. A failed persistence
 * attempt returns the original, so authority can never move forward on an
 * uncommitted fact.
 */
type OfferedCommit = {
  identity: ResolvedPatientAiContext;
  /** F-2 — the question the server now owes the patient, if any. */
  pendingSelection: PendingSelection | null;
  /** F-6 — the message was an answer and the server could read nothing. */
  unresolved: boolean;
};

/**
 * Commits one unique answer against the current offer set.
 *
 * The decision itself lives in `offered-selection.ts` and is shared with the
 * acceptance runner, so the two cannot drift. What is left here is the half
 * that needs a database: loading the live roster the offered ids point at, and
 * persisting whatever was decided.
 *
 * Deliberately narrow, as before: it accepts only a value from the server-owned
 * offer set, skips questions/closings/directory side turns, and performs no
 * booking write.
 */
async function commitLatestOfferedSelection(
  identity: ResolvedPatientAiContext,
  latestPatientText: string | null,
): Promise<OfferedCommit> {
  const unchanged: OfferedCommit = {
    identity,
    pendingSelection: identity.bookingStage.pendingSelection,
    unresolved: false,
  };
  if (!looksLikeChoiceAnswer(latestPatientText)) return unchanged;
  const text = latestPatientText!.trim();
  const state = identity.bookingStage;
  const step = nextBookingStep({
    collected: identity.collectedData,
    linked: identity.linked,
    bookingForOther: state.bookingForOther,
    intakeStaged: state.intakeStaged,
    submitted: state.submitted,
  });

  // The offered roster, resolved to the doctors who are *still* bookable and
  // kept in the order the patient actually read them: an ordinal belongs to
  // the sentence they saw, not to whatever order a later directory read
  // happens to return.
  let offeredDoctors: readonly { id: string; name: string }[] = [];
  if (step === "doctor" && state.offeredDoctorIds.length > 0) {
    const departmentId =
      typeof identity.collectedData.department_id === "string"
        ? identity.collectedData.department_id
        : null;
    if (!departmentId) return unchanged;
    const directory = await loadDoctorDirectory(identity.clinicId).catch(() => null);
    if (!directory) return unchanged;
    const liveById = new Map(
      availableDoctorsInDepartment(directory, departmentId).map((doctor) => [
        doctor.id,
        doctor,
      ]),
    );
    offeredDoctors = state.offeredDoctorIds
      .map((id) => liveById.get(id))
      .filter((doctor): doctor is NonNullable<typeof doctor> => Boolean(doctor))
      .map(toDoctorOption);
  }

  const outcome = resolveOfferedSelection({
    step,
    patientText: text,
    state,
    offeredDoctors,
    appointmentDate:
      typeof identity.collectedData.appointment_date === "string"
        ? identity.collectedData.appointment_date
        : null,
    extraDayResolver: (value) => {
      const resolved = resolveField({
        field: "appointment_date",
        raw: value,
        collected: {},
        pending: null,
        country: identity.clinicCountry,
        timeZone: identity.clinicTimezone,
        offeredDays: state.offeredDays,
      });
      return resolved.status === "resolved" && typeof resolved.value === "string"
        ? resolved.value
        : null;
    },
  });

  if (outcome.status === "skip") return unchanged;

  // F-2 — the ambiguity is *persisted*, not discarded. The clarification and
  // the answer to it are two different turns; without a record the second turn
  // would have nothing to resolve against but the model's reading of the
  // transcript.
  if (outcome.status === "ambiguous") {
    const pendingSelection = pendingSelectionFor(outcome);
    const recorded = await recordStageTurn(identity, {
      bookingIntent: true,
      pendingSelection,
      tool: "patient_input_commit",
      outcome: "selection_ambiguous",
    });
    await logSelectionOutcome(identity, "selection_ambiguous", step);
    return {
      identity: recorded
        ? { ...identity, bookingStage: recorded.state }
        : identity,
      pendingSelection,
      unresolved: false,
    };
  }

  if (outcome.status === "unresolved") {
    await logSelectionOutcome(identity, "selection_unresolved", step);
    return { ...unchanged, unresolved: true };
  }

  let collected: CollectedData;
  let patch: StagePatch;
  if (outcome.status === "doctor") {
    collected = {
      doctor_id: outcome.doctor.id,
      doctor_name: outcome.doctor.name,
      appointment_date: "",
      appointment_time: "",
    };
    patch = {
      bookingIntent: true,
      collectedOverride: collected,
      clearOfferedDays: true,
      clearOfferedSlots: true,
      // F-2 — anything that commits clears the question the server was owed.
      pendingSelection: null,
      tool: "patient_input_commit",
      outcome: "doctor_selected",
    };
  } else if (outcome.status === "day") {
    collected = { appointment_date: outcome.date, appointment_time: "" };
    patch = {
      bookingIntent: true,
      collectedOverride: collected,
      clearOfferedSlots: true,
      pendingSelection: null,
      tool: "patient_input_commit",
      outcome: "day_selected",
    };
  } else {
    const minutes = minutesForTime(outcome.time);
    if (minutes === null) return unchanged;
    collected = { appointment_time: minutes };
    patch = {
      bookingIntent: true,
      collectedOverride: collected,
      pendingSelection: null,
      tool: "patient_input_commit",
      outcome: "time_selected",
    };
  }

  const write = await setConversationAiState({
    clinicId: identity.clinicId,
    conversationId: identity.conversationId,
    collected: collected as Record<string, string | number>,
  });
  if (write.error) return unchanged;
  const recorded = await recordStageTurn(identity, patch);
  const nextIdentity: ResolvedPatientAiContext = {
    ...identity,
    collectedData: { ...identity.collectedData, ...collected },
    bookingStage: recorded?.state ?? identity.bookingStage,
  };
  await logSelectionOutcome(identity, patch.outcome!, step);
  return { identity: nextIdentity, pendingSelection: null, unresolved: false };
}

/** One privacy-safe label per pre-commit decision. No patient text, ever. */
async function logSelectionOutcome(
  identity: ResolvedPatientAiContext,
  outcome: string,
  step: string,
): Promise<void> {
  try {
    await logAgentTool({
      clinicId: identity.clinicId,
      actorId: null,
      tool: "patient_input_commit",
      params: { outcome, booking_step: step },
    });
  } catch {
    // The selected value is already committed. Telemetry must not turn that
    // success into an empty turn if the audit sink is temporarily unavailable.
  }
}

/**
 * Releases the `escalated` latch when staff hand a conversation back.
 *
 * The companion to `markBookingStageEscalated`, and the immediate half of the
 * P11B fix: the next inbound turn would release the latch anyway (see
 * `openBookingStageTurn`), but a conversation that staff have just returned to
 * the assistant should not be carrying a stage whose tool mount is empty even
 * for one turn. Reads the record, clears the latch, writes it back — no
 * derivation, no trace, and no other field touched.
 *
 * Best-effort like every other write in this module: the self-heal on the next
 * turn is the guarantee, and this is the promptness.
 */
export async function clearBookingStageEscalation(input: {
  clinicId: string;
  conversationId: string;
}): Promise<void> {
  if (!stageTrackingEnabled()) return;
  try {
    const { data } = await resolvePatientAiContext({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
    });
    const row = Array.isArray(data) ? data[0] : null;
    const state = parseBookingStageState(
      (row as { booking_stage?: unknown } | null)?.booking_stage,
    );
    if (!state.escalated) return;
    await setConversationAiState({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      stage: serializeBookingStageState({ ...state, escalated: false, stage: "idle" }),
    });
  } catch {
    // The next inbound turn releases it. Nothing here is load-bearing.
  }
}

/**
 * Latches a conversation as escalated.
 *
 * Escalation is the one stage the collected fields can never imply, and it is
 * the one the machine must never be able to leave: `LEGAL_EDGES.escalated` has
 * a single self-edge. Best-effort, like every other write here — a conversation
 * that reaches a human has already reached a human whether or not the record
 * says so.
 */
export async function markBookingStageEscalated(
  ctx: PatientToolContext,
): Promise<void> {
  if (!stageTrackingEnabled()) return;
  try {
    const identity = await authorizePatientConversation(ctx);
    await recordStageTurn(identity, { escalated: true, tool: "patient_escalation", outcome: "escalated" });
  } catch {
    // Nothing to do: the escalation itself already succeeded.
  }
}
