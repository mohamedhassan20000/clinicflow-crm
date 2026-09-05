/**
 * Local development clinic — **Health Care Pro** must remain a valid Pro + AI
 * test clinic.
 *
 * The manual-QA clinic lived only in whatever database happened to be attached
 * and did not survive a reset; re-created through signup it lands on the Basic
 * 14-day trial with no AI commercial terms, at which point every `ai.*` key
 * resolves false and the Assistant correctly reports that AI requires Pro + AI.
 * `scripts/seed-dev-clinic.ts` provisions it as an ordinary Pro + AI subscriber
 * instead. This suite is the regression that keeps that fixture honest.
 *
 * It asserts the entitlement through the **canonical Phase 0b resolvers on both
 * sides of the application boundary** — SQL's `effective_ai_feature` and
 * TypeScript's `resolveEffectiveAiFeature` — reading the clinic's real rows, not
 * a stubbed entitlement object. It also asserts the negative controls that
 * distinguish "correctly provisioned" from "gate bypassed": the clinic carries
 * no feature overrides, and revoking either the terms acceptance or the
 * subscription turns every AI key off again.
 *
 * Requires the local Supabase stack and a prior `pnpm dev:seed-clinic`; it
 * seeds the fixture itself so it is self-sufficient on a fresh database.
 */

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AI_CAPABILITY_FEATURES,
  LEGACY_AI_ASSISTANT_FEATURE,
  NAMESPACED_AI_FEATURES,
  resolveEffectiveAiFeature,
} from "@/lib/ai/commercial-policy";
import { normalizeFeatures, resolveEntitlements, hasFeature } from "@/lib/entitlements";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { DEV_CLINIC, seedDevClinic } from "@/scripts/seed-dev-clinic";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * The AI capabilities the Pro + AI plan sells. Deliberately spelled out rather
 * than read back from the plan row: this is the contract the fixture has to
 * satisfy, so reading it from the same row that provides it would assert
 * nothing.
 *
 * Pro + AI is the superset plan, so the contract is *every* supported AI
 * capability — patient auto-reply, hybrid fallback and follow-up generation
 * included. Those three were once withheld from the tier that had paid for
 * them; a clinic on this plan now clears feature and provider-mode entitlement
 * for all of them, and consent, role, budget and validation gates keep doing
 * their own work downstream.
 */
const EXPECTED_PRO_AI_FEATURES = [
  LEGACY_AI_ASSISTANT_FEATURE,
  "ai.staff_assistant",
  "ai.staff_analytics",
  "ai.financial_insights",
  "ai.assistant_customization",
  "ai.managed",
  "ai.byok",
  "ai.hybrid_fallback",
  "ai.patient_suggest",
  "ai.patient_auto",
  "ai.workflows",
  "ai.followup_generation",
  "ai.scheduling",
  "ai.read_operational",
  "ai.read_clinical",
  "ai.read_financial",
  "ai.write_scheduling",
  "ai.write_records",
  "ai.write_administration",
  "ai.write_privileged",
  "ai.documents",
  "ai.bulk_export",
] as const;

type Loaded = {
  planSlug: string | null;
  status: string;
  features: Record<string, boolean>;
  subscriptionAllowed: boolean;
  termsAccepted: boolean;
  overrideCount: number;
};

async function loadClinic(): Promise<Loaded> {
  const subscription = await service
    .from("subscriptions")
    .select("status, trial_ends_at, current_period_end, plans(slug, features, limits)")
    .eq("clinic_id", DEV_CLINIC.id)
    .maybeSingle();
  if (subscription.error) throw subscription.error;
  expect(subscription.data, "Health Care Pro has no subscription row").not.toBeNull();

  const terms = await service
    .from("ai_commercial_terms")
    .select("accepted_at")
    .eq("clinic_id", DEV_CLINIC.id)
    .maybeSingle();
  if (terms.error) throw terms.error;

  const overrides = await service
    .from("clinic_feature_overrides")
    .select("feature_key")
    .eq("clinic_id", DEV_CLINIC.id);
  if (overrides.error) throw overrides.error;

  return {
    planSlug: subscription.data!.plans?.slug ?? null,
    status: subscription.data!.status,
    features: normalizeFeatures(subscription.data!.plans?.features),
    subscriptionAllowed: resolveSubscriptionAccess(subscription.data).allowed,
    termsAccepted: terms.data?.accepted_at != null,
    overrideCount: overrides.data?.length ?? 0,
  };
}

async function sqlEffective(featureKey: string): Promise<boolean> {
  const { data, error } = await service.rpc("effective_ai_feature", {
    p_clinic_id: DEV_CLINIC.id,
    p_feature_key: featureKey,
  });
  if (error) throw error;
  return data === true;
}

let clinic: Loaded;

beforeAll(async () => {
  await seedDevClinic();
  clinic = await loadClinic();
}, 60_000);

describe("Health Care Pro is a legitimate Pro + AI subscriber", () => {
  it("exists exactly once, on the pro_ai plan, with an allowed subscription and accepted AI terms", async () => {
    const byName = await service
      .from("clinics")
      .select("id, name")
      .eq("name", DEV_CLINIC.name);
    if (byName.error) throw byName.error;
    expect(byName.data.map((row) => row.id)).toEqual([DEV_CLINIC.id]);

    expect(clinic.planSlug).toBe("pro_ai");
    expect(clinic.status).toBe("active");
    expect(clinic.subscriptionAllowed).toBe(true);
    expect(clinic.termsAccepted).toBe(true);
  });

  it("earns its AI capabilities from the plan, not from a per-clinic override", () => {
    // The fixture must be indistinguishable from a paying subscriber. A
    // `clinic_feature_overrides` row would grant the same capabilities while
    // masking whether the plan resolution actually works.
    expect(clinic.overrideCount).toBe(0);
    for (const key of EXPECTED_PRO_AI_FEATURES) {
      expect(clinic.features[key], `plan feature ${key}`).toBe(true);
    }
  });

  it.each(EXPECTED_PRO_AI_FEATURES.map((key) => [key] as const))(
    "resolves %s through the canonical resolver on both sides of the boundary",
    async (featureKey) => {
      const typescript = resolveEffectiveAiFeature({
        subscriptionAllowed: clinic.subscriptionAllowed,
        termsAccepted: clinic.termsAccepted,
        features: clinic.features,
        featureKey,
      });
      expect(typescript, `TS ${featureKey}`).toBe(true);
      expect(await sqlEffective(featureKey), `SQL ${featureKey}`).toBe(true);
    },
  );

  it("resolves the same answer through getEntitlements' own hasFeature path", () => {
    const entitlements = resolveEntitlements({
      clinicId: DEV_CLINIC.id,
      planSlug: clinic.planSlug,
      planFeatures: clinic.features,
      subscriptionAllowed: clinic.subscriptionAllowed,
      aiTermsAccepted: clinic.termsAccepted,
    });
    for (const key of EXPECTED_PRO_AI_FEATURES) {
      expect(hasFeature(entitlements, key), key).toBe(true);
    }
    // Every AI key the product knows about, so a newly added Pro + AI feature
    // that the plan row forgets is visible here rather than at manual QA.
    const unentitled = NAMESPACED_AI_FEATURES.filter(
      (key) => !hasFeature(entitlements, key),
    );
    // Pro + AI is the superset plan: nothing may be withheld from it. Anything
    // in this list means either the fixture drifted below Pro + AI or a
    // capability was added without the superset covering it.
    expect(unentitled).toEqual([]);
    for (const key of AI_CAPABILITY_FEATURES) {
      expect(hasFeature(entitlements, key), `capability ${key}`).toBe(true);
    }
  });

  it("carries the Pro + AI request and step allowances the assistant runtime needs", async () => {
    const { data, error } = await service
      .from("subscriptions")
      .select("plans(limits)")
      .eq("clinic_id", DEV_CLINIC.id)
      .single();
    if (error) throw error;
    const limits = (data.plans?.limits ?? {}) as Record<string, number>;
    expect(limits.ai_requests_month ?? limits.ai_messages_month).toBeGreaterThan(0);
    expect(limits.ai_turn_steps_max).toBeGreaterThan(0);
    expect(limits.ai_concurrent_requests).toBeGreaterThan(0);
  });

  it("has the full staff role matrix so the B-2 write surface is manually reachable", async () => {
    const { data, error } = await service
      .from("profiles")
      .select("role")
      .eq("clinic_id", DEV_CLINIC.id)
      .eq("is_active", true);
    if (error) throw error;
    const roles = new Set(data.map((row) => row.role));
    for (const role of ["admin", "manager", "receptionist", "doctor", "assistant"]) {
      expect(roles, role).toContain(role);
    }

    // The assistant's whole scope is its supervised doctors, so an unassigned
    // assistant would be an unusable QA account.
    const assignments = await service
      .from("assistant_doctor_assignments")
      .select("assistant_id")
      .eq("clinic_id", DEV_CLINIC.id);
    if (assignments.error) throw assignments.error;
    expect(assignments.data.length).toBeGreaterThan(0);
  });
});

describe("Health Care Pro is entitled, not exempted", () => {
  it("loses every AI feature when the terms acceptance is withdrawn", async () => {
    const revoke = await service
      .from("ai_commercial_terms")
      .update({ accepted_at: null })
      .eq("clinic_id", DEV_CLINIC.id);
    if (revoke.error) throw revoke.error;
    try {
      for (const key of ["ai.staff_assistant", "ai.write_records"]) {
        expect(await sqlEffective(key), `SQL ${key} after revoke`).toBe(false);
        expect(
          resolveEffectiveAiFeature({
            subscriptionAllowed: clinic.subscriptionAllowed,
            termsAccepted: false,
            features: clinic.features,
            featureKey: key,
          }),
          `TS ${key} after revoke`,
        ).toBe(false);
      }
    } finally {
      const restore = await service
        .from("ai_commercial_terms")
        .update({ accepted_at: new Date().toISOString() })
        .eq("clinic_id", DEV_CLINIC.id);
      if (restore.error) throw restore.error;
    }
    expect(await sqlEffective("ai.staff_assistant")).toBe(true);
  });

  it("loses every AI feature when the subscription stops being allowed", async () => {
    const cancel = await service
      .from("subscriptions")
      .update({ status: "cancelled" })
      .eq("clinic_id", DEV_CLINIC.id);
    if (cancel.error) throw cancel.error;
    try {
      expect(await sqlEffective("ai.staff_assistant")).toBe(false);
      expect(
        resolveEffectiveAiFeature({
          subscriptionAllowed: false,
          termsAccepted: clinic.termsAccepted,
          features: clinic.features,
          featureKey: "ai.staff_assistant",
        }),
      ).toBe(false);
    } finally {
      const restore = await service
        .from("subscriptions")
        .update({ status: "active" })
        .eq("clinic_id", DEV_CLINIC.id);
      if (restore.error) throw restore.error;
    }
    expect(await sqlEffective("ai.staff_assistant")).toBe(true);
  });
});
