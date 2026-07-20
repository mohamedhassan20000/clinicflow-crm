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
    transport: "vercel_ai_gateway",
    provider: "anthropic",
    modelId: "anthropic/claude-sonnet-4.5",
    providerModelId: "claude-sonnet-4-5",
    allowedServingProviders: ["anthropic"],
    capabilities: ["streaming", "tool_calling", "arabic", "english"],
    privacy: {
      zeroDataRetentionRequired: true,
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
  "patient-haiku-bootstrap-v1": {
    alias: "patient-haiku-bootstrap-v1",
    transport: "vercel_ai_gateway",
    provider: "anthropic",
    modelId: "anthropic/claude-haiku-4.5",
    providerModelId: "claude-haiku-4-5",
    allowedServingProviders: ["anthropic"],
    capabilities: ["streaming", "tool_calling", "arabic", "english"],
    privacy: {
      zeroDataRetentionRequired: true,
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

const STAFF_POLICY_BASE = {
  version: "p45b-staff-provider-policy-v1",
  primaryModelAlias: "staff-sonnet-bootstrap-v1",
  fallbackModelAliases: [],
  allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
  maxInputTokensPerStep: 48_000,
  maxOutputTokens: 1_500,
  maxSteps: 8,
  temperature: 0.2,
  privacyPolicyVersion: "clinical-zdr-no-training-v1",
} as const;

const TASK_POLICIES = {
  staff_clinical_summary: {
    ...STAFF_POLICY_BASE,
    task: "staff_clinical_summary",
    allowedPersonas: ["doctor"],
  },
  staff_administrative: {
    ...STAFF_POLICY_BASE,
    task: "staff_administrative",
    allowedPersonas: ["administrative_staff"],
  },
  /**
   * P4.6A operational query class. Same certified route and privacy policy as
   * the administrative class, with a tighter step and output budget: these
   * answers are typed aggregates and bounded lists, so they need fewer tool
   * round-trips and far less prose than a clinical summary.
   */
  staff_operational_query: {
    ...STAFF_POLICY_BASE,
    version: "p46a-staff-operational-policy-v1",
    task: "staff_operational_query",
    allowedPersonas: ["administrative_staff"],
    maxOutputTokens: 1_200,
    maxSteps: 6,
  },
  patient_booking: {
    task: "patient_booking",
    version: "p45b-patient-policy-reserved-v1",
    primaryModelAlias: "patient-haiku-bootstrap-v1",
    fallbackModelAliases: [],
    allowedPersonas: ["patient"],
    allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
    maxInputTokensPerStep: 16_000,
    maxOutputTokens: 800,
    maxSteps: 6,
    temperature: 0.2,
    privacyPolicyVersion: "patient-zdr-no-training-v1",
  },
  patient_faq: {
    task: "patient_faq",
    version: "p45b-patient-policy-reserved-v1",
    primaryModelAlias: "patient-haiku-bootstrap-v1",
    fallbackModelAliases: [],
    allowedPersonas: ["patient"],
    allowedCredentialModes: ["managed", "byok_strict", "hybrid"],
    maxInputTokensPerStep: 12_000,
    maxOutputTokens: 600,
    maxSteps: 4,
    temperature: 0.2,
    privacyPolicyVersion: "patient-zdr-no-training-v1",
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
  const legacyOverride =
    policy.task === "staff_clinical_summary" ||
    policy.task === "staff_administrative" ||
    policy.task === "staff_operational_query"
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
