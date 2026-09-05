/**
 * P9 — the harness that turns a model, a step budget and an orchestration mode
 * into the study's acceptance numbers.
 *
 * Deliberately independent of `lib/ai/platform/registry.ts`. The study's Phase
 * 0.5 asks whether a Sonnet-class route with a larger step budget dissolves the
 * problem; answering that must not require adding an uncertified alias to the
 * production registry, because adding one is precisely the decision the
 * measurement is supposed to inform. So the candidate routes live here, typed as
 * `CertifiedModelRoute` and prepared through the same managed-gateway provider
 * the product uses — same ZDR enforcement, same `only:` provider pin, same tags
 * — while `registry.ts` stays byte-identical and `patient_booking` keeps
 * pointing at Haiku until somebody decides otherwise.
 *
 * What is measured is L2: prompt, model, tool schemas, step budget, stage
 * scoping. Tools are simulated by `BookingSimulator` against a fixture clinic,
 * which is what makes a Haiku run and a Sonnet run comparable at all — the two
 * see identical tool results. `authorizePatientConversation`, RLS, the identity
 * RPCs and the real availability engine are out of the loop and are covered by
 * their own suites.
 */

import { ToolLoopAgent, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";

import { allowedToolsForStage } from "@/lib/ai/booking-stage";
import {
  BookingSimulator,
  type BookingScenario,
  type ReAskTopic,
} from "@/lib/ai/eval/booking-scenarios";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";
import type { CertifiedModelRoute } from "@/lib/ai/platform/types";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";
import {
  buildPatientStagePrompt,
  buildPatientSystemPrompt,
} from "@/lib/ai/prompts/patient";

// ---------------------------------------------------------------------------
// Candidate routes
// ---------------------------------------------------------------------------

const SHARED_PRIVACY = {
  gatewayZeroDataRetention: true,
  directProviderRetention: "contractual_only",
  noTrainingRequired: true,
} as const;

/** The route `patient_booking` actually runs on today. The baseline. */
export const HAIKU_ROUTE: CertifiedModelRoute = {
  alias: "patient-haiku-bootstrap-v1",
  transport: "anthropic_direct",
  provider: "anthropic",
  modelId: "anthropic/claude-haiku-4.5",
  providerModelId: "claude-haiku-4-5",
  allowedServingProviders: ["anthropic"],
  capabilities: ["streaming", "tool_calling", "arabic", "english"],
  privacy: SHARED_PRIVACY,
  pricing: {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 5_000_000,
    cacheReadMicrosPerMillion: 100_000,
    cacheWriteMicrosPerMillion: 1_250_000,
  },
  certification: {
    status: "bootstrap_approved",
    version: "p4-bootstrap-2026-07-18",
    evaluationSuiteVersion: "p4-deterministic-tool-suite-v1",
    effectiveDate: "2026-07-18",
    rollbackAlias: null,
  },
};

/**
 * The Sonnet-class candidate.
 *
 * Same model id and same certified tier as `staff-sonnet-bootstrap-v1`, which
 * is already approved and already carries the identical ZDR/no-training
 * guarantees. What it does *not* yet have is a patient-side alias, a patient
 * privacy-policy version, or a patient certification record — which is exactly
 * why it is defined here and not in the registry.
 */
export const SONNET_CANDIDATE_ROUTE: CertifiedModelRoute = {
  alias: "patient-sonnet-candidate-v1",
  transport: "anthropic_direct",
  provider: "anthropic",
  modelId: "anthropic/claude-sonnet-4.5",
  providerModelId: "claude-sonnet-4-5",
  allowedServingProviders: ["anthropic"],
  capabilities: ["streaming", "tool_calling", "arabic", "english"],
  privacy: SHARED_PRIVACY,
  pricing: {
    inputMicrosPerMillion: 3_000_000,
    outputMicrosPerMillion: 15_000_000,
    cacheReadMicrosPerMillion: 300_000,
    cacheWriteMicrosPerMillion: 3_750_000,
  },
  certification: {
    status: "bootstrap_approved",
    version: "p9-candidate-2026-08-23",
    evaluationSuiteVersion: "p9-booking-scenario-suite-v1",
    effectiveDate: "2026-08-23",
    rollbackAlias: "patient-haiku-bootstrap-v1",
  },
};

export type HarnessVariant = {
  id: string;
  label: string;
  route: CertifiedModelRoute;
  maxSteps: number;
  /** Stage-scoped `activeTools` + prompt, or today's flat mount. */
  staged: boolean;
};

export const HARNESS_VARIANTS: readonly HarnessVariant[] = [
  {
    id: "haiku-6-flat",
    label: "Haiku 4.5 · maxSteps 6 · flat mount (production baseline)",
    route: HAIKU_ROUTE,
    maxSteps: 6,
    staged: false,
  },
  {
    id: "haiku-6-staged",
    label: "Haiku 4.5 · maxSteps 6 · stage-scoped",
    route: HAIKU_ROUTE,
    maxSteps: 6,
    staged: true,
  },
  {
    id: "sonnet-10-flat",
    label: "Sonnet 4.5 · maxSteps 10 · flat mount (Phase 0.5 candidate)",
    route: SONNET_CANDIDATE_ROUTE,
    maxSteps: 10,
    staged: false,
  },
  {
    id: "sonnet-10-staged",
    label: "Sonnet 4.5 · maxSteps 10 · stage-scoped",
    route: SONNET_CANDIDATE_ROUTE,
    maxSteps: 10,
    staged: true,
  },
];

// ---------------------------------------------------------------------------
// The simulated mount
// ---------------------------------------------------------------------------

/**
 * The eleven patient tools, with their real names and argument shapes, backed
 * by the simulator.
 *
 * The schemas matter as much as the names: half of what a model gets right or
 * wrong about a tool is what the tool's description and parameters told it, and
 * a harness that simplified them would be measuring a different product.
 */
export function simulatedPatientTools(sim: BookingSimulator) {
  return {
    prepare_booking: tool({
      description:
        "Start or continue appointment booking. Call this first. For an existing patient it " +
        "returns their treating doctor first, together with the other bookable doctors in that " +
        "department. For a new patient it lists active departments, then returns ALL bookable " +
        "doctors of the chosen department. Pass the patient's own words as `doctor` — a name, an " +
        "ordinal, or a request such as 'another doctor' / 'في دكاترة غيره؟', which returns the " +
        "rest of the roster without restarting the flow.",
      inputSchema: z.object({
        department: z.string().trim().min(1).max(120).optional(),
        doctor: z.string().trim().min(1).max(120).optional(),
        show_other_doctors: z.boolean().optional(),
      }),
      execute: async (input) => sim.prepareBooking(input),
    }),
    list_doctors: tool({
      description:
        "List every bookable doctor of one department. Use it for follow-ups such as 'are there " +
        "other doctors?', 'مين تاني؟', or 'who else is available?'. With no department it uses " +
        "the one this conversation already chose, so the booking context is preserved.",
      inputSchema: z.object({
        department: z.string().trim().min(1).max(120).optional(),
        exclude_doctor_id: z.string().uuid().optional(),
      }),
      execute: async (input) => sim.listDoctors(input),
    }),
    list_available_days: tool({
      description:
        "List real days that have at least one bookable slot for the resolved doctor. Call this " +
        "after doctor selection and before check_availability. Days only, never times.",
      inputSchema: z.object({
        doctor_id: z.string().uuid().optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
        search_days: z.number().int().min(1).max(60).default(21),
        service_id: z.string().uuid().optional(),
      }),
      execute: async (input) => sim.listAvailableDays(input),
    }),
    check_availability: tool({
      description:
        "Check real clinic appointment availability for a day. Pass the day the way the patient " +
        "described it. Availability is logistics-only and does not require DOB verification.",
      inputSchema: z.object({
        date: z.string().trim().min(3).max(60),
        doctor_id: z.string().uuid().optional(),
        service_id: z.string().uuid().optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
      }),
      execute: async (input) => sim.checkAvailability(input),
    }),
    create_preliminary_booking: tool({
      description:
        "Create a preliminary pending appointment for an existing verified patient, or a " +
        "real-slot pending request for a provisional intake. The clinic must confirm it. Never " +
        "ask for or accept a patient id.",
      inputSchema: z
        .object({
          doctor_id: z.string().uuid().optional(),
          scheduled_at: z.string().optional(),
          date: z.string().trim().min(2).max(60).optional(),
          time: z.string().trim().min(1).max(60).optional(),
          duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
          service_id: z.string().uuid().optional(),
        })
        .refine((value) => value.scheduled_at || (value.date && value.time), {
          message: "Provide scheduled_at or the patient's natural date and time.",
        }),
      execute: async (input) => sim.createBooking(input),
    }),
    register_patient: tool({
      description:
        "Register the person writing in as a new patient of this clinic, when the conversation " +
        "is not yet linked to a patient record. Never ask for, accept, or invent a phone number " +
        "or a patient id.",
      inputSchema: z.object({
        full_name: z.string().trim().min(2).max(120),
        national_id: z.string().trim().min(4).max(40),
        date_of_birth: z.string().trim().min(4).max(60),
        email: z.string().trim().min(5).max(320),
      }),
      execute: async (input) => sim.registerPatient(input),
    }),
    verify_patient_identity: tool({
      description:
        "Verify the patient using their date of birth before showing any appointment details.",
      inputSchema: z.object({ date_of_birth: z.string().trim().min(4).max(60) }),
      execute: async () => sim.verifyIdentity(),
    }),
    list_my_appointments: tool({
      description: "List the patient's upcoming appointments, after identity verification.",
      inputSchema: z.object({}),
      execute: async () => sim.listAppointments(),
    }),
    cancel_my_appointment: tool({
      description: "Cancel one pending appointment the patient owns.",
      inputSchema: z.object({ appointment_id: z.string().uuid() }),
      execute: async () => sim.cancelAppointment(),
    }),
    get_clinic_info: tool({
      description: "The clinic's stored name, address, phone, website and working hours.",
      inputSchema: z.object({}),
      execute: async () => sim.clinicInfo(),
    }),
    answer_clinic_faq: tool({
      description: "Answer from clinic-authored FAQ entries only.",
      inputSchema: z.object({ question: z.string().trim().min(2).max(400) }),
      execute: async () => sim.faq(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Running one scenario
// ---------------------------------------------------------------------------

export type TurnObservation = {
  index: number;
  toolsCalled: readonly string[];
  text: string;
  stageBefore: string;
  stageAfter: string;
  steps: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  failed: boolean;
};

export type ScenarioRun = {
  scenarioId: string;
  locale: "en" | "ar";
  turns: readonly TurnObservation[];
  neverOfferedAttempts: number;
  booked: boolean;
  turnsToBooking: number | null;
  illegalTransitions: number;
};

/**
 * Runs one scenario, turn by turn, against one variant.
 *
 * `options.model` substitutes a model for the gateway route. It exists so the
 * *structural* half of the study's acceptance criteria — the half that is a
 * property of the orchestration rather than of the model's judgement — can be
 * measured deterministically, offline, and without spend: point a deliberately
 * non-compliant model at both mounts and the difference between them is the
 * whole contribution of stage scoping, with the model's competence held at a
 * constant of zero.
 */
export async function runScenario(
  variant: HarnessVariant,
  scenario: BookingScenario,
  options: { model?: LanguageModel } = {},
): Promise<ScenarioRun> {
  const sim = new BookingSimulator(scenario.patient);
  const tools = simulatedPatientTools(sim);
  const mounted = [...PATIENT_TOOL_NAMES];
  const prepared = managedGatewayProvider.prepare({
    route: variant.route,
    task: "patient_booking",
    surface: "patient_messaging",
    clinicId: "eval-clinic",
    actorId: `eval-${scenario.id}`,
    policyVersion: "p9-booking-harness-v1",
  });

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const observations: TurnObservation[] = [];
  let booked = false;
  let turnsToBooking: number | null = null;

  for (const [index, message] of scenario.turns.entries()) {
    const stageBefore = sim.stage;
    const callsBefore = sim.calls.length;
    history.push({ role: "user", content: message });
    const startedAt = Date.now();
    const agent = new ToolLoopAgent({
      id: `clinicflow-patient-eval-${variant.id}`,
      model: options.model ?? prepared.model,
      ...(options.model ? {} : { providerOptions: prepared.providerOptions }),
      instructions: buildPatientSystemPrompt(scenario.locale),
      tools,
      stopWhen: stepCountIs(variant.maxSteps),
      temperature: 0.2,
      maxOutputTokens: 800,
      // Scoped from `stageBefore`, not from `sim.stage`. The production agent
      // resolves the stage once at the top of the turn and holds it for every
      // step (see `createPatientAgent`), because recomputing it mid-loop would
      // make the mount depend on state the tools are concurrently mutating. A
      // harness that re-read the stage each step would measure a more permissive
      // system than the one that ships, and would flatter it.
      ...(variant.staged
        ? {
            prepareStep: () => ({
              activeTools: allowedToolsForStage(stageBefore, mounted) as Array<
                keyof typeof tools
              >,
              system: buildPatientStagePrompt(scenario.locale, stageBefore),
            }),
          }
        : {}),
    });

    let text = "";
    let steps = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let failed = false;
    try {
      const result = await agent.generate({ messages: history });
      text = (result.text ?? "").trim();
      steps = result.steps?.length ?? 0;
      inputTokens = result.usage?.inputTokens ?? 0;
      outputTokens = result.usage?.outputTokens ?? 0;
    } catch {
      failed = true;
    }
    history.push({ role: "assistant", content: text });

    const newCalls = sim.calls.slice(callsBefore);
    if (!booked && newCalls.some((call) => call.outcome === "submitted")) {
      booked = true;
      turnsToBooking = index + 1;
    }
    observations.push({
      index,
      toolsCalled: newCalls.map((call) => call.tool),
      text,
      stageBefore,
      stageAfter: sim.stage,
      steps,
      latencyMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      failed,
    });
  }

  return {
    scenarioId: scenario.id,
    locale: scenario.locale,
    turns: observations,
    neverOfferedAttempts: sim.neverOfferedAttempts,
    booked,
    turnsToBooking,
    illegalTransitions: sim.stageState.illegalTransitions,
  };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Does this reply ask for something the conversation has already settled?
 *
 * A keyword detector, and its limits are worth stating rather than hiding. It
 * looks for an *interrogative* about a topic — a question mark or an imperative
 * verb of asking, near a topic word — so a reply that merely *mentions* the
 * department ("in Dermatology, Dr Sara Ali is free on…") is not counted. It will
 * still miss an unusual phrasing and it will occasionally over-count a
 * confirmation. It is applied identically to every variant, so it is a fair
 * comparator even where it is an imperfect absolute.
 */
const REASK_PATTERNS: Readonly<Record<ReAskTopic, Readonly<Record<"en" | "ar", RegExp>>>> = {
  department: {
    en: /(which|what)\s+(department|speciality|specialty|clinic)\b|department (would|do) you/i,
    ar: /(أي|اي|أنهي|انهي)\s*(قسم|تخصص)|قسم\s*(إيه|ايه)/,
  },
  doctor: {
    en: /(which|what)\s+doctor\b|who would you like to (book|see)|doctor (would|do) you/i,
    ar: /(أي|اي|أنهي|انهي)\s*(دكتور|طبيب)|مع\s*مين|(دكتور|طبيب)\s*(إيه|ايه)/,
  },
  day: {
    en: /(which|what)\s+(day|date)\b|when would you like/i,
    ar: /(أي|اي|أنهي|انهي)\s*(يوم|تاريخ)|(يوم)\s*(إيه|ايه)|إمتى|امتى/,
  },
  phone: {
    en: /(your|the)\s+(phone|mobile|whatsapp)\s*(number)?\b.*\?|what.*(phone|mobile) number/i,
    ar: /(رقم)\s*(هاتفك|تليفونك|موبايلك|الهاتف|التليفون)/,
  },
};

export function asksAbout(text: string, topic: ReAskTopic, locale: "en" | "ar"): boolean {
  if (!text) return false;
  return REASK_PATTERNS[topic][locale].test(text);
}

/** A reply that gives up and hands the patient a phone number. */
export function looksLikeTechnicalFallback(text: string, locale: "en" | "ar"): boolean {
  return locale === "en"
    ? /temporary technical problem|technical error|something went wrong/i.test(text)
    : /مشكلة تقنية|خطأ تقني|حصل خطأ/.test(text);
}

/** A reply that sends the patient to staff when a tool move was available. */
export function looksLikeEscalation(text: string, locale: "en" | "ar"): boolean {
  return locale === "en"
    ? /contact (the )?clinic|call the clinic|clinic staff will|please call us/i.test(text)
    : /تواصل مع (العيادة|الموظفين)|اتصل بالعيادة|موظفي العيادة سيتواصلون|كلّم العيادة/.test(text);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type VariantMetrics = {
  variantId: string;
  label: string;
  scenarios: number;
  /** Turns that re-asked something the conversation had already settled. */
  repeatedQuestionRate: number;
  /** Conversations that returned to department selection after a doctor. */
  flowRestartRate: number;
  /** "other doctors" scenarios answered with a roster and no department re-ask. */
  otherDoctorsSuccess: number;
  bookingCompletionRate: number;
  medianTurnsToBooking: number | null;
  technicalFallbackRate: number;
  unnecessaryEscalationRate: number;
  /** Bookings attempted on a slot no tool ever offered. Must be zero after the guard. */
  neverOfferedAttempts: number;
  illegalTransitions: number;
  turnFailureRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensPerConversation: number;
  costMicros: number;
  costPerCompletedBookingMicros: number | null;
};

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

export function summarize(
  variant: HarnessVariant,
  scenarios: readonly BookingScenario[],
  runs: readonly ScenarioRun[],
): VariantMetrics {
  const byId = new Map(scenarios.map((item) => [item.id, item]));
  let reAskTurns = 0;
  let reAskEligibleTurns = 0;
  let restarts = 0;
  let otherDoctorsCases = 0;
  let otherDoctorsPassed = 0;
  let fallbackTurns = 0;
  let escalationTurns = 0;
  let failedTurns = 0;
  let totalTurns = 0;
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const bookingTurns: number[] = [];
  let booked = 0;
  // Completion is only meaningful for the scenarios that are *supposed* to end
  // in a booking; a "who else?" scenario that never books is a pass, not a miss.
  let bookedEligible = 0;
  let bookingEligible = 0;
  let neverOffered = 0;
  let illegal = 0;

  for (const run of runs) {
    const scenario = byId.get(run.scenarioId)!;
    neverOffered += run.neverOfferedAttempts;
    illegal += run.illegalTransitions;
    const expectsBooking = scenario.measures.includes("booking_completion");
    if (expectsBooking) bookingEligible += 1;
    if (run.booked) {
      booked += 1;
      if (expectsBooking) bookedEligible += 1;
      if (run.turnsToBooking !== null) bookingTurns.push(run.turnsToBooking);
    }
    let doctorSettled = false;
    for (const turn of run.turns) {
      totalTurns += 1;
      if (turn.failed) failedTurns += 1;
      latencies.push(turn.latencyMs);
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      if (looksLikeTechnicalFallback(turn.text, run.locale)) fallbackTurns += 1;
      // An escalation is "unnecessary" only when the turn had a legitimate tool
      // move available — a stage with workflow tools in it — and took none.
      if (
        looksLikeEscalation(turn.text, run.locale) &&
        turn.toolsCalled.length === 0 &&
        turn.stageAfter !== "escalated"
      ) {
        escalationTurns += 1;
      }
      const banned = scenario.noReAsk?.[turn.index] ?? [];
      if (banned.length > 0) {
        reAskEligibleTurns += 1;
        if (banned.some((topic) => asksAbout(turn.text, topic, run.locale))) {
          reAskTurns += 1;
        }
      }
      if (
        doctorSettled &&
        (turn.stageAfter === "selecting_department" ||
          asksAbout(turn.text, "department", run.locale))
      ) {
        restarts += 1;
        doctorSettled = false;
      }
      if (
        turn.stageAfter === "selecting_day" ||
        turn.stageAfter === "selecting_time" ||
        turn.stageAfter === "confirming"
      ) {
        doctorSettled = true;
      }
    }
    if (scenario.measures.includes("other_doctors")) {
      otherDoctorsCases += 1;
      const followUp = run.turns[1];
      const answered =
        followUp !== undefined &&
        followUp.toolsCalled.some(
          (name) => name === "list_doctors" || name === "prepare_booking",
        ) &&
        !asksAbout(followUp.text, "department", run.locale) &&
        followUp.stageAfter !== "selecting_department";
      if (answered) otherDoctorsPassed += 1;
    }
  }

  const pricing = variant.route.pricing;
  const costMicros =
    (inputTokens * pricing.inputMicrosPerMillion) / 1_000_000 +
    (outputTokens * pricing.outputMicrosPerMillion) / 1_000_000;

  return {
    variantId: variant.id,
    label: variant.label,
    scenarios: runs.length,
    repeatedQuestionRate:
      reAskEligibleTurns === 0 ? 0 : reAskTurns / reAskEligibleTurns,
    flowRestartRate: runs.length === 0 ? 0 : restarts / runs.length,
    otherDoctorsSuccess:
      otherDoctorsCases === 0 ? 1 : otherDoctorsPassed / otherDoctorsCases,
    bookingCompletionRate:
      bookingEligible === 0 ? 0 : bookedEligible / bookingEligible,
    medianTurnsToBooking:
      bookingTurns.length === 0 ? null : percentile(bookingTurns, 0.5),
    technicalFallbackRate: totalTurns === 0 ? 0 : fallbackTurns / totalTurns,
    unnecessaryEscalationRate: totalTurns === 0 ? 0 : escalationTurns / totalTurns,
    neverOfferedAttempts: neverOffered,
    illegalTransitions: illegal,
    turnFailureRate: totalTurns === 0 ? 0 : failedTurns / totalTurns,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    tokensPerConversation:
      runs.length === 0 ? 0 : (inputTokens + outputTokens) / runs.length,
    costMicros,
    costPerCompletedBookingMicros: booked === 0 ? null : costMicros / booked,
  };
}
