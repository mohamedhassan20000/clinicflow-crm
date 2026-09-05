"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { localizeZodFieldErrors } from "@/lib/validations/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import {
  issueClinicInvitation,
  revokeClinicInvitation,
  type PublicActionResult,
} from "@/actions/early-access";
import { manualBillingProvider } from "@/lib/billing/manual";
import { couponExpiryFromInput, extendedSubscriptionPeriod, manualGrantPeriod } from "@/lib/operator";
import { requirePlatformAdmin } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { logOperatorAction } from "@/lib/platform-audit";
import { DEFAULT_FROM, getResend } from "@/lib/email/resend";
import { isAiFeatureKey, isKnownAiFeature } from "@/lib/ai/commercial-policy";

export type OperatorActionResult = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

function invalidateEntitlements(clinicId: string) {
  revalidateTag(`entitlements:${clinicId}`, { expire: 0 });
}

// ── Platform settings (§3.2 — effective immediately, no deploy) ─────────────

const settingsSchema = z.object({
  registrationMode: z.enum(["invite_only", "open"]),
  weeklyInviteLimit: z.coerce.number().int().min(1).max(1000),
  invitationExpiryDays: z.coerce.number().int().min(1).max(90),
});

export async function updatePlatformSettings(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = settingsSchema.safeParse({
    registrationMode: formData.get("registrationMode"),
    weeklyInviteLimit: formData.get("weeklyInviteLimit"),
    invitationExpiryDays: formData.get("invitationExpiryDays"),
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase
    .from("platform_settings")
    .update({
      registration_mode: parsed.data.registrationMode,
      weekly_invite_limit: parsed.data.weeklyInviteLimit,
      invitation_expiry_days: parsed.data.invitationExpiryDays,
      updated_by: admin.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);
  if (error) return { error: await actionError("operator.settingsCouldNotBeSaved") };
  await logOperatorAction({ action: "platform_settings.updated", targetType: "platform_settings", targetId: "global", payload: parsed.data });
  revalidatePath("/operator", "layout");
  return { ok: true };
}

// ── Manual subscription grants / cancellation (§3.3 manual provider) ────────

const grantSchema = z.object({
  clinicId: z.string().uuid(),
  planSlug: z.enum(["basic", "pro", "pro_ai"]),
  months: z
    .union([z.literal("unbounded"), z.coerce.number().int().min(1).max(60)])
    .transform((value) => (value === "unbounded" ? null : value)),
});

export async function grantManualSubscription(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = grantSchema.safeParse({
    clinicId: formData.get("clinicId"),
    planSlug: formData.get("planSlug"),
    months: formData.get("months"),
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const [plan, subscription] = await Promise.all([
    supabase.from("plans").select("id").eq("slug", parsed.data.planSlug).eq("is_active", true).single(),
    supabase
      .from("subscriptions")
      .select("id, current_period_end")
      .eq("clinic_id", parsed.data.clinicId)
      .maybeSingle(),
  ]);
  if (plan.error) return { error: await actionError("operator.planNotFound") };
  if (subscription.error || !subscription.data) {
    return { error: await actionError("operator.theClinicHasNoSubscriptionRowToGrantAgainst") };
  }

  const period = manualGrantPeriod(parsed.data.months, subscription.data.current_period_end);
  const { error } = await supabase
    .from("subscriptions")
    .update({
      plan_id: plan.data.id,
      provider: "manual",
      status: "active",
      trial_ends_at: null,
      ...period,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscription.data.id);
  if (error) return { error: await actionError("operator.subscriptionGrantFailed") };
  await logOperatorAction({ action: "subscription.granted", targetType: "subscription", targetId: subscription.data.id, clinicId: parsed.data.clinicId, payload: { planSlug: parsed.data.planSlug, months: parsed.data.months } });

  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

export async function cancelManualSubscription(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const clinicId = z.string().uuid().safeParse(formData.get("clinicId"));
  if (!clinicId.success) return { error: await actionError("operator.invalidClinic") };

  const supabase = await createClient();
  const { data: subscription, error: lookupError } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("clinic_id", clinicId.data)
    .maybeSingle();
  if (lookupError || !subscription) return { error: await actionError("operator.theClinicHasNoSubscriptionRow") };

  const patch = await manualBillingProvider.cancelSubscription(subscription);
  const { error } = await supabase
    .from("subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", subscription.id);
  if (error) return { error: await actionError("operator.cancellationFailed") };
  await logOperatorAction({ action: "subscription.cancelled", targetType: "subscription", targetId: subscription.id, clinicId: clinicId.data });

  invalidateEntitlements(clinicId.data);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

// ── Per-clinic feature-flag overrides (§3.4) ────────────────────────────────

const overrideSchema = z.object({
  clinicId: z.string().uuid(),
  featureKey: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.:-]+$/i, "validation.featureKeyFormat"),
  enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export async function upsertFeatureOverride(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = overrideSchema.safeParse({
    clinicId: formData.get("clinicId"),
    featureKey: formData.get("featureKey"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  if (isAiFeatureKey(parsed.data.featureKey)) {
    if (!isKnownAiFeature(parsed.data.featureKey)) {
      return { error: await actionError("operator.aiFeatureOverrideInvalid") };
    }
  }
  const { error } = await supabase.from("clinic_feature_overrides").upsert(
    {
      clinic_id: parsed.data.clinicId,
      feature_key: parsed.data.featureKey,
      enabled: parsed.data.enabled,
    },
    { onConflict: "clinic_id,feature_key" },
  );
  if (error) return { error: await actionError("operator.overrideCouldNotBeSaved") };
  await logOperatorAction({ action: "feature_override.upserted", targetType: "clinic_feature_override", targetId: parsed.data.featureKey, clinicId: parsed.data.clinicId, payload: { enabled: parsed.data.enabled } });

  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

// ── AI commercial terms (§P4.5C — manual billing remains authoritative) ────

const usdAmountSchema = z
  .union([z.literal(""), z.coerce.number().positive().max(1_000_000)])
  .transform((value) => (value === "" ? null : value));

const aiCommercialTermsSchema = z.object({
  clinicId: z.string().uuid(),
  includedBudgetUsd: usdAmountSchema,
  addonBudgetUsd: z.coerce.number().min(0).max(1_000_000),
  overageMode: z.enum(["hard_cap", "contracted"]),
  overageBudgetUsd: z.coerce.number().min(0).max(1_000_000),
  reason: z.enum(["pilot", "prepaid_addon", "contracted_overage", "support_adjustment"]),
}).superRefine((value, context) => {
  if (value.overageMode === "hard_cap" && value.overageBudgetUsd !== 0) {
    context.addIssue({
      code: "custom",
      path: ["overageBudgetUsd"],
      message: "validation.aiHardCapOverageMustBeZero",
    });
  }
  if (value.overageMode === "contracted" && value.overageBudgetUsd <= 0) {
    context.addIssue({
      code: "custom",
      path: ["overageBudgetUsd"],
      message: "validation.aiContractedOverageRequired",
    });
  }
});

function usdToMicros(value: number | null): number | null {
  if (value === null) return null;
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new RangeError("AI budget is outside the safe range.");
  return micros;
}

export async function updateAiCommercialTerms(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = aiCommercialTermsSchema.safeParse({
    clinicId: formData.get("clinicId"),
    includedBudgetUsd: formData.get("includedBudgetUsd") ?? "",
    addonBudgetUsd: formData.get("addonBudgetUsd"),
    overageMode: formData.get("overageMode"),
    overageBudgetUsd: formData.get("overageBudgetUsd"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const includedBudgetMicros = usdToMicros(parsed.data.includedBudgetUsd);
  const addonBudgetMicros = usdToMicros(parsed.data.addonBudgetUsd)!;
  const overageBudgetMicros = usdToMicros(parsed.data.overageBudgetUsd)!;
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("ai_commercial_terms").upsert({
    clinic_id: parsed.data.clinicId,
    included_budget_override_micros: includedBudgetMicros,
    addon_budget_micros: addonBudgetMicros,
    overage_mode: parsed.data.overageMode,
    overage_budget_micros: overageBudgetMicros,
    change_reason: parsed.data.reason,
    updated_by: admin.id,
    updated_at: updatedAt,
  });
  if (error) return { error: await actionError("operator.aiCommercialTermsCouldNotBeSaved") };

  await logOperatorAction({
    action: "ai_commercial_terms.updated",
    targetType: "ai_commercial_terms",
    targetId: parsed.data.clinicId,
    clinicId: parsed.data.clinicId,
    payload: {
      includedBudgetMicros,
      addonBudgetMicros,
      overageMode: parsed.data.overageMode,
      overageBudgetMicros,
      reason: parsed.data.reason,
    },
  });
  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath(`/operator/clinics/${parsed.data.clinicId}`);
  revalidatePath("/operator/reports", "layout");
  return { ok: true };
}

async function setAiCommercialTermsAcceptance(
  formData: FormData,
  accepted: boolean,
): Promise<OperatorActionResult> {
  const admin = await requirePlatformAdmin();
  const clinicId = z.string().uuid().safeParse(formData.get("clinicId"));
  if (!clinicId.success) return { error: await actionError("operator.invalidClinic") };

  const supabase = await createClient();
  const updatedAt = new Date().toISOString();
  const result = await supabase
    .from("ai_commercial_terms")
    .update({
      accepted_at: accepted ? updatedAt : null,
      updated_by: admin.id,
      updated_at: updatedAt,
    })
    .eq("clinic_id", clinicId.data)
    .select("clinic_id")
    .maybeSingle();
  if (result.error || !result.data) {
    return { error: await actionError("operator.aiCommercialTermsCouldNotBeSaved") };
  }

  await logOperatorAction({
    action: accepted
      ? "ai_commercial_terms.accepted"
      : "ai_commercial_terms.revoked",
    targetType: "ai_commercial_terms",
    targetId: clinicId.data,
    clinicId: clinicId.data,
  });
  invalidateEntitlements(clinicId.data);
  revalidatePath(`/operator/clinics/${clinicId.data}`);
  revalidatePath("/operator/reports", "layout");
  return { ok: true };
}

export async function acceptAiCommercialTerms(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  return setAiCommercialTermsAcceptance(formData, true);
}

export async function revokeAiCommercialTerms(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  return setAiCommercialTermsAcceptance(formData, false);
}

export async function removeFeatureOverride(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = z
    .object({ clinicId: z.string().uuid(), featureKey: z.string().trim().min(1).max(100) })
    .safeParse({ clinicId: formData.get("clinicId"), featureKey: formData.get("featureKey") });
  if (!parsed.success) return { error: await actionError("operator.invalidOverride") };

  const supabase = await createClient();
  const { error } = await supabase
    .from("clinic_feature_overrides")
    .delete()
    .eq("clinic_id", parsed.data.clinicId)
    .eq("feature_key", parsed.data.featureKey);
  if (error) return { error: await actionError("operator.overrideCouldNotBeRemoved") };
  await logOperatorAction({ action: "feature_override.removed", targetType: "clinic_feature_override", targetId: parsed.data.featureKey, clinicId: parsed.data.clinicId });

  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

// ── Invitation lifecycle (form-shaped wrappers over P1C actions) ────────────

export async function issueInvitationForm(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  const parsed = z.string().uuid().safeParse(formData.get("invitationId"));
  if (!parsed.success) return { error: await actionError("operator.invalidInvitation") };
  return issueClinicInvitation(parsed.data, { force: formData.get("force") === "true" });
}

export async function revokeInvitationForm(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  const parsed = z.string().uuid().safeParse(formData.get("invitationId"));
  if (!parsed.success) return { error: await actionError("operator.invalidInvitation") };
  return revokeClinicInvitation(parsed.data);
}

/**
 * The set of origins an emailed invitation link is allowed to point at. Both
 * are app-controlled: the configured canonical origin (production) and the
 * origin the request actually arrived on (previews/local, and the deployed host
 * whether or not it byte-matches the env var). An empty set means neither could
 * be resolved — validation then falls back to path-only checks.
 */
async function resolveAllowedInvitationOrigins(): Promise<Set<string>> {
  const origins = new Set<string>();
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    try {
      origins.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).origin);
    } catch {
      // Malformed env — ignore and rely on the request origin.
    }
  }
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? "https";
      origins.add(new URL(`${proto}://${host}`).origin);
    }
  } catch {
    // Outside a request context (e.g. unit tests) — env origin still applies.
  }
  return origins;
}

export async function sendInvitationEmail(_previous: OperatorActionResult | null, formData: FormData): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  // The link is built in the operator's browser from `window.location.origin`,
  // which is authoritative for where they actually are. Accept it when its
  // origin matches either the configured canonical origin (NEXT_PUBLIC_SITE_URL)
  // or the current request origin — so a www/non-www (or preview host) mismatch
  // between the deployed host and the env var never rejects a legitimate link,
  // while a foreign origin (matching neither) is still refused.
  const allowedOrigins = await resolveAllowedInvitationOrigins();
  const parsed = z.object({ invitationId: z.string().uuid(), invitationEmail: z.string().email(), invitationLink: z.string().url().refine((value) => { const url = new URL(value); return url.pathname.startsWith("/signup/") && (allowedOrigins.size === 0 || allowedOrigins.has(url.origin)); }) }).safeParse({ invitationId: formData.get("invitationId"), invitationEmail: formData.get("invitationEmail"), invitationLink: formData.get("invitationLink") });
  if (!parsed.success) return { error: await actionError("operator.theInvitationEmailRequestIsInvalid") };
  const db = await createClient();
  const invitation = await db.from("clinic_invitations").select("id, clinic_name, owner_name, email, status, expires_at").eq("id", parsed.data.invitationId).eq("email", parsed.data.invitationEmail).maybeSingle();
  // Reject revoked/accepted (status ≠ pending) and also expired invitations
  // whose status has not yet been flipped — an expired link must never be sent.
  const isExpired = invitation.data?.expires_at ? new Date(invitation.data.expires_at).getTime() <= Date.now() : true;
  if (invitation.error || !invitation.data || invitation.data.status !== "pending" || isExpired) return { error: await actionError("operator.thisInvitationIsNoLongerAvailable") };
  try {
    const result = await getResend().emails.send({ from: DEFAULT_FROM, to: invitation.data.email, subject: `You're invited to ClinicFlow — ${invitation.data.clinic_name}`, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h1 style="color:#0f766e">Welcome to ClinicFlow</h1><p>Hello ${invitation.data.owner_name},</p><p>Your clinic has been invited to join ClinicFlow.</p><p><a href="${parsed.data.invitationLink}" style="display:inline-block;padding:12px 18px;background:#0f766e;color:white;text-decoration:none;border-radius:8px">Accept invitation</a></p><p>This single-use link expires ${invitation.data.expires_at ? new Date(invitation.data.expires_at).toUTCString() : "soon"}.</p></div>` });
    if (result.error) { console.error("Invitation email send failed", { invitationId: invitation.data.id, category: "provider_error" }); return { error: await actionError("operator.invitationEmailCouldNotBeSentTheInvitationLinkRemains") }; }
  } catch { console.error("Invitation email transport failed", { invitationId: invitation.data.id, category: "transport_error" }); return { error: await actionError("operator.invitationEmailCouldNotBeSentTheInvitationLinkRemains") }; }
  const sentAt = new Date().toISOString();
  const updated = await db.from("clinic_invitations").update({ email_sent_at: sentAt, updated_at: sentAt }).eq("id", invitation.data.id).eq("status", "pending");
  await logOperatorAction({ action: "invitation.email_sent", targetType: "clinic_invitation", targetId: invitation.data.id });
  if (updated.error) { console.error("Invitation email timestamp failed", { invitationId: invitation.data.id, message: updated.error.message }); return { error: await actionError("operator.emailWasSentAndAuditedButItsDeliveryTimestampCould") }; }
  revalidatePath("/operator/invitations");
  return { ok: true };
}

// ── Coupon CRUD & assignment (§3.3) ─────────────────────────────────────────

const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9_-]+$/, "validation.couponCodeFormat")),
    kind: z.enum(["lifetime_free", "months_free", "percent_discount"]),
    months: z.union([z.literal(""), z.coerce.number().int().min(1).max(120)]).optional(),
    percent: z.union([z.literal(""), z.coerce.number().int().min(1).max(100)]).optional(),
    expiresAt: z.union([z.literal(""), z.string()]).optional(),
    maxRedemptions: z.union([z.literal(""), z.coerce.number().int().min(1)]).optional(),
    clinicId: z.union([z.literal(""), z.string().uuid()]).optional(),
    invitationId: z.union([z.literal(""), z.string().uuid()]).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "months_free" && !value.months) {
      context.addIssue({ code: "custom", path: ["months"], message: "validation.monthsRequired" });
    }
    if (value.kind === "percent_discount" && !value.percent) {
      context.addIssue({ code: "custom", path: ["percent"], message: "validation.percentageRequired" });
    }
    if (value.clinicId && value.invitationId) {
      context.addIssue({
        code: "custom",
        path: ["invitationId"],
        message: "validation.couponAssignmentExclusive",
      });
    }
  });

export async function createCoupon(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = couponSchema.safeParse({
    code: formData.get("code"),
    kind: formData.get("kind"),
    months: formData.get("months") ?? "",
    percent: formData.get("percent") ?? "",
    expiresAt: formData.get("expiresAt") ?? "",
    maxRedemptions: formData.get("maxRedemptions") ?? "",
    clinicId: formData.get("clinicId") ?? "",
    invitationId: formData.get("invitationId") ?? "",
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: coupon, error } = await supabase.from("coupons").insert({
    code: parsed.data.code,
    kind: parsed.data.kind,
    months: parsed.data.kind === "months_free" ? Number(parsed.data.months) : null,
    percent: parsed.data.kind === "percent_discount" ? Number(parsed.data.percent) : null,
    expires_at: parsed.data.expiresAt ? couponExpiryFromInput(parsed.data.expiresAt) : null,
    max_redemptions: parsed.data.maxRedemptions ? Number(parsed.data.maxRedemptions) : null,
    clinic_id: parsed.data.clinicId || null,
    invitation_id: parsed.data.invitationId || null,
  }).select("id").single();
  if (error) {
    return {
      error: error.code === "23505"
        ? await actionError("operator.aCouponWithThisCodeAlreadyExists")
        : await actionError("operator.couponCouldNotBeCreated"),
    };
  }
  await logOperatorAction({ action: "coupon.created", targetType: "coupon", targetId: coupon.id, clinicId: parsed.data.clinicId || null, payload: { code: parsed.data.code, kind: parsed.data.kind, invitationId: parsed.data.invitationId || null } });
  revalidatePath("/operator/coupons");
  return { ok: true };
}

export async function setCouponActive(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = z
    .object({ couponId: z.string().uuid(), isActive: z.enum(["true", "false"]) })
    .safeParse({ couponId: formData.get("couponId"), isActive: formData.get("isActive") });
  if (!parsed.success) return { error: await actionError("operator.invalidCoupon") };

  const supabase = await createClient();
  const { error } = await supabase
    .from("coupons")
    .update({ is_active: parsed.data.isActive === "true", updated_at: new Date().toISOString() })
    .eq("id", parsed.data.couponId);
  if (error) return { error: await actionError("operator.couponCouldNotBeUpdated") };
  await logOperatorAction({ action: "coupon.active_changed", targetType: "coupon", targetId: parsed.data.couponId, payload: { isActive: parsed.data.isActive === "true" } });
  revalidatePath("/operator/coupons");
  return { ok: true };
}

// ── Per-clinic AI allowance override (owner console, §P13) ─────────────────
//
// The allowance model is "plan default + optional per-clinic override". These
// two actions are the whole of the override lifecycle, and they exist so the
// owner never has to reason about add-ons, overage mode, or micros to raise or
// reset one clinic's included allowance. Every other commercial column is
// carried forward untouched; removing the override restores the plan default by
// nulling the column, not by writing the plan number into it (which would
// silently freeze that clinic at today's plan value).

const allowanceOverrideSchema = z.object({
  clinicId: z.string().uuid(),
  includedAllowanceUsd: z.coerce.number().positive().max(1_000_000),
  reason: z.enum(["pilot", "prepaid_addon", "contracted_overage", "support_adjustment"]),
});

/** Loads the row we must preserve, so an upsert cannot reset unrelated terms. */
async function existingAiCommercialTerms(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
) {
  return supabase
    .from("ai_commercial_terms")
    .select("included_budget_override_micros, addon_budget_micros, overage_mode, overage_budget_micros, change_reason, accepted_at")
    .eq("clinic_id", clinicId)
    .maybeSingle();
}

export async function setClinicAiAllowanceOverride(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = allowanceOverrideSchema.safeParse({
    clinicId: formData.get("clinicId"),
    includedAllowanceUsd: formData.get("includedAllowanceUsd"),
    reason: formData.get("reason") ?? "support_adjustment",
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const current = await existingAiCommercialTerms(supabase, parsed.data.clinicId);
  if (current.error) return { error: await actionError("operator.aiAllowanceOverrideCouldNotBeSaved") };

  const overrideMicros = usdToMicros(parsed.data.includedAllowanceUsd)!;
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("ai_commercial_terms").upsert({
    clinic_id: parsed.data.clinicId,
    included_budget_override_micros: overrideMicros,
    addon_budget_micros: current.data?.addon_budget_micros ?? 0,
    overage_mode: current.data?.overage_mode ?? "hard_cap",
    overage_budget_micros: current.data?.overage_budget_micros ?? 0,
    accepted_at: current.data?.accepted_at ?? null,
    change_reason: parsed.data.reason,
    updated_by: admin.id,
    updated_at: updatedAt,
  });
  if (error) return { error: await actionError("operator.aiAllowanceOverrideCouldNotBeSaved") };

  await logOperatorAction({
    action: "ai_allowance_override.set",
    targetType: "ai_commercial_terms",
    targetId: parsed.data.clinicId,
    clinicId: parsed.data.clinicId,
    payload: {
      includedBudgetMicros: overrideMicros,
      previousIncludedBudgetMicros: current.data?.included_budget_override_micros ?? null,
      reason: parsed.data.reason,
    },
  });
  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath(`/operator/clinics/${parsed.data.clinicId}`);
  revalidatePath("/operator/ai-allowance");
  return { ok: true };
}

export async function removeClinicAiAllowanceOverride(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  const admin = await requirePlatformAdmin();
  const clinicId = z.string().uuid().safeParse(formData.get("clinicId"));
  if (!clinicId.success) return { error: await actionError("operator.invalidClinic") };

  const supabase = await createClient();
  const result = await supabase
    .from("ai_commercial_terms")
    .update({ included_budget_override_micros: null, updated_by: admin.id, updated_at: new Date().toISOString() })
    .eq("clinic_id", clinicId.data)
    .select("clinic_id")
    .maybeSingle();
  if (result.error) return { error: await actionError("operator.aiAllowanceOverrideCouldNotBeRemoved") };
  // No row at all already means "plan default applies"; report success rather
  // than an error the owner cannot act on.
  await logOperatorAction({
    action: "ai_allowance_override.removed",
    targetType: "ai_commercial_terms",
    targetId: clinicId.data,
    clinicId: clinicId.data,
  });
  invalidateEntitlements(clinicId.data);
  revalidatePath(`/operator/clinics/${clinicId.data}`);
  revalidatePath("/operator/ai-allowance");
  return { ok: true };
}

// ── Subscription lifecycle: extend, pause, reactivate (§P13) ───────────────
//
// Deliberately non-destructive. "Pause" moves the subscription to `past_due`,
// which `resolveSubscriptionAccess` already treats as no-access, and leaves the
// plan, the period and the trial dates exactly where they were — so
// "reactivate" is a pure inverse. Nothing here deletes a row.

const extendDaysSchema = z.object({
  clinicId: z.string().uuid(),
  days: z.coerce.number().int().min(1).max(3650),
});

export async function extendSubscriptionDays(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = extendDaysSchema.safeParse({
    clinicId: formData.get("clinicId"),
    days: formData.get("days"),
  });
  if (!parsed.success) return { fieldErrors: await localizeZodFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: subscription, error: lookupError } = await supabase
    .from("subscriptions")
    .select("id, status, current_period_start, current_period_end")
    .eq("clinic_id", parsed.data.clinicId)
    .maybeSingle();
  if (lookupError || !subscription) {
    return { error: await actionError("operator.theClinicHasNoSubscriptionRow") };
  }
  if (subscription.current_period_end === null && subscription.status === "active") {
    // An unbounded grant has no end date to push out; extending it is a no-op
    // that would read as a change, so it is refused rather than faked.
    return { error: await actionError("operator.subscriptionIsAlreadyUnbounded") };
  }

  const period = extendedSubscriptionPeriod(
    parsed.data.days,
    subscription.current_period_end,
    subscription.current_period_start,
  );
  const { error } = await supabase
    .from("subscriptions")
    .update({
      ...period,
      status: "active",
      trial_ends_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscription.id);
  if (error) return { error: await actionError("operator.subscriptionCouldNotBeExtended") };

  await logOperatorAction({
    action: "subscription.extended",
    targetType: "subscription",
    targetId: subscription.id,
    clinicId: parsed.data.clinicId,
    payload: {
      days: parsed.data.days,
      previousPeriodEnd: subscription.current_period_end,
      newPeriodEnd: period.current_period_end,
    },
  });
  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

async function setClinicAccessState(
  formData: FormData,
  next: "past_due" | "active",
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const clinicId = z.string().uuid().safeParse(formData.get("clinicId"));
  if (!clinicId.success) return { error: await actionError("operator.invalidClinic") };

  const supabase = await createClient();
  const { data: subscription, error: lookupError } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("clinic_id", clinicId.data)
    .maybeSingle();
  if (lookupError || !subscription) {
    return { error: await actionError("operator.theClinicHasNoSubscriptionRow") };
  }

  const { error } = await supabase
    .from("subscriptions")
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq("id", subscription.id);
  if (error) return { error: await actionError("operator.clinicAccessCouldNotBeChanged") };

  await logOperatorAction({
    action: next === "past_due" ? "subscription.paused" : "subscription.reactivated",
    targetType: "subscription",
    targetId: subscription.id,
    clinicId: clinicId.data,
    payload: { previousStatus: subscription.status, newStatus: next },
  });
  invalidateEntitlements(clinicId.data);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

export async function pauseClinicAccess(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  return setClinicAccessState(formData, "past_due");
}

export async function reactivateClinicAccess(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  return setClinicAccessState(formData, "active");
}
