import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = "supabase/migrations";
const PHASE_0B_MIGRATION =
  "20260813130000_ai_entitlement_plan_decoupling.sql";
/**
 * Phase 0b moved AI entitlement off the plan slug; the Pro + AI superset
 * migration is the later, and now final, definition of the same resolver. The
 * decoupling property it inherited is the one asserted here: the superset is a
 * catalog marker (`ai.superset`) the resolver reads, never a slug it tests.
 */
const SUPERSET_MIGRATION = "20260817170000_pro_ai_superset_entitlement.sql";

function source(path: string) {
  return readFileSync(path, "utf8");
}

function between(value: string, start: string, end: string) {
  const startAt = value.indexOf(start);
  const endAt = value.indexOf(end, startAt);
  expect(startAt, `${start} must exist`).toBeGreaterThanOrEqual(0);
  expect(endAt, `${end} must exist after ${start}`).toBeGreaterThan(startAt);
  return value.slice(startAt, endAt);
}

describe("AI Assistant Phase 0b entitlement decoupling", () => {
  it("keeps the active TypeScript resolution paths independent of a plan slug", () => {
    const entitlements = between(
      source("lib/entitlements.ts"),
      "export function hasFeature",
      "export function hasAiProviderMode",
    );
    const operatorOverrides = between(
      source("actions/operator.ts"),
      "export async function upsertFeatureOverride",
      "// ── AI commercial terms",
    );
    const operatorTerms = between(
      source("actions/operator.ts"),
      "export async function updateAiCommercialTerms",
      "export async function removeFeatureOverride",
    );
    const providerHealth = between(
      source("lib/supabase/admin.ts"),
      "export async function loadOperatorAiProviderHealthSource",
      "/**\n * P6B content-free messaging cost source",
    );
    // P13b moved this panel behind the "Advanced AI controls" disclosure on the
    // AI usage tab; it is still the same commercial-terms form.
    const operatorTermsPanel = between(
      source("app/(operator)/operator/clinics/[id]/page.tsx"),
      'id="advanced-ai-controls"',
      "const featuresTab = (",
    );

    for (const resolutionPath of [
      entitlements,
      operatorOverrides,
      operatorTerms,
      providerHealth,
      operatorTermsPanel,
    ]) {
      expect(resolutionPath).not.toMatch(/planSlug|plans?\??\.slug|pro_ai/);
    }
    expect(operatorTermsPanel).toContain("history.effectiveAiAssistant");
  });

  it("makes the superset migration the final authoritative SQL resolver", () => {
    const resolverMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) =>
        source(`${MIGRATIONS_DIR}/${name}`).includes(
          "create or replace function public.effective_ai_feature",
        ),
      );

    // Exactly one resolver wins, and it is the newest definition. A stray later
    // redefinition anywhere in the tree would silently take over entitlement.
    expect(resolverMigrations.at(-1)).toBe(SUPERSET_MIGRATION);
    expect(resolverMigrations).toContain(PHASE_0B_MIGRATION);

    const superset = source(`${MIGRATIONS_DIR}/${SUPERSET_MIGRATION}`);
    const effectiveResolver = between(
      superset,
      "create or replace function public.effective_ai_feature",
      "comment on function public.effective_ai_feature",
    );

    // The superset is resolved inside the one resolver, from the catalog marker.
    expect(effectiveResolver).toContain("plan.features -> 'ai.superset' = 'true'::jsonb");
    // An explicit per-clinic override still wins in both directions.
    expect(effectiveResolver).toContain("feature_override.enabled");
    expect(effectiveResolver).toContain("is distinct from 'false'::jsonb");
    // The commercial-limits resolver is still Phase 0b's; nothing since has
    // redefined it, and it must stay slug-free too.
    const limitsResolver = between(
      source(`${MIGRATIONS_DIR}/${PHASE_0B_MIGRATION}`),
      "create or replace function public.resolve_ai_commercial_limits",
      "-- Re-evaluate the P7 designated patient-auto QA override",
    );

    expect(effectiveResolver).not.toMatch(/plan\.slug|pro_ai/);
    expect(limitsResolver).not.toMatch(/plan\.slug|pro_ai/);
    expect(effectiveResolver).toContain("terms.accepted_at is not null");
    expect(effectiveResolver).toContain("umbrella_override.enabled");
    expect(effectiveResolver).toContain("plan.features -> 'ai_assistant' = 'true'::jsonb");
    expect(effectiveResolver).toContain("plan.features -> p_feature_key");
    expect(effectiveResolver).not.toContain("plan.features ->>");
    expect(limitsResolver).toContain("v_plan_limits ? 'ai_credits_month'");
  });

  it("supersedes the historical P5A and P7 paths in the forward migration", () => {
    const phase0b = source(`${MIGRATIONS_DIR}/${PHASE_0B_MIGRATION}`);
    const limitsResolver = between(
      phase0b,
      "create or replace function public.resolve_ai_commercial_limits",
      "revoke all on function public.resolve_ai_commercial_limits",
    );
    const patientAuto = between(
      phase0b,
      "-- Re-evaluate the P7 designated patient-auto QA override",
      "on conflict (clinic_id, feature_key) do update",
    );

    expect(limitsResolver).not.toMatch(/plan\.slug|pro_ai/);
    expect(patientAuto).toContain("public.effective_ai_feature");
  });

  it("keeps acceptance explicit and quarantines stale Basic/Pro overrides", () => {
    const phase0b = source(`${MIGRATIONS_DIR}/${PHASE_0B_MIGRATION}`);
    const backfill = between(
      phase0b,
      "alter table public.ai_commercial_terms",
      "create or replace function public.effective_ai_feature",
    );

    expect(backfill).toContain("alter column accepted_at drop default");
    expect(backfill.match(/plan\.slug = 'pro_ai'/g)).toHaveLength(2);
    expect(backfill).toContain("plan.features -> 'ai_assistant' = 'true'::jsonb");
    expect(backfill).not.toContain("plan.features ->> 'ai_assistant'");
  });
});
