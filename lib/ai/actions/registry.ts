import "server-only";

import { z } from "zod";
import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import { LEGACY_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/legacy-actions";
import { FOLLOWUP_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/followups";
import { APPOINTMENT_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/appointments";
import { PATIENT_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/patients";
import { CLINICAL_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/clinical";
import { BILLING_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/billing";
import { SETTINGS_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/settings";
import { PRIVILEGED_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/privileged";
import { DOCUMENT_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/documents";

const referenceInputSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
  })
  .strict();

/**
 * Phase 3's deliberately harmless reference action. Its only durable mutation
 * is the confirmation/receipt control-plane state created by the generic
 * executor. It does not touch a patient, appointment, message, setting, or any
 * other domain row; domain write parity begins in Phase 5.
 */
const referenceAction: ActionDefinition = {
  id: "assistant.reference_check",
  roles: ["admin"],
  requiredFeatures: ["ai.write_administration"],
  risk: "normal",
  inputSchema: referenceInputSchema,
  labels: {
    en: "Assistant action safety check",
    ar: "فحص أمان إجراءات المساعد",
  },
  description: {
    en: "Prove the preview, human confirmation, single-use token, re-authorization, and receipt pipeline without changing clinic domain data.",
    ar: "إثبات مسار المعاينة والتأكيد البشري والرمز أحادي الاستخدام وإعادة التحقق والإيصال دون تغيير بيانات العيادة التشغيلية.",
  },
  inputDescription: {
    en: "A short label identifying this harmless reference check.",
    ar: "تسمية قصيرة تحدد فحص البنية الآمن هذا.",
  },
  async preview(_user, rawInput) {
    const input = referenceInputSchema.parse(rawInput);
    return {
      title: "Assistant action safety check",
      summary: "This confirms the Phase 3 action pipeline only. No clinic record will be changed.",
      changes: [{ label: "Reference label", before: null, after: input.label }],
      audit: {
        targetTable: "ai_action_confirmations",
        before: { completed: false },
        after: { completed: true },
      },
    };
  },
  async execute(_user, rawInput, context) {
    const input = referenceInputSchema.parse(rawInput);
    return {
      summary: "The assistant action safety check completed. No clinic record was changed.",
      data: {
        label: input.label,
        idempotency_key: context.idempotencyKey,
      },
      audit: {
        targetTable: "ai_action_confirmations",
        before: { completed: false },
        after: { completed: true },
      },
    };
  },
};

export const AI_ACTION_REGISTRY: readonly RegisteredActionDefinition[] = [
  registerActionDefinition(referenceAction),
  ...LEGACY_ACTION_DEFINITIONS,
  ...APPOINTMENT_ACTION_DEFINITIONS,
  ...FOLLOWUP_ACTION_DEFINITIONS,
  ...PATIENT_ACTION_DEFINITIONS,
  ...CLINICAL_ACTION_DEFINITIONS,
  ...BILLING_ACTION_DEFINITIONS,
  ...SETTINGS_ACTION_DEFINITIONS,
  ...DOCUMENT_ACTION_DEFINITIONS,
  ...PRIVILEGED_ACTION_DEFINITIONS,
];

export const AI_ACTION_REGISTRY_BY_ID: ReadonlyMap<
  string,
  RegisteredActionDefinition
> = new Map(AI_ACTION_REGISTRY.map((definition) => [definition.id, definition]));

export function registeredAction(
  actionId: string,
): RegisteredActionDefinition | null {
  return AI_ACTION_REGISTRY_BY_ID.get(actionId) ?? null;
}
