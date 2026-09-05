/**
 * P13 — the owner AI-allowance console loader.
 *
 * The regression this file exists for: the console rendered one generic
 * "report unavailable" sentence for every failure, so the actual cause (the
 * allowance RPC not being present in the target database — PostgREST PGRST202)
 * was invisible. The loader must now (a) always surface the real diagnostic and
 * (b) recompute the report from base tables for that one specific cause, while
 * still failing loudly for every other cause.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOperatorAiAllowanceReport: vi.fn(),
  loadOperatorAiAllowanceFallbackSources: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  loadOperatorAiAllowanceReport: mocks.loadOperatorAiAllowanceReport,
  loadOperatorAiAllowanceFallbackSources: mocks.loadOperatorAiAllowanceFallbackSources,
}));

import { DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS } from "@/lib/ai/commercial-policy";
import {
  loadOperatorAllowanceReport,
  monthStartUtc,
  nextMonthStartUtc,
  resolveAllowanceStatus,
} from "@/lib/ai/operator-allowance";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const PERIOD = { periodStart: "2026-08-01", periodReset: "2026-09-01" };

/** One clinic on the Pro + AI plan with a $1,620 monthly allowance in micros. */
const PLAN_CREDITS = 1_620_000_000;

function fallbackSources(overrides: Record<string, unknown> = {}) {
  return {
    subscriptions: [
      {
        clinic_id: CLINIC,
        clinics: { name: "Health Care Pro" },
        plans: {
          slug: "pro_ai",
          features: { ai_assistant: true },
          limits: { ai_credits_month: PLAN_CREDITS },
        },
      },
    ],
    terms: [],
    periods: [],
    counters: [],
    policies: [],
    byokClinicIds: [],
    byokSpend: [],
    autoFallback: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("period helpers", () => {
  it("pins the period to the first of the UTC month and the reset to the next", () => {
    const now = new Date("2026-08-31T23:30:00.000Z");
    expect(monthStartUtc(now)).toBe("2026-08-01");
    expect(nextMonthStartUtc(now)).toBe("2026-09-01");
  });

  it("rolls the reset date across a year boundary", () => {
    const december = new Date("2026-12-05T00:00:00.000Z");
    expect(monthStartUtc(december)).toBe("2026-12-01");
    expect(nextMonthStartUtc(december)).toBe("2027-01-01");
  });
});

describe("allowance status bands", () => {
  it("uses the shared 75/90/100 thresholds, not an ad-hoc ramp", () => {
    const band = (committed: number) =>
      resolveAllowanceStatus({ credentialMode: "managed", totalAllowanceMicros: 100, committedMicros: committed });
    expect(band(0)).toBe("healthy");
    expect(band(74)).toBe("healthy");
    expect(band(75)).toBe("warning");
    expect(band(89)).toBe("warning");
    expect(band(90)).toBe("critical");
    expect(band(99)).toBe("critical");
    expect(band(100)).toBe("exhausted");
    expect(band(250)).toBe("exhausted");
  });

  it("reports an unconfigured allowance as unconfigured, never as exhausted", () => {
    expect(
      resolveAllowanceStatus({ credentialMode: "managed", totalAllowanceMicros: 0, committedMicros: 0 }),
    ).toBe("unconfigured");
  });

  it("reports a strict-BYOK clinic as byok regardless of the managed numbers", () => {
    expect(
      resolveAllowanceStatus({ credentialMode: "byok_strict", totalAllowanceMicros: 100, committedMicros: 100 }),
    ).toBe("byok");
  });
});

describe("loadOperatorAllowanceReport", () => {
  it("returns the RPC rows untouched, with no diagnostic, when the RPC answers", async () => {
    const row = { clinic_id: CLINIC, clinic_name: "Health Care Pro", used_percent: 12 };
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({ data: [row], error: null });

    const report = await loadOperatorAllowanceReport(PERIOD);

    expect(report.source).toBe("rpc");
    expect(report.failed).toBe(false);
    expect(report.diagnostic).toBeNull();
    expect(report.rows).toEqual([row]);
    expect(mocks.loadOperatorAiAllowanceFallbackSources).not.toHaveBeenCalled();
  });

  it("surfaces the real error and does NOT recompute for a non-missing-function failure", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "PLATFORM_ADMIN_REQUIRED", hint: null },
    });

    const report = await loadOperatorAllowanceReport(PERIOD);

    expect(report.failed).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.diagnostic).toEqual({ code: "42501", message: "PLATFORM_ADMIN_REQUIRED", hint: null });
    // An authorization refusal must never be papered over by a service-role read.
    expect(mocks.loadOperatorAiAllowanceFallbackSources).not.toHaveBeenCalled();
  });

  it("recomputes the report when the RPC is absent from the schema cache", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find the function public.operator_ai_allowance_report(p_period_start) in the schema cache",
        hint: null,
      },
    });
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      fallbackSources({ periods: [{ clinic_id: CLINIC, spent_micros: 810_000_000, reserved_micros: 0 }] }),
    );

    const report = await loadOperatorAllowanceReport(PERIOD);

    expect(report.source).toBe("fallback");
    expect(report.failed).toBe(false);
    // The diagnostic is still reported, so the degraded state is never silent.
    expect(report.diagnostic?.code).toBe("PGRST202");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      clinic_id: CLINIC,
      clinic_name: "Health Care Pro",
      plan_slug: "pro_ai",
      effective_included_micros: PLAN_CREDITS,
      override_included_micros: null,
      managed_spent_micros: 810_000_000,
      remaining_micros: 810_000_000,
      used_percent: 50,
      status: "healthy",
      period_start: "2026-08-01",
      period_reset_at: "2026-09-01",
    });
  });

  it("prefers a per-clinic override over the plan default and marks the source", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      fallbackSources({
        terms: [
          {
            clinic_id: CLINIC,
            included_budget_override_micros: 5_000_000,
            addon_budget_micros: 1_000_000,
            overage_mode: "contracted",
            overage_budget_micros: 4_000_000,
          },
        ],
        periods: [{ clinic_id: CLINIC, spent_micros: 9_000_000, reserved_micros: 1_000_000 }],
      }),
    );

    const [row] = (await loadOperatorAllowanceReport(PERIOD)).rows;

    expect(row.override_included_micros).toBe(5_000_000);
    expect(row.effective_included_micros).toBe(5_000_000);
    // effective + add-on + contracted overage
    expect(row.total_allowance_micros).toBe(10_000_000);
    expect(row.managed_reserved_micros).toBe(1_000_000);
    expect(row.remaining_micros).toBe(0);
    expect(row.used_percent).toBe(100);
    expect(row.status).toBe("exhausted");
  });

  it("ignores a hard-capped overage budget, exactly as the enforcement SQL does", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      fallbackSources({
        terms: [
          {
            clinic_id: CLINIC,
            included_budget_override_micros: null,
            addon_budget_micros: 0,
            overage_mode: "hard_cap",
            overage_budget_micros: 9_999_000_000,
          },
        ],
      }),
    );

    const [row] = (await loadOperatorAllowanceReport(PERIOD)).rows;
    expect(row.overage_micros).toBe(0);
    expect(row.total_allowance_micros).toBe(PLAN_CREDITS);
  });

  it("excludes clinics whose plan does not carry the assistant", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      fallbackSources({
        subscriptions: [
          {
            clinic_id: CLINIC,
            clinics: { name: "Basic Clinic" },
            plans: { slug: "basic", features: { ai_assistant: false }, limits: { ai_credits_month: 0 } },
          },
        ],
      }),
    );

    expect((await loadOperatorAllowanceReport(PERIOD)).rows).toEqual([]);
  });

  it("defaults the post-migration columns rather than failing when they are absent", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
    // byokSpend / autoFallback come back empty when those columns do not exist.
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(fallbackSources());

    const [row] = (await loadOperatorAllowanceReport(PERIOD)).rows;
    expect(row.byok_spent_micros).toBe(0);
    expect(row.auto_byok_fallback_enabled).toBe(true);
    expect(row.credential_mode).toBe("managed");
    expect(row.byok_configured).toBe(false);
  });

  it("reports failure, with the original diagnostic, when the fallback itself fails", async () => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
    mocks.loadOperatorAiAllowanceFallbackSources.mockRejectedValue(new Error("boom"));

    const report = await loadOperatorAllowanceReport(PERIOD);
    expect(report.failed).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.diagnostic?.code).toBe("PGRST202");
  });
});

/**
 * P13b — the $10.00 plan default, and the promise that setting it does not
 * disturb a clinic that already has an explicit allowance of its own.
 */
describe("the $10 default included allowance", () => {
  function planDefaultSources(overrides: Record<string, unknown> = {}) {
    const sources = fallbackSources(overrides);
    sources.subscriptions[0].plans.limits = {
      ai_credits_month: DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS,
    };
    return sources;
  }

  beforeEach(() => {
    mocks.loadOperatorAiAllowanceReport.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "missing", hint: null },
    });
  });

  it("resolves to $10.00 for a clinic with no override of its own", async () => {
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      planDefaultSources({ periods: [{ clinic_id: CLINIC, spent_micros: 0, reserved_micros: 0 }] }),
    );

    const [row] = (await loadOperatorAllowanceReport(PERIOD)).rows;

    expect(row.plan_included_micros).toBe(10_000_000);
    expect(row.override_included_micros).toBeNull();
    expect(row.effective_included_micros).toBe(10_000_000);
    expect(row.total_allowance_micros).toBe(10_000_000);
    expect(row.remaining_micros).toBe(10_000_000);
    expect(row.used_percent).toBe(0);
  });

  it("keeps an existing clinic override exactly as it was, plan default notwithstanding", async () => {
    mocks.loadOperatorAiAllowanceFallbackSources.mockResolvedValue(
      planDefaultSources({
        terms: [
          {
            clinic_id: CLINIC,
            included_budget_override_micros: 250_000_000,
            addon_budget_micros: 0,
            overage_mode: "hard_cap",
            overage_budget_micros: 0,
          },
        ],
        periods: [{ clinic_id: CLINIC, spent_micros: 25_000_000, reserved_micros: 0 }],
      }),
    );

    const [row] = (await loadOperatorAllowanceReport(PERIOD)).rows;

    // The plan moved to $10; this clinic keeps the $250 it was explicitly given.
    expect(row.plan_included_micros).toBe(10_000_000);
    expect(row.override_included_micros).toBe(250_000_000);
    expect(row.effective_included_micros).toBe(250_000_000);
    expect(row.used_percent).toBe(10);
  });
});
