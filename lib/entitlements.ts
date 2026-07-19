import "server-only";
import { unstable_cache } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import {
  AI_LIMIT_KEYS,
  LEGACY_AI_ASSISTANT_FEATURE,
  aiModeFeatures,
  isAiFeatureKey,
} from "@/lib/ai/commercial-policy";
import type { AiCredentialMode } from "@/lib/ai/platform/types";
import type { Database, Json } from "@/types/database";

export type FeatureValue = boolean;
export type FeatureMap = Readonly<Record<string, FeatureValue>>;
export type LimitMap = Readonly<Record<string, number>>;
export type UsageMetric = Database["public"]["Enums"]["usage_metric"];

export type Entitlements = {
  clinicId: string;
  planSlug: string | null;
  features: FeatureMap;
  limits: LimitMap;
  subscriptionAllowed: boolean;
};

export type UsageLimitResolution = {
  allowed: boolean;
  metric: UsageMetric;
  used: number;
  limit: number;
  remaining: number;
  reason: "allowed" | "limit_reached" | "subscription_inactive" | "lookup_failed";
};

const METRIC_LIMIT_KEYS: Record<UsageMetric, string> = {
  ai_messages: "ai_messages_month",
  wa_messages: "wa_messages_month",
  sms_messages: "sms_messages_month",
  emails: "emails_month",
};

function objectJson(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeFeatures(value: Json | undefined): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(objectJson(value)).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

export function normalizeLimits(value: Json | undefined): Record<string, number> {
  return Object.fromEntries(
    Object.entries(objectJson(value)).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0,
    ),
  );
}

export function resolveEntitlements(input: {
  clinicId: string;
  planSlug: string | null;
  planFeatures?: Json;
  planLimits?: Json;
  overrides?: Array<{ feature_key: string; enabled: boolean }>;
  subscriptionAllowed: boolean;
}): Entitlements {
  const features = normalizeFeatures(input.planFeatures);
  for (const override of input.overrides ?? []) {
    features[override.feature_key] = override.enabled;
  }
  return {
    clinicId: input.clinicId,
    planSlug: input.planSlug,
    features,
    limits: normalizeLimits(input.planLimits),
    subscriptionAllowed: input.subscriptionAllowed,
  };
}

async function loadEntitlements(clinicId: string): Promise<Entitlements> {
  const failClosed = resolveEntitlements({
    clinicId,
    planSlug: null,
    subscriptionAllowed: false,
  });
  try {
    const client = createClinicScopedAdminClient(clinicId);
    const [subscriptionResult, overridesResult] = await Promise.all([
      client
        .from("subscriptions")
        .select("status, trial_ends_at, current_period_end, plans(slug, features, limits)")
        .eq("clinic_id", clinicId)
        .maybeSingle(),
      client
        .from("clinic_feature_overrides")
        .select("feature_key, enabled")
        .eq("clinic_id", clinicId),
    ]);
    if (subscriptionResult.error || overridesResult.error) return failClosed;

    const plan = subscriptionResult.data?.plans;
    const access = resolveSubscriptionAccess(subscriptionResult.data);
    return resolveEntitlements({
      clinicId,
      planSlug: plan?.slug ?? null,
      planFeatures: plan?.features,
      planLimits: plan?.limits,
      overrides: overridesResult.data ?? [],
      subscriptionAllowed: access.allowed,
    });
  } catch {
    return failClosed;
  }
}

export async function getEntitlements(clinicId: string): Promise<Entitlements> {
  if (process.env.NODE_ENV === "test") return loadEntitlements(clinicId);
  return unstable_cache(() => loadEntitlements(clinicId), ["entitlements", clinicId], {
    tags: [`entitlements:${clinicId}`],
    revalidate: 300,
  })();
}

export function hasFeature(entitlements: Entitlements, featureKey: string): boolean {
  if (!entitlements.subscriptionAllowed) return false;
  if (!isAiFeatureKey(featureKey)) return entitlements.features[featureKey] === true;

  // AI is the exclusive differentiator of the stable pro_ai catalog row.
  // Operator feature overrides may disable AI capabilities within that tier,
  // but must never turn Basic or Professional into an unsigned AI plan.
  if (entitlements.planSlug !== "pro_ai") return false;
  if (featureKey !== LEGACY_AI_ASSISTANT_FEATURE) {
    return (
      entitlements.features[LEGACY_AI_ASSISTANT_FEATURE] === true &&
      entitlements.features[featureKey] === true
    );
  }
  return entitlements.features[featureKey] === true;
}

export function hasAiProviderMode(
  entitlements: Entitlements,
  mode: AiCredentialMode,
): boolean {
  return aiModeFeatures(mode).every((feature) => hasFeature(entitlements, feature));
}

export function resolveAiRequestLimit(entitlements: Entitlements): number {
  return (
    entitlements.limits[AI_LIMIT_KEYS.requestsMonth] ??
    entitlements.limits[AI_LIMIT_KEYS.legacyRequestsMonth] ??
    0
  );
}

export function requireFeature(entitlements: Entitlements, featureKey: string): void {
  if (!hasFeature(entitlements, featureKey)) {
    throw new EntitlementError(featureKey);
  }
}

export class EntitlementError extends Error {
  readonly code = "FEATURE_NOT_ENTITLED";
  constructor(public readonly featureKey: string) {
    super(`The clinic is not entitled to feature "${featureKey}".`);
    this.name = "EntitlementError";
  }
}

function monthStartUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function checkUsageLimit(
  clinicId: string,
  metric: UsageMetric,
  amount = 1,
  now = new Date(),
): Promise<UsageLimitResolution> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError("Usage amount must be a positive integer.");
  }
  const entitlements = await getEntitlements(clinicId);
  if (!entitlements.subscriptionAllowed) {
    return { allowed: false, metric, used: 0, limit: 0, remaining: 0, reason: "subscription_inactive" };
  }
  try {
    const client = createClinicScopedAdminClient(clinicId);
    const { data, error } = await client
      .from("usage_counters")
      .select("used, limit_snapshot")
      .eq("clinic_id", clinicId)
      .eq("period_start", monthStartUtc(now))
      .eq("metric", metric)
      .maybeSingle();
    if (error) {
      return { allowed: false, metric, used: 0, limit: 0, remaining: 0, reason: "lookup_failed" };
    }
    const used = data?.used ?? 0;
    const currentPlanLimit = entitlements.limits[METRIC_LIMIT_KEYS[metric]] ?? 0;
    const limit = Math.max(data?.limit_snapshot ?? 0, currentPlanLimit);
    const remaining = Math.max(0, limit - used);
    return {
      allowed: amount <= remaining,
      metric,
      used,
      limit,
      remaining,
      reason: amount <= remaining ? "allowed" : "limit_reached",
    };
  } catch {
    return { allowed: false, metric, used: 0, limit: 0, remaining: 0, reason: "lookup_failed" };
  }
}
