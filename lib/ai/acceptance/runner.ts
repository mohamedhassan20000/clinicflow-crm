/**
 * The production turn pipeline, reproduced end to end for one fixture clinic.
 *
 * This is what makes the suite an *acceptance* suite rather than a set of unit
 * tests: a scenario message goes in at the top, and what comes out at the
 * bottom is the sentence a patient on WhatsApp would actually have received,
 * having passed through every gate the product puts between the model and the
 * patient — in the same order, using the same functions.
 *
 * Faithfully reproduced, calling production code:
 *
 *   pre-model escalation      `detectPatientEscalation`
 *   closure / directory scope `detectConversationClosure`, `isClinicDirectoryQuestion`
 *   offered pre-commit        `resolveOfferedDoctor`, `resolveOfferedDay`, `resolveOfferedTime`
 *   stage + ladder            `deriveStage`, `nextBookingStep`
 *   authority                 `resolveBookingAuthority`, `shouldForceAuthority`,
 *                             `bookingAuthorityInstruction`
 *   briefing                  `buildTurnBriefing`
 *   prompt + mount            `buildPatientSystemPrompt`, `buildPatientStagePrompt`,
 *                             `allowedToolsForStage`, `STAGE_INDEPENDENT_TOOLS`
 *   reply gates               `enforceClinicDirectoryReply`, `enforcePatientFactReply`,
 *                             `enforcePatientWriteReply`, `checkDoctorGrounding`,
 *                             `scrubInternalFieldNames`, `enforceReplyRegister`
 *   lifecycle                 `resolveConversationLifecycle`
 *   episode boundary          history truncation, state reset (as `conversation-reset`)
 *
 * Substituted, and stated plainly because a metric is worth what the honesty of
 * its harness is worth:
 *
 *   * the database, by `AcceptanceSimulator` over the fixture clinic;
 *   * `loadDoctorDirectory` inside grounding enforcement, by the fixture roster;
 *   * RLS, entitlements and the identity RPCs, which have their own suites and
 *     are out of this loop entirely.
 */

import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "ai";

import {
  allowedToolsForStage,
  nextBookingStep,
  STAGE_INDEPENDENT_TOOLS,
  type BookingStage,
  type BookingStep,
} from "@/lib/ai/booking-stage";
import {
  bookingAuthorityInstruction,
  resolveBookingAuthority,
  shouldForceAuthority,
  type BookingAuthority,
} from "@/lib/ai/booking-authority";
import { buildTurnBriefing } from "@/lib/ai/turn-briefing";
import {
  missingIntakeFields,
  missingOptionalIntakeFields,
} from "@/lib/ai/booking-stage";
import { detectConversationClosure } from "@/lib/ai/conversation-closure";
import { isClinicDirectoryQuestion, enforceClinicDirectoryReply } from "@/lib/ai/clinic-directory";
import { enforcePatientFactReply } from "@/lib/ai/patient-fact-reply";
import { enforcePatientWriteReply } from "@/lib/ai/patient-write-commit";
import { checkDoctorGrounding, createGroundingLedger } from "@/lib/ai/patient-grounding";
import { isRosterBearingTurn, isRosterQuestion } from "@/lib/ai/roster-intent";
import { isCancellationRequest } from "@/lib/ai/cancellation-intent";
import { classifyPatientTurn, toolsForInformationalTurn } from "@/lib/ai/patient-turn-intent";
import { scrubInternalFieldNames } from "@/lib/ai/patient-intake-contract";
import { enforceReplyRegister } from "@/lib/ai/reply-register";
import {
  resolveConversationLifecycle,
  type LifecycleDecision,
} from "@/lib/ai/conversation-lifecycle";
import { applyEpisodeOpening } from "@/lib/ai/episode-greeting";
import { detectPatientEscalation } from "@/lib/ai/patient-escalation";
import {
  pendingSelectionFor,
  resolveOfferedSelection,
} from "@/lib/ai/offered-selection";
import { isClinicInformationQuestion } from "@/lib/ai/clinic-information-intent";
import { enforcePatientClarificationReply } from "@/lib/ai/patient-clarification-reply";
import {
  buildDeterministicCommercialReply,
  checkCommercialGrounding,
} from "@/lib/ai/patient-commercial-grounding";
import {
  buildPatientStagePrompt,
  buildPatientSystemPrompt,
} from "@/lib/ai/prompts/patient";
import {
  DEFAULT_COMMUNICATION_STYLE,
  type CommunicationStyle,
} from "@/lib/ai/communication-style";

import {
  FIXTURE_CLINIC,
  FIXTURE_DEPARTMENTS,
  FIXTURE_DOCTORS,
  doctorById,
} from "@/lib/ai/acceptance/fixture-clinic";
import { buildAcceptanceTools } from "@/lib/ai/acceptance/tools";
import { annotateToolsForPromptCache } from "@/lib/ai/platform/prompt-cache";
import type { AiTransport } from "@/lib/ai/platform/types";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { AcceptanceSimulator } from "@/lib/ai/acceptance/simulator";

const MAX_STEPS = 6;

export type TurnRecord = {
  index: number;
  patientText: string;
  /** The sentence the patient would actually have received. */
  replyText: string;
  stageBefore: BookingStage;
  stageAfter: BookingStage;
  /**
   * The ladder rung the turn *opened* on — the rung the patient's message is
   * answering.
   *
   * Recorded separately from `step` because the offered pre-commit runs before
   * the ladder is read, so a rung the patient settles in the same turn is never
   * `step`: answering the roster with "سارة علي" commits the doctor and `step`
   * reports `day`. Reading only `step` made the doctor rung invisible to the
   * progression check on every conversation that actually answered it, which is
   * a defect in the record rather than in the ladder.
   */
  stepBefore: BookingStep;
  /** The rung the booking needs next, after this turn's pre-commit. */
  step: BookingStep;
  authority: BookingAuthority | null;
  /** Tools the stage table left callable this turn. */
  activeTools: readonly string[];
  /** Tools the model asked for. */
  requestedTools: readonly string[];
  /** Tools that actually executed and returned. */
  executedTools: readonly string[];
  /**
   * The server-side calls this turn made, with the arguments that produced
   * them, in order.
   *
   * Recorded so a failed case can be *diagnosed* rather than merely counted.
   * Everything in it is synthetic by construction — the fixture clinic and the
   * scenario's own scripted messages — and it is read only by the acceptance
   * artifact writers. Production logging is unchanged and stays content-free;
   * see `lib/ai/acceptance/diagnostics.ts`.
   */
  toolCalls: readonly {
    tool: string;
    input: Record<string, unknown>;
    outcome: string;
  }[];
  /**
   * What the deterministic pre-commit read out of this message, before the
   * model saw it: the offered option it committed, or why it committed nothing.
   */
  precommit: PrecommitOutcome;
  /** Every gate that changed the reply, in the order they ran. */
  gates: readonly string[];
  lifecycle: LifecycleDecision["kind"];
  escalated: boolean;
  escalationReason: string | null;
  /** Whether the episode was closed and reset at the end of this turn. */
  episodeClosed: boolean;
  writeOutcome: string;
  failed: boolean;
  latencyMs: number;
};

/** What `precommitOfferedSelection` decided, as a label. */
export type PrecommitOutcome =
  | "skipped"
  | "committed_doctor"
  | "committed_day"
  | "committed_time"
  | "ambiguous"
  | "unresolved";

export type ConversationRecord = {
  scenarioId: string;
  locale: "ar" | "en";
  turns: readonly TurnRecord[];
  simulator: AcceptanceSimulator;
  /** Distinct episodes this conversation ran through (1 unless it closed). */
  episodes: number;
};

export type RunOptions = {
  model: LanguageModel;
  /**
   * F-14 — the prepared provider's call options, exactly as production sends
   * them. Empty for the offline personas, and the prompt-cache directive on the
   * live Anthropic-direct lanes.
   */
  providerOptions?: SharedV3ProviderOptions;
  /**
   * F-14 — the transport, so the tool block carries the same cache breakpoint
   * `createPatientAgent` gives it. Provider-agnostic here: the runner never
   * names a provider, it hands the transport to the platform layer.
   */
  transport?: AiTransport;
  locale: "ar" | "en";
  patient: ConstructorParameters<typeof AcceptanceSimulator>[0];
  failures?: ConstructorParameters<typeof AcceptanceSimulator>[1];
  hang?: readonly string[];
  style?: CommunicationStyle;
  /** Messages repeated verbatim by the transport, as WhatsApp actually does. */
  duplicateIndexes?: readonly number[];
  /** A turn index after which staff take the thread over. */
  humanTakeoverAfter?: number | null;
};

const CLINIC_DEPARTMENT_NAMES = FIXTURE_DEPARTMENTS.map((d) => d.name);
const CLINIC_DOCTORS = FIXTURE_DOCTORS.map((d) => ({ id: d.id, name: d.name }));

export async function runConversation(
  scenarioId: string,
  messages: readonly string[],
  options: RunOptions,
): Promise<ConversationRecord> {
  const sim = new AcceptanceSimulator(options.patient, options.failures ?? {});
  const style = options.style ?? DEFAULT_COMMUNICATION_STYLE;
  const locale = options.locale;
  const turns: TurnRecord[] = [];
  let history: ModelMessage[] = [];
  let lastAssistantText: string | null = null;
  let episodes = 1;
  let takenOver = false;

  for (const [index, rawMessage] of messages.entries()) {
    const startedAt = Date.now();
    const patientText = rawMessage;
    const stageBefore = sim.stage;
    // F-8 / F-11 — the transport's own record of what the patient wrote, which
    // is what both provenance gates are evaluated against. Recorded before the
    // turn runs, exactly as `inbound_messages` holds the message before
    // `patient-reply.ts` reads it back.
    sim.recordUtterance(patientText);

    if (options.humanTakeoverAfter !== null && options.humanTakeoverAfter === index) {
      takenOver = true;
    }

    // ---- 1. pre-model classification -------------------------------------
    const escalation = detectPatientEscalation(patientText, {
      clinicDepartmentNames: CLINIC_DEPARTMENT_NAMES,
    });
    if (takenOver || sim.patient.humanTakeover) {
      // A staff member holds the thread. Nothing is generated and nothing is
      // sent — the product records a draft at most.
      turns.push(baseTurn({
        index, patientText, replyText: "", stageBefore, stageAfter: sim.stage,
        stepBefore: "department", step: "department", authority: null, activeTools: [], requestedTools: [],
        executedTools: [], toolCalls: [], precommit: "skipped",
        gates: ["human_takeover"], lifecycle: "continue",
        escalated: false, escalationReason: "human_takeover", episodeClosed: false,
        writeOutcome: "none", failed: false, latencyMs: Date.now() - startedAt,
      }));
      continue;
    }
    if (escalation.escalate) {
      sim.escalated = true;
      const replyText = escalationCopy(locale, escalation.emergency);
      history.push({ role: "user", content: patientText });
      history.push({ role: "assistant", content: replyText });
      lastAssistantText = replyText;
      turns.push(baseTurn({
        index, patientText, replyText, stageBefore, stageAfter: sim.stage,
        stepBefore: "department", step: "department", authority: null, activeTools: [], requestedTools: [],
        executedTools: [], toolCalls: [], precommit: "skipped",
        gates: ["pre_model_escalation"], lifecycle: "continue",
        escalated: true, escalationReason: escalation.reason, episodeClosed: false,
        writeOutcome: "none", failed: false, latencyMs: Date.now() - startedAt,
      }));
      continue;
    }

    // ---- 2. turn context, exactly as `openBookingStageTurn` builds it -----
    // F-3 — the same server-owned "is anything outstanding?" the turn opener
    // computes before it reads the message, so a bare "تمام" mid-booking is an
    // acknowledgement here exactly as it is in production.
    const closure = detectConversationClosure(patientText, {
      outstandingWork: sim.bookingIntent && !sim.submitted,
    });
    const clinicDirectoryQuery = isClinicDirectoryQuestion(patientText);
    const classification = classifyPatientTurn(patientText, {
      workflowEngaged: sim.bookingIntent,
    });
    const stepBefore = nextBookingStep({
      collected: sim.collected,
      linked: sim.patient.linked,
      bookingForOther: sim.bookingForOther,
      intakeStaged: sim.intakeStaged,
      submitted: sim.submitted,
    });
    let precommit: PrecommitOutcome = "skipped";
    if (
      !closure.isClosing &&
      !clinicDirectoryQuery &&
      !classification.informationalOnly &&
      classification.topic !== "reschedule" &&
      !sim.submitted &&
      !sim.escalated
    ) {
      precommit = precommitOfferedSelection(sim, patientText);
    }
    const unresolvedAnswer = precommit === "unresolved";

    const stage = sim.stage;
    const step = nextBookingStep({
      collected: sim.collected,
      linked: sim.patient.linked,
      bookingForOther: sim.bookingForOther,
      intakeStaged: sim.intakeStaged,
      submitted: sim.submitted,
    });
    const authority = resolveBookingAuthority({
      step,
      collected: sim.collected,
      offeredDoctorIds: sim.stageState.offeredDoctorIds,
      offeredDays: sim.stageState.offeredDays,
      offeredSlots: sim.stageState.offeredSlots,
      closing: closure.isClosing,
      terminal: sim.submitted || sim.escalated,
      clinicDirectoryQuery,
      clinicInformationQuery: isClinicInformationQuestion(patientText),
      bookingIntent: sim.bookingIntent,
      // V2-CONTAINMENT — computed here exactly as `openBookingStageTurn`
      // computes it, because this runner is a second reading of that function
      // and the two must not disagree about what starts a booking.
      bookingOpening:
        !classification.informationalOnly &&
        (classification.topic === "booking" ||
          classification.topic === "availability" ||
          classification.topic === "reschedule"),
      // F-9 / F-10 — the two server-side readings the ladder cannot make on its
      // own, computed here exactly as `openBookingStageTurn` computes them.
      cancellationRequest: isCancellationRequest(patientText),
      linked: sim.patient.linked,
      rosterQuestion: isRosterQuestion(patientText),
      explicitBookingConfirmation: classification.explicitBookingConfirmation,
      appointmentChangeRequest: classification.topic === "reschedule",
      pendingSelection: sim.stageState.pendingSelection,
      unresolvedAnswer,
    });
    const hasExistingSelfFile = sim.patient.linked && !sim.bookingForOther;
    const briefing = buildTurnBriefing({
      locale,
      stage,
      collected: sim.collected,
      pending: null,
      missingRequired:
        hasExistingSelfFile || sim.intakeStaged ? [] : missingIntakeFields(sim.collected),
      missingOptional:
        hasExistingSelfFile || sim.intakeStaged ? [] : missingOptionalIntakeFields(sim.collected),
      intakeStaged: sim.intakeStaged || hasExistingSelfFile,
      closure,
    });

    // ---- 3. the mount ----------------------------------------------------
    const ledger = createGroundingLedger();
    const tools = annotateToolsForPromptCache(
      buildAcceptanceTools(sim, { ledger, hang: options.hang ?? [] }),
      options.transport ?? "vercel_ai_gateway",
      { alwaysActive: STAGE_INDEPENDENT_TOOLS },
    );
    const mounted = Object.keys(tools);
    const stageActive = allowedToolsForStage(stage, mounted);
    const stageScoped =
      authority.reason === "needs_clinic_directory" && mounted.includes("list_clinic_departments")
        ? ["list_clinic_departments"]
        : stageActive;
    const confirmationScoped = authority.reason === "needs_booking_confirmation"
      ? stageScoped.filter((name) => name !== "create_preliminary_booking")
      : stageScoped;
    const informationalTools = classification.topic === "reschedule"
      ? ["list_my_appointments"]
      : classification.informationalOnly
        ? toolsForInformationalTurn(classification.topic)
        : null;
    const activeTools = informationalTools
      ? informationalTools.filter((name) => mounted.includes(name))
      : confirmationScoped;
    const authorityLine = bookingAuthorityInstruction(locale, authority);
    const requestedTools: string[] = [];
    let forcedPin = false;

    history.push({ role: "user", content: patientText });
    // A duplicate inbound is the same body arriving twice. The transport does
    // this; the assistant must not act on it twice.
    if (options.duplicateIndexes?.includes(index)) {
      history.push({ role: "user", content: patientText });
    }

    const agent = new ToolLoopAgent({
      id: `clinicflow-patient-acceptance`,
      model: options.model,
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      instructions:
        buildPatientSystemPrompt(locale, style) +
        (briefing ? `\n\n${briefing}` : "") +
        (authorityLine ? `\n\n${authorityLine}` : ""),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0.2,
      maxOutputTokens: 800,
      prepareStep: ({ stepNumber }) => {
        const forced = shouldForceAuthority({
          authority,
          mountedTools: activeTools,
          stepNumber,
        });
        if (forced) forcedPin = true;
        const readDirectory = ledger.toolsSeen().includes("list_clinic_departments");
        const stepTools = readDirectory
          ? activeTools.filter((name) =>
              (STAGE_INDEPENDENT_TOOLS as readonly string[]).includes(name),
            )
          : activeTools;
        const pin =
          forced && authority.operation
            ? { toolChoice: { type: "tool" as const, toolName: authority.operation } }
            : {};
        return {
          activeTools: [...stepTools] as never,
          ...pin,
          system:
            buildPatientStagePrompt(locale, stage, style, briefing) +
            (authorityLine ? `\n${authorityLine}` : ""),
        };
      },
      onStepFinish: (stepResult) => {
        for (const call of stepResult.toolCalls ?? []) {
          if (typeof call.toolName === "string") requestedTools.push(call.toolName);
        }
      },
    });

    const callsBefore = sim.calls.length;
    let draft = "";
    let failed = false;
    try {
      const result = await agent.generate({ messages: history });
      draft = (result.text ?? "").trim();
    } catch {
      failed = true;
    }

    // ---- 4. the reply gates, in production order -------------------------
    const gates: string[] = [];
    if (forcedPin) gates.push("authority_pinned");

    const directoryEnforced = enforceClinicDirectoryReply({
      locale,
      latestPatientText: patientText,
      text: draft,
      ledger,
    });
    if (directoryEnforced.outcome !== "passthrough") gates.push(`directory:${directoryEnforced.outcome}`);

    const factEnforced = enforcePatientFactReply({
      locale,
      text: directoryEnforced.text,
      ledger,
    });
    if (factEnforced.outcome !== "passthrough") gates.push(`fact:${factEnforced.outcome}`);

    let text = factEnforced.text.trim();
    let writeOutcome = "none";

    if (text) {
      const writeEnforced = enforcePatientWriteReply({ locale, text, authority, ledger });
      writeOutcome = writeEnforced.outcome;
      if (writeEnforced.outcome !== "passthrough") gates.push(`write:${writeEnforced.outcome}`);
      text = writeEnforced.text;

      // F-1 — services, prices and insurers. Production regenerates once when
      // a receipt exists and otherwise goes straight to the deterministic
      // answer; the acceptance property is that the unbacked claim never
      // ships, so the replacement is applied directly here for the same reason
      // the roster fallback is.
      const commercial = checkCommercialGrounding({
        text,
        allowedPrices: ledger.prices(),
        sawServices: ledger.sawServices(),
        sawInsurers: ledger.sawInsurers(),
      });
      if (!commercial.grounded) {
        gates.push(
          `commercial:${[...new Set(commercial.violations.map((v) => v.source))].join("|")}`,
        );
        text = buildDeterministicCommercialReply({
          locale,
          kind: commercial.violations.some((v) => v.source === "unbacked_insurer")
            ? "insurance"
            : "price",
        });
      }

      // Grounding, with the fixture directory standing in for the DB read.
      const rosterBearing = isRosterBearingTurn({
        patientText,
        replyText: text,
        sawDoctorTool: ledger.sawDoctors(),
      });
      const stateBacked = [
        ...(typeof sim.collected.doctor_name === "string" ? [sim.collected.doctor_name] : []),
        ...sim.stageState.offeredDoctorIds.map((id) => doctorById(id)?.name ?? "").filter(Boolean),
      ];
      const check = checkDoctorGrounding({
        text,
        allowedNames: [...ledger.names("doctor"), ...stateBacked],
        clinicDoctors: CLINIC_DOCTORS,
        allowedOtherNames: [
          ...ledger.names("department"),
          ...ledger.names("service"),
          ...CLINIC_DEPARTMENT_NAMES,
        ],
        rosterBearing,
      });
      if (!check.grounded) {
        gates.push(`grounding:${check.violations.map((v) => v.source).join("|")}`);
        // Production regenerates once, then falls back to a deterministic
        // roster reply. Both replace the ungrounded sentence; the acceptance
        // property is that the ungrounded sentence never ships, so the
        // deterministic replacement is applied directly here.
        text = deterministicRosterReply(locale, sim);
      }

      // F-2 — the server's own question outranks whatever was composed above.
      const clarified = enforcePatientClarificationReply({ locale, text, authority });
      if (clarified.outcome !== "passthrough") {
        gates.push(`clarification:${clarified.candidateCount}`);
        text = clarified.text;
      }

      const scrubbed = scrubInternalFieldNames(text, locale);
      if (scrubbed.leaked.length > 0) gates.push(`scrub:${scrubbed.leaked.join(",")}`);
      text = scrubbed.text;

      const styled = enforceReplyRegister({ text, style });
      if (styled.changed) gates.push(`register:${styled.labels.join(",")}`);
      text = styled.text;
    }

    // ---- 5. lifecycle ----------------------------------------------------
    const workflowEngaged = sim.bookingIntent;
    const outstanding =
      Boolean(sim.stageState.pendingSelection) ||
      (workflowEngaged && !sim.submitted && step !== "done");
    const cancelled = (() => {
      const r = ledger.resultFor("cancel_my_appointment");
      return typeof r === "object" && r !== null && (r as Record<string, unknown>).cancelled === true;
    })();
    const goalCompleted =
      writeOutcome === "committed" || cancelled || (workflowEngaged && !outstanding);
    // P11S — the same server-computed signal `patient-reply.ts` passes: the
    // turn was classified informational and the workflow owes nothing.
    const informationAnswered = classification.informationalOnly && !outstanding;
    const lifecycle = resolveConversationLifecycle({
      locale,
      latestPatientText: patientText,
      lastAssistantText,
      replyText: text,
      outstanding,
      goalCompleted,
      informationAnswered,
    });
    let episodeClosed = false;
    if (lifecycle.kind === "close") {
      text = lifecycle.text;
      episodeClosed = true;
    } else if (lifecycle.kind === "offer_end") {
      text = lifecycle.text;
    }

    // P11S — the mandatory episode opening, applied exactly where production
    // applies it: after the lifecycle has spoken, on the first assistant
    // message of an episode, and never on the turn that ends one.
    // `lastAssistantText === null` is this runner's reproduction of "no outbound
    // row inside the current episode" — it is set to null at the start and
    // again by the episode boundary below.
    const openingEpisode = lastAssistantText === null && !episodeClosed;
    if (openingEpisode) {
      text = applyEpisodeOpening({
        locale,
        clinicName: FIXTURE_CLINIC.name,
        latestPatientText: patientText,
        replyText: text,
      });
    }

    history.push({ role: "assistant", content: text });
    lastAssistantText = text;

    turns.push(baseTurn({
      index,
      patientText,
      replyText: text,
      stageBefore,
      stageAfter: sim.stage,
      stepBefore,
      step,
      authority,
      activeTools,
      requestedTools,
      executedTools: ledger.toolsSeen(),
      toolCalls: sim.calls.slice(callsBefore).map((call) => ({
        tool: call.tool,
        input: call.input,
        outcome: call.outcome,
      })),
      precommit,
      gates,
      lifecycle: lifecycle.kind,
      escalated: false,
      escalationReason: null,
      episodeClosed,
      writeOutcome,
      failed,
      latencyMs: Date.now() - startedAt,
    }));

    // ---- 6. the episode boundary ----------------------------------------
    // `closeAndResetConversation` clears the assistant's state and stamps
    // `ai_context_reset_at`, and the next turn's history is read from *after*
    // that stamp. Reproduced by clearing state and dropping the transcript.
    if (episodeClosed) {
      sim.resetEpisode();
      history = [];
      lastAssistantText = null;
      episodes += 1;
    }
  }

  return { scenarioId, locale, turns, simulator: sim, episodes };
}

// ---------------------------------------------------------------------------

function baseTurn(input: TurnRecord): TurnRecord {
  return input;
}

/**
 * The server-side pre-commit, as `commitLatestOfferedSelection` performs it.
 *
 * The decision is `resolveOfferedSelection` — the same pure function production
 * calls — so the two cannot drift. What is reimplemented here is only the
 * plumbing: the fixture stands in for the directory read, and the simulator's
 * fields stand in for `set_conversation_ai_state`.
 *
 * Returns whether the message was an answer the server could read nothing from,
 * which is the F-6 signal the authority needs to re-state the offer instead of
 * going silent.
 */
function precommitOfferedSelection(
  sim: AcceptanceSimulator,
  text: string,
): PrecommitOutcome {
  const step = nextBookingStep({
    collected: sim.collected,
    linked: sim.patient.linked,
    bookingForOther: sim.bookingForOther,
    intakeStaged: sim.intakeStaged,
    submitted: sim.submitted,
  });
  const offeredDoctors =
    step === "doctor"
      ? sim.stageState.offeredDoctorIds
          .map((id) => doctorById(id))
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .filter((d) => d.state === "available")
          .map((d) => ({ id: d.id, name: d.name }))
      : [];
  const outcome = resolveOfferedSelection({
    step,
    patientText: text,
    state: sim.stageState,
    offeredDoctors,
    appointmentDate:
      typeof sim.collected.appointment_date === "string"
        ? sim.collected.appointment_date
        : null,
  });

  if (outcome.status === "skip") return "skipped";
  if (outcome.status === "unresolved") return "unresolved";

  if (outcome.status === "ambiguous") {
    // Persisted exactly as production persists it: the clarification and the
    // answer to it are two different turns.
    sim.stageState = {
      ...sim.stageState,
      pendingSelection: pendingSelectionFor(outcome),
    };
    sim.markIntent();
    return "ambiguous";
  }

  if (outcome.status === "doctor") {
    const doctor = doctorById(outcome.doctor.id)!;
    sim.collected = {
      ...sim.collected,
      doctor_id: doctor.id,
      doctor_name: doctor.name,
      department_id: doctor.departmentId,
      department_name:
        FIXTURE_DEPARTMENTS.find((d) => d.id === doctor.departmentId)?.name ?? "",
    };
  } else if (outcome.status === "day") {
    sim.collected = { ...sim.collected, appointment_date: outcome.date };
  } else {
    sim.collected = {
      ...sim.collected,
      appointment_time:
        Number(outcome.time.slice(0, 2)) * 60 + Number(outcome.time.slice(3, 5)),
    };
  }
  // Anything that commits clears the question the server was owed.
  sim.stageState = { ...sim.stageState, pendingSelection: null };
  sim.markIntent();
  return outcome.status === "doctor"
    ? "committed_doctor"
    : outcome.status === "day"
      ? "committed_day"
      : "committed_time";
}

/** The deterministic replacement production falls back to on a grounding miss. */
function deterministicRosterReply(locale: "ar" | "en", sim: AcceptanceSimulator): string {
  const departmentId =
    typeof sim.collected.department_id === "string" ? sim.collected.department_id : null;
  const names = departmentId
    ? FIXTURE_DOCTORS.filter((d) => d.departmentId === departmentId && d.state === "available").map(
        (d) => d.name,
      )
    : [];
  if (names.length === 0) {
    return locale === "ar"
      ? "معلش، محتاج أراجع البيانات المتاحة قبل ما أقولك أسماء. تحب تحجز في أنهي قسم؟"
      : "Let me check the clinic's records before I give you any names. Which department did you want?";
  }
  return locale === "ar"
    ? `الدكاترة المتاحين حاليًا: ${names.join("، ")}. تحب تحجز مع مين؟`
    : `The doctors currently available are: ${names.join(", ")}. Who would you like to book with?`;
}

function escalationCopy(locale: "ar" | "en", emergency: boolean): string {
  if (emergency) {
    return locale === "ar"
      ? "لو ده موقف طارئ، اتصل بالإسعاف على 123 فورًا. حد من فريق العيادة هيتواصل معاك حالًا."
      : "If this is an emergency, call 123 immediately. A member of the clinic team will contact you right away.";
  }
  return locale === "ar"
    ? "تمام، هحوّلك لحد من فريق العيادة وهيتواصل معاك في أقرب وقت."
    : "Of course — I am passing you to a member of the clinic team and they will be in touch shortly.";
}

export { FIXTURE_CLINIC };
