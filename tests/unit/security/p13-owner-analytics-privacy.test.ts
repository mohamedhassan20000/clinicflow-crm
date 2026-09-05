/**
 * P13 — privacy and authorization guards for the owner analytics surfaces.
 *
 * These are source-level structural assertions on purpose. The properties they
 * protect ("the owner clinic page never reads a patient row", "every operator
 * route re-checks platform-admin") are properties of the *call sites*, and a
 * behavioural test on a mocked client would pass happily the day someone adds a
 * new, unmocked query that leaks. Reading the modules is what actually notices.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { safeAuditSummary } from "@/lib/supabase/admin";

const OWNER_CLINIC_PAGE = "app/(operator)/operator/clinics/[id]/page.tsx";
const OWNER_ALLOWANCE_PAGE = "app/(operator)/operator/ai-allowance/page.tsx";
const OWNER_CLINICS_LIST = "app/(operator)/operator/clinics/page.tsx";
const METRICS_MODULE = "lib/analytics/clinic-metrics.ts";
const ALLOWANCE_MODULE = "lib/ai/operator-allowance.ts";
const CLINIC_KPI_COMPONENT = "components/dashboard/clinic-overview-kpis.tsx";

function read(path: string) {
  return readFileSync(path, "utf8");
}

/** Tables whose rows carry patient identity, clinical content, or message bodies. */
const PHI_TABLES = [
  '"patients"',
  '"medical_notes"',
  '"prescriptions"',
  '"lab_requests"',
  '"sick_leaves"',
  '"patient_documents"',
  '"medical_note_attachments"',
  '"inbound_messages"',
  '"outbound_messages"',
  '"conversations"',
  '"agent_messages"',
  '"ai_patient_intakes"',
];

describe("operator route authorization", () => {
  it.each([OWNER_ALLOWANCE_PAGE, OWNER_CLINIC_PAGE])(
    "%s resolves its data behind a platform-admin guard",
    (path) => {
      const source = read(path);
      const guarded =
        source.includes("requirePlatformAdmin()") ||
        // The clinic page's loaders each call requirePlatformAdmin() themselves.
        (source.includes("getOperatorClinicHistory") && source.includes("getOperatorClinicMetrics"));
      expect(guarded).toBe(true);
    },
  );

  it("every operator data helper the pages call re-checks platform admin in the module", () => {
    const admin = read("lib/supabase/admin.ts");
    for (const helper of [
      "export async function getOperatorClinicHistory",
      "export async function getOperatorClinicMetrics",
      "export async function loadOperatorAiAllowanceFallbackSources",
    ]) {
      const start = admin.indexOf(helper);
      expect(start, `${helper} is missing`).toBeGreaterThan(-1);
      const body = admin.slice(start, start + 900);
      expect(body).toContain("requirePlatformAdmin()");
    }
  });

  it("every owner clinic mutation is audited", () => {
    const actions = read("actions/operator.ts");
    for (const action of [
      "setClinicAiAllowanceOverride",
      "removeClinicAiAllowanceOverride",
      "extendSubscriptionDays",
      "setClinicAccessState",
    ]) {
      const start = actions.indexOf(`function ${action}`);
      expect(start, `${action} is missing`).toBeGreaterThan(-1);
      const body = actions.slice(start, actions.indexOf("\n}", start));
      expect(body, `${action} must audit`).toContain("logOperatorAction(");
    }
  });
});

describe("owner analytics never read tenant content", () => {
  it("the aggregate module issues head-only counts", () => {
    const source = read(METRICS_MODULE);
    const selects = [...source.matchAll(/\.select\(([^)]*)\)/g)].map((match) => match[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select).toContain("head: true");
      expect(select).toContain('count: "exact"');
    }
  });

  it("the allowance module reads no patient or clinical table", () => {
    const source = read(ALLOWANCE_MODULE);
    for (const table of PHI_TABLES) {
      expect(source).not.toContain(`from(${table})`);
    }
  });

  it("the owner allowance fallback selects only commercial and aggregate columns", () => {
    const admin = read("lib/supabase/admin.ts");
    const start = admin.indexOf("export async function loadOperatorAiAllowanceFallbackSources");
    const body = admin.slice(start, admin.indexOf("\n}\n", start));
    for (const forbidden of ["credential_encrypted", "masked_fingerprint", "full_name", "email"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("the owner clinic page renders counts, never row content, from the metrics", () => {
    const source = read(OWNER_CLINIC_PAGE);
    // Metrics are consumed only through `totals` / `trend`, both of which are
    // numbers by construction in lib/analytics/clinic-metrics.
    const references = [...source.matchAll(/metrics\.(\w+)/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    expect(new Set(references)).toEqual(new Set(["totals", "trend"]));
  });

  it("the owner clinic list still selects tenant metadata only", () => {
    const source = read(OWNER_CLINICS_LIST);
    expect(source).toContain("listOperatorClinics");
    for (const table of PHI_TABLES) {
      expect(source).not.toContain(`from(${table})`);
    }
  });
});

describe("clinic-admin dashboard isolation", () => {
  it("reads through the RLS client, not the service-role client", () => {
    const source = read(CLINIC_KPI_COMPONENT);
    expect(source).toContain('from "@/lib/supabase/server"');
    expect(source).not.toContain("createAdminClient");
    expect(source).not.toContain("createClinicScopedAdminClient");
  });

  it("scopes to the clinic id passed in by the authenticated session only", () => {
    const source = read(CLINIC_KPI_COMPONENT);
    expect(source).toContain("clinicId }: { clinicId: string }");
    expect(source).toContain("getClinicMetrics(supabase, clinicId)");
    // No search-param or request-body clinic id can reach this component.
    expect(source).not.toContain("searchParams");
  });

  it("exposes no platform commercial control to the clinic", () => {
    const source = read(CLINIC_KPI_COMPONENT);
    for (const ownerOnly of [
      "@/actions/operator",
      "AllowanceOverrideControls",
      "extendSubscriptionDays",
      "pauseClinicAccess",
      "included_budget_override_micros",
      "micros",
    ]) {
      expect(source).not.toContain(ownerOnly);
    }
  });

  it("the tenant dashboard page passes its own session clinic id", () => {
    const source = read("app/(protected)/dashboard/page.tsx");
    expect(source).toContain("<ClinicOverviewKpis clinicId={clinicId} />");
    expect(source).toContain("const clinicId = user.clinicId;");
  });
});

describe("audit summaries stay content-free", () => {
  it.each([
    ["subscription.extended", { days: 30 }, "Subscription extended"],
    ["subscription.paused", {}, "Clinic access paused"],
    ["subscription.reactivated", {}, "Clinic access reactivated"],
    ["ai_allowance_override.set", { includedBudgetMicros: 4_000_000 }, "AI allowance override set"],
    ["ai_allowance_override.removed", {}, "AI allowance override removed"],
  ])("summarizes %s without echoing unknown payload fields", (action, payload, title) => {
    const summary = safeAuditSummary({
      id: `event-${action}`,
      action,
      target_type: "subscription",
      target_id: "target",
      payload: { ...payload, patientName: "Private Patient", nationalId: "SECRET" },
      created_at: "2026-08-01T00:00:00.000Z",
    });

    expect(summary?.title).toBe(title);
    expect(JSON.stringify(summary)).not.toContain("Private Patient");
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
});
