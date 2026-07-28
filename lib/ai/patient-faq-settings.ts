import "server-only";

import {
  createClinicScopedAdminClient,
  getClinicAiReplyContext,
} from "@/lib/supabase/admin";
import {
  getEntitlements,
  hasFeature,
} from "@/lib/entitlements";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import { AI_PATIENT_SUGGEST_FEATURE } from "@/lib/ai/patient-authorization";
import { AI_PATIENT_AUTO_FEATURE } from "@/lib/ai/patient-reply-mode";
import { normalizeClinicAiReplyMode, type ClinicAiReplyMode } from "@/lib/ai/patient-reply-mode";

export type PatientFaqItem = {
  id: string;
  question: string;
  answer: string;
  language: "ar" | "en";
  isActive: boolean;
  sortOrder: number;
};

export type PatientAiSettings = {
  entitled: boolean;
  autoEntitled: boolean;
  replyMode: ClinicAiReplyMode;
  faqs: PatientFaqItem[];
  error: boolean;
};

/**
 * Loads the Patient AI settings surface (§P5B): the per-clinic reply mode plus
 * the clinic-authored FAQ content the patient agent answers from. Reads run on
 * the clinic-scoped admin client (FAQ has authenticated read but writes are
 * service-role, matching the templates model).
 */
export async function getPatientAiSettings(clinicId: string): Promise<PatientAiSettings> {
  const entitlements = await getEntitlements(clinicId);
  const entitled =
    hasFeature(entitlements, AI_ASSISTANT_FEATURE) &&
    hasFeature(entitlements, AI_PATIENT_SUGGEST_FEATURE);
  const autoEntitled = hasFeature(entitlements, AI_PATIENT_AUTO_FEATURE);

  const client = createClinicScopedAdminClient(clinicId);
  const [clinicResult, faqResult] = await Promise.all([
    getClinicAiReplyContext(clinicId),
    client
      .from("clinic_faq")
      .select("id, question, answer, language, is_active, sort_order")
      .order("sort_order", { ascending: true })
      .order("question", { ascending: true }),
  ]);
  if (clinicResult.error || faqResult.error) {
    return { entitled, autoEntitled, replyMode: "off", faqs: [], error: true };
  }

  return {
    entitled,
    autoEntitled,
    replyMode: normalizeClinicAiReplyMode(clinicResult.data?.ai_reply_mode),
    faqs: (faqResult.data ?? []).map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      language: row.language === "ar" ? "ar" : "en",
      isActive: row.is_active,
      sortOrder: row.sort_order,
    })),
    error: false,
  };
}
