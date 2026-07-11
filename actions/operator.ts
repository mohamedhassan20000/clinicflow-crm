"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import {
  issueClinicInvitation,
  revokeClinicInvitation,
  type PublicActionResult,
} from "@/actions/early-access";
import { manualBillingProvider } from "@/lib/billing/manual";
import { couponExpiryFromInput, manualGrantPeriod } from "@/lib/operator";
import { requirePlatformAdmin } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

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
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

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
  if (error) return { error: "Settings could not be saved." };
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
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const supabase = await createClient();
  const [plan, subscription] = await Promise.all([
    supabase.from("plans").select("id").eq("slug", parsed.data.planSlug).eq("is_active", true).single(),
    supabase
      .from("subscriptions")
      .select("id, current_period_end")
      .eq("clinic_id", parsed.data.clinicId)
      .maybeSingle(),
  ]);
  if (plan.error) return { error: "Plan not found." };
  if (subscription.error || !subscription.data) {
    return { error: "The clinic has no subscription row to grant against." };
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
  if (error) return { error: "Subscription grant failed." };

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
  if (!clinicId.success) return { error: "Invalid clinic." };

  const supabase = await createClient();
  const { data: subscription, error: lookupError } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("clinic_id", clinicId.data)
    .maybeSingle();
  if (lookupError || !subscription) return { error: "The clinic has no subscription row." };

  const patch = await manualBillingProvider.cancelSubscription(subscription);
  const { error } = await supabase
    .from("subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", subscription.id);
  if (error) return { error: "Cancellation failed." };

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
    .regex(/^[a-z0-9_.:-]+$/i, "Use a plain feature key such as ai_assistant."),
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
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const supabase = await createClient();
  const { error } = await supabase.from("clinic_feature_overrides").upsert(
    {
      clinic_id: parsed.data.clinicId,
      feature_key: parsed.data.featureKey,
      enabled: parsed.data.enabled,
    },
    { onConflict: "clinic_id,feature_key" },
  );
  if (error) return { error: "Override could not be saved." };

  invalidateEntitlements(parsed.data.clinicId);
  revalidatePath("/operator", "layout");
  return { ok: true };
}

export async function removeFeatureOverride(
  _previous: OperatorActionResult | null,
  formData: FormData,
): Promise<OperatorActionResult> {
  await requirePlatformAdmin();
  const parsed = z
    .object({ clinicId: z.string().uuid(), featureKey: z.string().trim().min(1).max(100) })
    .safeParse({ clinicId: formData.get("clinicId"), featureKey: formData.get("featureKey") });
  if (!parsed.success) return { error: "Invalid override." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("clinic_feature_overrides")
    .delete()
    .eq("clinic_id", parsed.data.clinicId)
    .eq("feature_key", parsed.data.featureKey);
  if (error) return { error: "Override could not be removed." };

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
  if (!parsed.success) return { error: "Invalid invitation." };
  return issueClinicInvitation(parsed.data, { force: formData.get("force") === "true" });
}

export async function revokeInvitationForm(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  const parsed = z.string().uuid().safeParse(formData.get("invitationId"));
  if (!parsed.success) return { error: "Invalid invitation." };
  return revokeClinicInvitation(parsed.data);
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
      .pipe(z.string().regex(/^[A-Z0-9_-]+$/, "Letters, digits, - and _ only.")),
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
      context.addIssue({ code: "custom", path: ["months"], message: "Months are required." });
    }
    if (value.kind === "percent_discount" && !value.percent) {
      context.addIssue({ code: "custom", path: ["percent"], message: "A percentage is required." });
    }
    if (value.clinicId && value.invitationId) {
      context.addIssue({
        code: "custom",
        path: ["invitationId"],
        message: "Assign to a clinic or an invitation, not both.",
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
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const supabase = await createClient();
  const { error } = await supabase.from("coupons").insert({
    code: parsed.data.code,
    kind: parsed.data.kind,
    months: parsed.data.kind === "months_free" ? Number(parsed.data.months) : null,
    percent: parsed.data.kind === "percent_discount" ? Number(parsed.data.percent) : null,
    expires_at: parsed.data.expiresAt ? couponExpiryFromInput(parsed.data.expiresAt) : null,
    max_redemptions: parsed.data.maxRedemptions ? Number(parsed.data.maxRedemptions) : null,
    clinic_id: parsed.data.clinicId || null,
    invitation_id: parsed.data.invitationId || null,
  });
  if (error) {
    return {
      error: error.code === "23505" ? "A coupon with this code already exists." : "Coupon could not be created.",
    };
  }
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
  if (!parsed.success) return { error: "Invalid coupon." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("coupons")
    .update({ is_active: parsed.data.isActive === "true", updated_at: new Date().toISOString() })
    .eq("id", parsed.data.couponId);
  if (error) return { error: "Coupon could not be updated." };
  revalidatePath("/operator/coupons");
  return { ok: true };
}
