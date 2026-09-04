import "server-only";

import type {
  AiPersona,
  AiTaskClass,
  CertifiedModelRoute,
  CertifiedTaskPolicy,
} from "@/lib/ai/platform/types";

/**
 * P4.5A's certification registry is intentionally small. These are the
 * established P4 model tiers, now addressed through stable ClinicFlow aliases.
 * Formal scored ar/en model evaluation remains P6A; the bootstrap approval
 * records the already-shipped P4 behavior and prevents arbitrary model ids.
 */
const MODEL_ROUTES = {
  "staff-sonnet-bootstrap-v1": {
    alias: "staff-sonnet-bootstrap-v1",
    transport: "anthropic_direct",
    provider: "anthropic",
    modelId: "anthropic/claude-sonnet-4.5",
    providerModelId: "claude-sonnet-4-5",
    allowedServingProviders: ["anthropic"],
    capabilities: ["streaming", "tool_calling", "arabic", "english"],
    privacy: {
      gatewayZeroDataRetention: true,
      directProviderRetention: "contractual_only",
      noTrainingRequired: true,
    },
    pricing: {
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000,
      cacheReadMicrosPerMillion: 300_000,
      cacheWriteMicrosPerMillion: 3_750_000,
    },
    certification: {
      status: "bootstrap_approved",
      version: "p4-bootstrap-2026-07-18",
      evaluationSuiteVersion: "p4-deterministic-tool-suite-v1",
      effectiveDate: "2026-07-18",
      rollbackAlias: null,
    },
  },
  /**
   * P4.7A cheap staff route. Same certified Haiku tier as the patient route, but
   * a distinct alias rather than a reuse: the two are separately certifiable and
   * separately rollback-able, and a shared alias would mean a patient-side model
   * change silently retargeted staff help turns (and the reverse). The alias is
   * the unit of certification, so tasks that are not the same task do not share
   * one.
   */
  "staff-haiku-bootstrap-v1": {
    alias: "staff-haiku-bootstrap-v1",
    transport: "anthropic_direct",
    provider: "anthropic",
    modelId: "anthropic/claude-haiku-4.5",
    providerModelId: "claude-haiku-4-5",
    allowedServingProviders: ["anthropic"],
    capabilities: ["streaming", "tool_calling", "arabic", "english"],
    privacy: {
      gatewayZeroDataRetention: true,
      directProviderRetention: "contractual_only",
      noTrainingRequired: true,
    },
    pricing: {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 5_000_000,
      cacheReadMicrosPerMillion: 100_000,
      cacheWriteMicrosPerMillion: 1_250_000,
    },
    certification: {
      status: "bootstrap_approved",
      version: "p47a-bootstrap-2026-07-20",
      evaluationSuiteVersion: "p47a-help-retrieval-suite-v1",
      effectiveDate: "2026-07-20",
      rollbackAlias: "staff-sonnet-bootstrap-v1",
    },
  },
  "patient-haiku-bootstrap-v1": {
    alias: "patient-haiku-bootstrap-v1",
    transport: "anthropic_direct",
    provider: "anthropic",
    modelId: "anthropic/claude-haiku-4.5",
    providerModelId: "claude-haiku-4-5",
    allowedServingProviders: ["anthropic"],
    capabilities: ["streaming", "tool_calling", "arabic", "english"],
    privacy: {
      gatewayZeroDataRetention: true,
      directProviderRetention: "contractual_only",
      noTrainingRequired: true,
    },
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
  },
} as const satisfies Record<string, CertifiedModelRoute>;

/**
 * P12 privacy-policy versions.
 *
 * The `-zdr-` names were retired rather than kept, because on the direct
 * Anthropic transport there is no zero-data-retention request flag to set — the
 * old name described a Vercel Gateway option as if it were a property of the
 * turn. The version string is a ledger label, and the posture it labels actually
 * changed, so it takes a new value. See
 * `docs/reviews/AI_PROVIDER_DIRECT_ANTHROPIC.md` for what is enforced in code
 * and what is contractual.
 */
const STAFF_POLICY_BASE = {
  version: "p45b-staff-provider-policy-v1",
  primaryModelAlias: "staff-sonnet-bootstrap-v1",
  fallbackModelAliases: [],
  allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
  maxInputTokensPerStep: 48_000,
  maxOutputTokens: 1_500,
  maxSteps: 8,
  temperature: 0.2,
  privacyPolicyVersion: "clinical-direct-anthropic-no-training-v2",
} as const;

const TASK_POLICIES = {
  /**
   * The clinical class was the one certified staff route with no step headroom.
   * The study measured its representative task (T2: resolve a patient, read
   * appointments, read prescriptions, optionally read notes, then preview a
   * follow-up) at 5–6 steps against a budget of 8 — so a single clarification
   * or one mis-emitted filter exhausted the turn. 12 restores roughly one
   * recovery cycle of margin and nothing more.
   *
   * Raised **here only**. The administrative (20), operational (20), composite
   * (25) and help (4) classes are unchanged: none of them was measured tight,
   * and a global raise would buy an unproductive model more budget to spend.
   * The two loop guards in `lib/ai/staff-loop-guard.ts` bound what the extra
   * steps can be spent on.
   */
  staff_clinical_summary: {
    ...STAFF_POLICY_BASE,
    version: "p7s-staff-clinical-summary-policy-v2",
    task: "staff_clinical_summary",
    allowedPersonas: ["doctor"],
    maxSteps: 12,
  },
  staff_administrative: {
    ...STAFF_POLICY_BASE,
    version: "phase4-staff-administrative-policy-v2",
    task: "staff_administrative",
    allowedPersonas: ["administrative_staff"],
    maxInputTokensPerStep: 192_000,
    maxSteps: 20,
  },
  /**
   * P4.6A operational query class. Same certified route and privacy policy as
   * the administrative class, with a tighter step and output budget: these
   * answers are typed aggregates and bounded lists, so they need fewer tool
   * round-trips and far less prose than a clinical summary.
   */
  staff_operational_query: {
    ...STAFF_POLICY_BASE,
    version: "phase4-staff-operational-policy-v2",
    task: "staff_operational_query",
    allowedPersonas: ["administrative_staff"],
    maxOutputTokens: 1_200,
    maxInputTokensPerStep: 192_000,
    maxSteps: 20,
  },
  /**
   * P4.7A help/guidance class.
   *
   * Cheap by design: "where do I configure reminders?" must not cost what a
   * clinical summary costs. The budget is small because the work is small — the
   * turn calls at most two tools, neither of which reads clinic data, and the
   * answer is a short set of steps plus a link.
   *
   * Both staff personas are allowed. A doctor asking how to use the app is
   * asking the same question a receptionist is, and routing them to the clinical
   * class for it would burn the clinic's budget on a documentation lookup.
   * Because the mount for this class is help-only, the narrower budget can never
   * strand a clinical turn: a turn that needed patient data would have had to
   * resolve to a different class to reach any tool that returns it.
   */
  staff_help: {
    task: "staff_help",
    version: "p47a-staff-help-policy-v1",
    primaryModelAlias: "staff-haiku-bootstrap-v1",
    fallbackModelAliases: [],
    allowedPersonas: ["doctor", "administrative_staff"],
    allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
    maxInputTokensPerStep: 12_000,
    maxOutputTokens: 700,
    maxSteps: 4,
    temperature: 0.2,
    privacyPolicyVersion: "clinical-direct-anthropic-no-training-v2",
  },
  staff_composite: {
    ...STAFF_POLICY_BASE,
    task: "staff_composite",
    version: "phase4-staff-composite-policy-v2",
    allowedPersonas: ["doctor", "administrative_staff"],
    maxInputTokensPerStep: 192_000,
    maxOutputTokens: 1_500,
    maxSteps: 25,
  },
  patient_booking: {
    task: "patient_booking",
    version: "p5a-patient-booking-policy-v1",
    primaryModelAlias: "patient-haiku-bootstrap-v1",
    fallbackModelAliases: [],
    allowedPersonas: ["patient"],
    allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
    maxInputTokensPerStep: 16_000,
    maxOutputTokens: 800,
    maxSteps: 6,
    temperature: 0.2,
    privacyPolicyVersion: "patient-direct-anthropic-no-training-v2",
  },
  patient_faq: {
    task: "patient_faq",
    version: "p5a-patient-faq-policy-v1",
    primaryModelAlias: "patient-haiku-bootstrap-v1",
    fallbackModelAliases: [],
    allowedPersonas: ["patient"],
    allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
    maxInputTokensPerStep: 12_000,
    maxOutputTokens: 600,
    maxSteps: 4,
    temperature: 0.2,
    privacyPolicyVersion: "patient-direct-anthropic-no-training-v2",
  },
} as const satisfies Record<AiTaskClass, CertifiedTaskPolicy>;

const LEGACY_CERTIFIED_MODEL_IDS: Record<string, keyof typeof MODEL_ROUTES> = {
  "claude-sonnet-4-5": "staff-sonnet-bootstrap-v1",
  "anthropic/claude-sonnet-4.5": "staff-sonnet-bootstrap-v1",
  "claude-haiku-4-5": "patient-haiku-bootstrap-v1",
  "anthropic/claude-haiku-4.5": "patient-haiku-bootstrap-v1",
};

export class AiPolicyRegistryError extends Error {
  constructor(public readonly reason: "task_not_allowed" | "model_not_certified") {
    super(reason);
    this.name = "AiPolicyRegistryError";
  }
}

export function getTaskPolicy(task: AiTaskClass, persona: AiPersona): CertifiedTaskPolicy {
  const policy = TASK_POLICIES[task];
  if (!(policy.allowedPersonas as readonly AiPersona[]).includes(persona)) {
    throw new AiPolicyRegistryError("task_not_allowed");
  }
  return policy;
}

export function getCertifiedModelRoute(
  policy: CertifiedTaskPolicy,
): CertifiedModelRoute {
  // `staff_help` honors neither override. The two env vars exist to preserve
  // pre-P4.5 deployments' pinned model choices for surfaces that existed then;
  // the help class did not, so there is no legacy behavior to preserve — and
  // letting AI_MODEL_DOCTOR retarget it would silently move the cheapest class
  // in the system onto the most expensive route, which is the opposite of the
  // reason it exists.
  const legacyOverride =
    policy.task === "staff_help"
      ? undefined
      : policy.task === "staff_clinical_summary" ||
          policy.task === "staff_administrative" ||
          policy.task === "staff_operational_query" ||
          policy.task === "staff_composite"
        ? process.env.AI_MODEL_DOCTOR?.trim()
        : process.env.AI_MODEL_PATIENT?.trim();
  const alias = legacyOverride
    ? LEGACY_CERTIFIED_MODEL_IDS[legacyOverride]
    : policy.primaryModelAlias;
  if (!alias || !(alias in MODEL_ROUTES)) {
    throw new AiPolicyRegistryError("model_not_certified");
  }
  const route = MODEL_ROUTES[alias as keyof typeof MODEL_ROUTES];
  for (const fallbackAlias of policy.fallbackModelAliases) {
    if (!(fallbackAlias in MODEL_ROUTES)) {
      throw new AiPolicyRegistryError("model_not_certified");
    }
  }
  return route;
}

export function listCertifiedModelRoutes(): readonly CertifiedModelRoute[] {
  return Object.values(MODEL_ROUTES);
}
