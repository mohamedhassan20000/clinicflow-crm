/**
 * P12 — included-usage threshold notices: when they fire, and how they refuse
 * to fire twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUsage: vi.fn(),
  claim: vi.fn(),
  emit: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/ai/commercial", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/allowance")>(
    "@/lib/ai/allowance",
  );
  return {
    getClinicAiCommercialUsage: mocks.getUsage,
    aiUsageThreshold: actual.aiUsageThreshold,
  };
});
vi.mock("@/lib/supabase/admin", () => ({ claimAiUsageThresholdNotice: mocks.claim }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: mocks.emit }));

import { AI_USAGE_THRESHOLD_PERCENTS } from "@/lib/ai/allowance";
import { notifyAiUsageThresholds } from "@/lib/ai/usage-notifications";

const CLINIC = "00000000-0000-4000-8000-000000000002";

function usage(overrides: Record<string, unknown> = {}) {
  return {
    periodStart: "2026-08-01",
    resetDate: "2026-09-01",
    managedAllowanceConfigured: true,
    usedPercent: 0,
    byokConfigured: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ data: true, error: null });
  mocks.emit.mockResolvedValue({ created: 1 });
});

describe("threshold selection", () => {
  it("says nothing below 75%", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 74 }));
    const result = await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    expect(result.notified).toEqual([]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("raises the informational notice at 75%", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 75 }));
    const result = await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    expect(result.notified).toEqual([AI_USAGE_THRESHOLD_PERCENTS.warning]);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai_usage_threshold",
        link: "/settings/ai",
        roles: ["admin"],
        data: expect.objectContaining({ threshold: "warning", percent: "75" }),
      }),
    );
  });

  it("raises both bands when usage jumps straight past 90%", async () => {
    // A single expensive turn can cross two thresholds at once. Both are claimed
    // so the clinic is never left without the 75% notice in its history.
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 93 }));
    const result = await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    expect(result.notified).toEqual([
      AI_USAGE_THRESHOLD_PERCENTS.critical,
      AI_USAGE_THRESHOLD_PERCENTS.warning,
    ]);
  });

  it("recommends a clinic key in the 90% notice when there is none", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 90, byokConfigured: false }));
    await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    const critical = mocks.emit.mock.calls.find(
      ([input]) => input.data.threshold === "critical",
    );
    expect(critical?.[0].data.byokConfigured).toBe("false");
  });

  it("treats an exhaustion denial as authoritative 100% even if the ledger lags", async () => {
    // Worst-case reservations are released at reconcile, so the stored aggregate
    // can read below 100% at the exact moment a turn was hard-denied.
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 97 }));
    const result = await notifyAiUsageThresholds({
      clinicId: CLINIC,
      reason: "denied_exhausted",
    });
    expect(result.notified).toContain(AI_USAGE_THRESHOLD_PERCENTS.exhausted);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threshold: "exhausted" }) }),
    );
  });
});

describe("dedupe", () => {
  it("emits nothing when the period claim was already taken", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 80 }));
    mocks.claim.mockResolvedValue({ data: false, error: null });
    const result = await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    expect(result.notified).toEqual([]);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keys the claim on clinic + billing period + threshold", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 76 }));
    await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    expect(mocks.claim).toHaveBeenCalledWith({
      clinicId: CLINIC,
      periodStart: "2026-08-01",
      threshold: AI_USAGE_THRESHOLD_PERCENTS.warning,
      usedPercent: 76,
    });
  });
});

describe("safety", () => {
  it("says nothing at all when no allowance was ever configured", async () => {
    // "Not set up yet" must never be reported to a clinic as "you ran out".
    mocks.getUsage.mockResolvedValue(
      usage({ managedAllowanceConfigured: false, usedPercent: 0 }),
    );
    const result = await notifyAiUsageThresholds({
      clinicId: CLINIC,
      reason: "denied_exhausted",
    });
    expect(result.notified).toEqual([]);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("never throws a notification failure into the AI turn", async () => {
    mocks.getUsage.mockRejectedValue(new Error("usage projection unavailable"));
    await expect(
      notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" }),
    ).resolves.toEqual({ notified: [] });
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it("carries no conversation, actor, or cost detail into the notification", async () => {
    mocks.getUsage.mockResolvedValue(usage({ usedPercent: 100, byokConfigured: true }));
    await notifyAiUsageThresholds({ clinicId: CLINIC, reason: "reconciled" });
    for (const [input] of mocks.emit.mock.calls) {
      expect(Object.keys(input.data).sort()).toEqual([
        "byokConfigured",
        "percent",
        "resetDate",
        "threshold",
      ]);
    }
  });
});
