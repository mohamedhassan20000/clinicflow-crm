/**
 * F-12 — what a failed live case has to persist for somebody to fix it.
 *
 * ## The defect this exists for
 *
 * The managed live acceptance artifact recorded six failures like this:
 *
 * ```json
 * { "caseId": "doctors-roster#p1", "category": "doctors",
 *   "critical": [{ "id": "reply_must_not",
 *                  "detail": "a reply matched a forbidden pattern /أنهي قسم|which department/i" }] }
 * ```
 *
 * That is a *verdict*, not a diagnosis. It says a reply asked about a
 * department and nothing about which turn asked it, what the patient had said,
 * what the server had decided, which tool ran, or with what arguments. Every
 * root cause below had to be reconstructed by reading the pipeline and
 * reasoning backwards from a state-progression string — and one of the six
 * ("the model invented a department argument") is not derivable from the
 * artifact at all. A billable run that has to be repeated to be understood has
 * been paid for twice.
 *
 * ## What this records, and the reason it is safe to record it
 *
 * Everything here is **synthetic by construction**:
 *
 *   * the patient turns are `ACCEPTANCE_SCENARIOS`' own scripted strings,
 *     checked into this repository;
 *   * the clinic, doctors, departments, days, slots, prices, appointments and
 *     the one patient are `fixture-clinic.ts`, likewise checked in;
 *   * the tool arguments are the model's arguments *against that fixture*;
 *   * the gate and authority values are labels from closed sets.
 *
 * No clinic is read, no patient is read, no stored credential is read. The
 * lane's provider module already guarantees this and states why.
 *
 * ## What this must never become
 *
 * **This is not production logging and must never be wired into one.**
 * `logAgentTool` stays content-free: outcomes, labels and counts, never a
 * value, an argument or a reply. The reason those two rules can differ is that
 * one of them is about a patient and the other is about a fixture. A module
 * that blurred them would have taken a privacy guarantee and traded it for a
 * debugging convenience.
 *
 * The guard below is the mechanical half of that promise: the diagnostics
 * builder refuses to run against a scenario whose patient is not one of the
 * three synthetic fixtures the suite defines. It cannot be pointed at a real
 * conversation even by mistake.
 */

import type { CaseResult } from "@/lib/ai/acceptance/graders";
import type { ConversationRecord } from "@/lib/ai/acceptance/runner";
import {
  LINKED_UNCONFIRMED,
  LINKED_VERIFIED,
  STRANGER,
  type SimulatedPatient,
} from "@/lib/ai/acceptance/simulator";
import type { Scenario } from "@/lib/ai/acceptance/scenarios";

/** The only patients this suite may ever run against. */
const SYNTHETIC_PATIENTS: readonly SimulatedPatient[] = [
  STRANGER,
  LINKED_UNCONFIRMED,
  LINKED_VERIFIED,
];

export class NonSyntheticDiagnosticsError extends Error {
  constructor(caseId: string) {
    super(
      `Refusing to build acceptance diagnostics for "${caseId}": its patient is not one of the ` +
        "synthetic fixtures. These diagnostics persist message text and tool arguments and are " +
        "valid only for fixture data.",
    );
    this.name = "NonSyntheticDiagnosticsError";
  }
}

/**
 * A fixture patient, structurally.
 *
 * Compared by shape rather than by reference so a scenario that spreads a
 * fixture to add `humanTakeover` still qualifies, while anything carrying a
 * real identifier does not.
 */
function isSyntheticPatient(patient: SimulatedPatient): boolean {
  if (typeof patient !== "object" || patient === null) return false;
  const allowedKeys = new Set([
    "linked",
    "identityVerified",
    "bookingIdentityConfirmed",
    "treatingDoctorId",
    "humanTakeover",
  ]);
  for (const key of Object.keys(patient)) {
    if (!allowedKeys.has(key)) return false;
  }
  return SYNTHETIC_PATIENTS.some(
    (fixture) =>
      fixture.linked === patient.linked &&
      fixture.identityVerified === patient.identityVerified &&
      fixture.bookingIdentityConfirmed === patient.bookingIdentityConfirmed,
  );
}

/**
 * F-15 — the credential scrubber every diagnostic value passes through.
 *
 * ## Why a synthetic-fixture guard is not enough on its own
 *
 * `isSyntheticPatient` proves the *scenario* is synthetic. It says nothing
 * about the *strings*, and the strings are the half that reaches the committed
 * artifact. Two of the fields persisted below are model output rather than
 * fixture data — `toolCalls[].input` and `writes[].args` are whatever arguments
 * the model chose, and `assistant` is whatever sentence it produced — so a
 * model that echoed a credential-shaped token into a free-text argument would
 * put it in `docs/reviews/artifacts/`, which is a tracked file.
 *
 * That is not a hypothetical shaped like a leak; it is the ordinary way secrets
 * escape: a value that was never *stored* anywhere sensitive gets copied into a
 * debugging record that is, unlike a log, committed.
 *
 * ## The two rules, in order
 *
 * 1. **Exact env-value redaction.** Every environment variable whose *name*
 *    looks like a credential contributes its *value* as a literal to redact.
 *    This is the rule that actually discharges "a managed API key can never
 *    appear": it does not depend on the key matching a shape, so a rotated key,
 *    a differently-prefixed key, or a provider that changes its format is
 *    covered by construction rather than by a pattern being kept up to date.
 *
 * 2. **Shape redaction.** Credential-shaped literals (`sk-ant-…`, bearer
 *    tokens, JWTs, `api_key=…` pairs) are redacted even when no environment
 *    variable holds them, which covers a secret the model invented or a
 *    credential belonging to a process this one cannot see.
 *
 * ## What it deliberately does NOT touch
 *
 * The scripted patient turns, the Arabic and English reply text, the fixture
 * doctor and department names, the tool names, the gate labels and the grader's
 * failure detail all survive verbatim — none of them can match a credential
 * shape, and redacting them would defeat the reason the record exists. The
 * scrubber is a filter on secrets, not a general minimizer: `redact.ts` handles
 * PHI minimization for the *audit* trail, where the subject is a real patient.
 * Here the subject is a fixture, so identifiers are exactly what a reader needs.
 */
export const DIAGNOSTIC_REDACTION = "[redacted-secret]" as const;

/** Env var names that hold a secret, by convention. */
const SECRET_ENV_NAME_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|CONNECTION_STRING)/i;

/** The shortest env value worth treating as a secret; below this it is noise. */
const MIN_SECRET_VALUE_LENGTH = 8;

/** Credential-shaped literals, redacted regardless of the environment. */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  // Anthropic, managed and BYOK alike, plus admin/OAuth variants.
  /sk-ant-[A-Za-z0-9_-]{8,}/gi,
  // Other providers' key shapes.
  /\bsk-[A-Za-z0-9_-]{16,}/gi,
  // JWTs, including Supabase service-role keys.
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
  // Authorization headers copied verbatim.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
  // `api_key: "…"`, `token=…`, `secret => …` and friends.
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password)[A-Za-z0-9_-]*\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}={0,2}["']?/gi,
];

/**
 * The literal secret values to redact, read from the environment.
 *
 * Read at call time rather than at module load: a test that sets a key in
 * `beforeEach` must be protected by the same code path production uses, and a
 * module-load snapshot would silently miss it.
 */
export function secretLiteralsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const literals: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (!SECRET_ENV_NAME_RE.test(name)) continue;
    literals.push(trimmed);
  }
  // Longest first, so a key that contains a shorter key is redacted whole.
  return literals.sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts credential literals and credential shapes from one string. */
export function scrubSecrets(
  input: string,
  literals: readonly string[] = secretLiteralsFromEnv(),
): string {
  if (!input) return input;
  let output = input;
  for (const literal of literals) {
    output = output.replace(new RegExp(escapeRegExp(literal), "g"), DIAGNOSTIC_REDACTION);
  }
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    output = output.replace(pattern, DIAGNOSTIC_REDACTION);
  }
  return output;
}

/**
 * Applies `scrubSecrets` to every string anywhere in a value.
 *
 * Structure-preserving: keys, numbers, booleans, nulls, array order and object
 * shape are untouched, so a scrubbed tool argument is still readable as the
 * argument the model sent. Object KEYS are scrubbed too — a model that put a
 * secret in a key rather than a value would otherwise slip through.
 */
export function scrubDeep<T>(value: T, literals: readonly string[] = secretLiteralsFromEnv()): T {
  if (typeof value === "string") return scrubSecrets(value, literals) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, literals)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[scrubSecrets(key, literals)] = scrubDeep(item, literals);
    }
    return output as unknown as T;
  }
  return value;
}

export type TurnDiagnostic = {
  index: number;
  /** The scripted message the scenario sent. */
  patient: string;
  /** The sentence the patient would actually have received. */
  assistant: string;
  /** The ladder rung the turn opened on, and the one it needs next. */
  step: { before: string; after: string };
  stage: { before: string; after: string };
  /** The server's own decision about what this turn needed. */
  authority: {
    requirement: string;
    operation: string | null;
    reason: string;
    satisfied: boolean;
  } | null;
  /** What the deterministic pre-commit read out of the message. */
  precommit: string;
  /** Tools the stage table left callable. */
  activeTools: readonly string[];
  /** Tools the model asked for. */
  requestedTools: readonly string[];
  /** Tools that ran, with the arguments they ran with, and their outcome. */
  toolCalls: readonly { tool: string; input: Record<string, unknown>; outcome: string }[];
  /** Every reply gate that changed the sentence, in order. */
  gates: readonly string[];
  lifecycle: string;
  writeOutcome: string;
  episodeClosed: boolean;
  /** True when the provider call itself failed. */
  failed: boolean;
};

export type CaseDiagnostic = {
  caseId: string;
  scenarioId: string;
  category: string;
  register: string;
  locale: string;
  paraphraseIndex: number;
  /** The scenario's one-line statement of what it is testing. */
  intent: string;
  /** Which grader checks failed, and why, verbatim. */
  failures: readonly { id: string; critical: boolean; detail: string }[];
  /** What the scenario declared it expected, so the verdict reads on its own. */
  expected: {
    steps: readonly string[];
    tools: readonly string[];
    forbiddenTools: readonly string[];
    writes: readonly string[];
    forbiddenWrites: readonly string[];
    replyMust: readonly string[];
    replyMustNot: readonly string[];
  };
  /** The state the conversation actually reached. */
  finalState: {
    stage: string;
    step: string;
    submitted: boolean;
    intakeStaged: boolean;
    escalated: boolean;
    bookingForOther: boolean;
    collected: Record<string, string | number>;
    offeredDoctorIds: readonly string[];
    offeredDays: readonly string[];
    offeredSlots: readonly string[];
    episodes: number;
  };
  /** Every write the server was asked for, committed or refused, with its reason. */
  writes: readonly {
    operation: string;
    committed: boolean;
    reason: string;
    args: Record<string, unknown>;
  }[];
  /** Deterministic gate decisions that refused something this run. */
  deterministicRefusals: {
    /** Intake writes refused because the patient never supplied the values. */
    fabricatedIntakeAttempts: number;
    /** Entity arguments discarded because the patient never uttered them. */
    unsourcedArgumentDiscards: number;
    /** Slot bookings refused because the server never offered the slot. */
    neverOfferedSlotAttempts: number;
  };
  turns: readonly TurnDiagnostic[];
};

/**
 * The diagnostic record for one case.
 *
 * Built for failures only by the live lane — a passing case needs no autopsy,
 * and 109 full transcripts would bury the six that matter.
 */
export function buildCaseDiagnostic(input: {
  scenario: Scenario;
  run: ConversationRecord;
  result: CaseResult;
}): CaseDiagnostic {
  const { scenario, run, result } = input;
  if (!isSyntheticPatient(scenario.patient)) {
    throw new NonSyntheticDiagnosticsError(result.caseId);
  }
  const sim = run.simulator;
  const lastTurn = run.turns[run.turns.length - 1] ?? null;
  // F-15 — every string below passes through the scrubber on the way out.
  // Applied to the whole record at the single return rather than field by
  // field, so a field added later is covered without anyone remembering to
  // cover it. See `scrubDeep` for what it does and does not touch.
  const literals = secretLiteralsFromEnv();

  return scrubDeep({
    caseId: result.caseId,
    scenarioId: result.scenarioId,
    category: result.category,
    register: result.register,
    locale: scenario.locale,
    paraphraseIndex: result.paraphraseIndex,
    intent: scenario.intent,
    failures: result.checks
      .filter((check) => !check.passed)
      .map((check) => ({ id: check.id, critical: check.critical, detail: check.detail })),
    expected: {
      steps: scenario.expectedSteps ?? [],
      tools: scenario.expectedTools ?? [],
      forbiddenTools: scenario.forbiddenTools ?? [],
      writes: scenario.expectedWrites ?? [],
      forbiddenWrites: scenario.forbiddenWrites ?? [],
      replyMust: (scenario.replyMust ?? []).map(String),
      replyMustNot: (scenario.replyMustNot ?? []).map(String),
    },
    finalState: {
      stage: sim.stage,
      step: lastTurn?.step ?? "department",
      submitted: sim.submitted,
      intakeStaged: sim.intakeStaged,
      escalated: sim.escalated,
      bookingForOther: sim.bookingForOther,
      collected: { ...sim.collected } as Record<string, string | number>,
      offeredDoctorIds: [...sim.stageState.offeredDoctorIds],
      offeredDays: [...sim.stageState.offeredDays],
      offeredSlots: [...sim.stageState.offeredSlots],
      episodes: run.episodes,
    },
    writes: sim.writes.map((write) => ({
      operation: write.operation,
      committed: write.committed,
      reason: write.reason,
      args: write.args,
    })),
    deterministicRefusals: {
      fabricatedIntakeAttempts: sim.fabricatedIntakeAttempts,
      unsourcedArgumentDiscards: sim.unsourcedArgumentDiscards,
      neverOfferedSlotAttempts: sim.neverOfferedAttempts,
    },
    turns: run.turns.map((turn) => ({
      index: turn.index,
      patient: turn.patientText,
      assistant: turn.replyText,
      step: { before: turn.stepBefore, after: turn.step },
      stage: { before: turn.stageBefore, after: turn.stageAfter },
      authority: turn.authority
        ? {
            requirement: turn.authority.requirement,
            operation: turn.authority.operation,
            reason: turn.authority.reason,
            satisfied: turn.authority.satisfied,
          }
        : null,
      precommit: turn.precommit,
      activeTools: [...turn.activeTools],
      requestedTools: [...turn.requestedTools],
      toolCalls: turn.toolCalls.map((call) => ({ ...call })),
      gates: [...turn.gates],
      lifecycle: turn.lifecycle,
      writeOutcome: turn.writeOutcome,
      episodeClosed: turn.episodeClosed,
      failed: turn.failed,
    })),
  }, literals);
}
