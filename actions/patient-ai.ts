"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationRole } from "@/lib/rbac";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import { AI_PATIENT_SUGGEST_FEATURE } from "@/lib/ai/patient-authorization";
import { AI_PATIENT_AUTO_FEATURE } from "@/lib/ai/patient-reply-mode";
import {
  createClinicScopedAdminClient,
  setClinicAiReplyMode,
} from "@/lib/supabase/admin";

export type PatientAiActionResult = { success?: boolean; error?: string };

async function patientAiError(key: Parameters<typeof actionError>[0]) {
  return { error: await actionError(key) };
}

const replyModeSchema = z.object({
  mode: z.enum(["off", "suggest", "auto"]),
});

const faqSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(4000),
  language: z.enum(["ar", "en"]),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

/**
 * P5B (§6.2): set the per-clinic patient AI reply mode. `auto` is refused
 * unless the clinic carries the `ai.patient_auto` entitlement — the toggle can
 * never turn on automatic replies on its own (the same gate the orchestrator
 * enforces at runtime).
 */
export async function setPatientAiReplyMode(input: {
  mode: "off" | "suggest" | "auto";
}): Promise<PatientAiActionResult> {
  const user = await requireMutationRole("admin");
  const parsed = replyModeSchema.safeParse(input);
  if (!parsed.success) return patientAiError("settings.patientAiInvalidMode");

  const entitlements = await getEntitlements(user.clinicId);
  if (
    !hasFeature(entitlements, AI_ASSISTANT_FEATURE) ||
    !hasFeature(entitlements, AI_PATIENT_SUGGEST_FEATURE)
  ) {
    return patientAiError("settings.patientAiNotEntitled");
  }
  if (parsed.data.mode === "auto" && !hasFeature(entitlements, AI_PATIENT_AUTO_FEATURE)) {
    return patientAiError("settings.patientAiAutoNotEntitled");
  }

  const updated = await setClinicAiReplyMode(user.clinicId, parsed.data.mode);
  if (updated.error || !updated.data) {
    return patientAiError("settings.patientAiCouldNotSaveMode");
  }
  revalidatePath("/settings/patient-ai");
  return { success: true };
}

/** P5B: create or update a clinic-authored FAQ entry the patient agent answers from. */
export async function savePatientFaq(input: {
  id?: string | null;
  question: string;
  answer: string;
  language: "ar" | "en";
  isActive?: boolean;
  sortOrder?: number;
}): Promise<PatientAiActionResult> {
  const user = await requireMutationRole("admin");
  const parsed = faqSchema.safeParse(input);
  if (!parsed.success) return patientAiError("settings.patientAiInvalidFaq");

  const client = createClinicScopedAdminClient(user.clinicId);
  const values = {
    question: parsed.data.question,
    answer: parsed.data.answer,
    language: parsed.data.language,
    is_active: parsed.data.isActive ?? true,
    sort_order: parsed.data.sortOrder ?? 0,
  };
  if (parsed.data.id) {
    const updated = await client
      .from("clinic_faq")
      .update(values)
      .eq("id", parsed.data.id)
      .select("id")
      .maybeSingle();
    if (updated.error) {
      return patientAiError(
        updated.error.code === "23505"
          ? "settings.patientAiFaqDuplicate"
          : "settings.patientAiCouldNotSaveFaq",
      );
    }
    if (!updated.data) return patientAiError("settings.patientAiFaqNotFound");
  } else {
    const inserted = await client
      .from("clinic_faq")
      .insert({ clinic_id: user.clinicId, ...values });
    if (inserted.error) {
      return patientAiError(
        inserted.error.code === "23505"
          ? "settings.patientAiFaqDuplicate"
          : "settings.patientAiCouldNotSaveFaq",
      );
    }
  }
  revalidatePath("/settings/patient-ai");
  return { success: true };
}

export async function deletePatientFaq(input: {
  id: string;
}): Promise<PatientAiActionResult> {
  const user = await requireMutationRole("admin");
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return patientAiError("settings.patientAiInvalidFaq");
  const client = createClinicScopedAdminClient(user.clinicId);
  const deleted = await client
    .from("clinic_faq")
    .delete()
    .eq("id", parsed.data.id)
    .select("id")
    .maybeSingle();
  if (deleted.error || !deleted.data) {
    return patientAiError("settings.patientAiFaqNotFound");
  }
  revalidatePath("/settings/patient-ai");
  return { success: true };
}
