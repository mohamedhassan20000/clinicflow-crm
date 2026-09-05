/**
 * P13 — the owner's clinic-control actions.
 *
 * Three things are load-bearing and are pinned here:
 *   • every action re-checks platform-admin BEFORE it touches the database;
 *   • every mutation is audited, with the payload the timeline renders from;
 *   • the allowance override preserves the rest of the commercial terms, and
 *     removing it restores the plan default by nulling the column rather than
 *     freezing today's plan number into the clinic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  from: vi.fn(),
  logOperatorAction: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: mocks.revalidateTag,
}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/actions/early-access", () => ({
  issueClinicInvitation: vi.fn(),
  revokeClinicInvitation: vi.fn(),
}));
vi.mock("@/lib/billing/manual", () => ({ manualBillingProvider: {} }));
vi.mock("@/lib/rbac", () => ({ requirePlatformAdmin: mocks.requirePlatformAdmin }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: mocks.from })),
}));
vi.mock("@/lib/platform-audit", () => ({ logOperatorAction: mocks.logOperatorAction }));
vi.mock("@/lib/email/resend", () => ({ DEFAULT_FROM: "x", getResend: vi.fn() }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/validations/server", () => ({
  localizeZodFieldErrors: vi.fn(async () => ({ field: ["invalid"] })),
}));

import {
  extendSubscriptionDays,
  pauseClinicAccess,
  reactivateClinicAccess,
  removeClinicAiAllowanceOverride,
  setClinicAiAllowanceOverride,
} from "@/actions/operator";
import { extendedSubscriptionPeriod } from "@/lib/operator";

const CLINIC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/**
 * A per-table double. `reads` supplies what a maybeSingle() returns; `writes`
 * captures the payload each table received.
 */
function stubTables(reads: Record<string, unknown>) {
  const writes: Record<string, unknown[]> = {};
  mocks.from.mockImplementation((table: string) => {
    const capture = (payload: unknown) => {
      (writes[table] ??= []).push(payload);
    };
    const terminal = {
      select: () => terminal,
      eq: () => terminal,
      maybeSingle: async () => ({ data: reads[table] ?? null, error: null }),
      then: (resolve: (value: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
    };
    return {
      select: () => terminal,
      upsert: (payload: unknown) => {
        capture(payload);
        return terminal;
      },
      update: (payload: unknown) => {
        capture(payload);
        return terminal;
      },
    };
  });
  return writes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ id: ADMIN_ID });
});

describe("operator authorization", () => {
  it.each([
    ["setClinicAiAllowanceOverride", () => setClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID, includedAllowanceUsd: "5" }))],
    ["removeClinicAiAllowanceOverride", () => removeClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID }))],
    ["extendSubscriptionDays", () => extendSubscriptionDays(null, form({ clinicId: CLINIC_ID, days: "30" }))],
    ["pauseClinicAccess", () => pauseClinicAccess(null, form({ clinicId: CLINIC_ID }))],
    ["reactivateClinicAccess", () => reactivateClinicAccess(null, form({ clinicId: CLINIC_ID }))],
  ])("%s refuses to run when the platform-admin guard rejects", async (_name, invoke) => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Error("NOT_PLATFORM_ADMIN"));
    stubTables({});

    await expect(invoke()).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.logOperatorAction).not.toHaveBeenCalled();
  });
});

describe("AI allowance override", () => {
  it("writes the override in micros and preserves every other commercial term", async () => {
    const writes = stubTables({
      ai_commercial_terms: {
        included_budget_override_micros: 2_000_000,
        addon_budget_micros: 7_000_000,
        overage_mode: "contracted",
        overage_budget_micros: 9_000_000,
        change_reason: "pilot",
        accepted_at: "2026-08-01T00:00:00.000Z",
      },
    });

    const result = await setClinicAiAllowanceOverride(
      null,
      form({ clinicId: CLINIC_ID, includedAllowanceUsd: "12.5", reason: "support_adjustment" }),
    );

    expect(result).toEqual({ ok: true });
    expect(writes.ai_commercial_terms[0]).toMatchObject({
      clinic_id: CLINIC_ID,
      included_budget_override_micros: 12_500_000,
      addon_budget_micros: 7_000_000,
      overage_mode: "contracted",
      overage_budget_micros: 9_000_000,
      accepted_at: "2026-08-01T00:00:00.000Z",
      updated_by: ADMIN_ID,
    });
  });

  it("defaults the untouched terms safely when the clinic has no terms row yet", async () => {
    const writes = stubTables({});
    await setClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID, includedAllowanceUsd: "3" }));

    expect(writes.ai_commercial_terms[0]).toMatchObject({
      included_budget_override_micros: 3_000_000,
      addon_budget_micros: 0,
      overage_mode: "hard_cap",
      overage_budget_micros: 0,
      accepted_at: null,
    });
  });

  it("audits the change with the old and new allowance", async () => {
    stubTables({ ai_commercial_terms: { included_budget_override_micros: 2_000_000 } });
    await setClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID, includedAllowanceUsd: "4" }));

    expect(mocks.logOperatorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_allowance_override.set",
        clinicId: CLINIC_ID,
        payload: expect.objectContaining({
          includedBudgetMicros: 4_000_000,
          previousIncludedBudgetMicros: 2_000_000,
        }),
      }),
    );
  });

  it("removes the override by nulling the column, never by writing the plan number", async () => {
    const writes = stubTables({ ai_commercial_terms: { clinic_id: CLINIC_ID } });

    const result = await removeClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID }));

    expect(result).toEqual({ ok: true });
    expect(writes.ai_commercial_terms[0]).toMatchObject({
      included_budget_override_micros: null,
      updated_by: ADMIN_ID,
    });
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_allowance_override.removed", clinicId: CLINIC_ID }),
    );
  });

  it("rejects a non-positive allowance without touching the database", async () => {
    stubTables({});
    const result = await setClinicAiAllowanceOverride(
      null,
      form({ clinicId: CLINIC_ID, includedAllowanceUsd: "0" }),
    );
    expect(result.fieldErrors).toBeDefined();
    expect(mocks.logOperatorAction).not.toHaveBeenCalled();
  });

  it("invalidates the clinic's entitlement cache so enforcement sees the new number", async () => {
    stubTables({});
    await setClinicAiAllowanceOverride(null, form({ clinicId: CLINIC_ID, includedAllowanceUsd: "9" }));
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`entitlements:${CLINIC_ID}`, { expire: 0 });
  });
});

describe("subscription extension", () => {
  it("adds whole days on top of a live period rather than restarting it", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const period = extendedSubscriptionPeriod(30, "2026-09-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now);
    expect(period.current_period_end).toBe("2026-10-01T00:00:00.000Z");
    expect(period.current_period_start).toBe("2026-08-01T00:00:00.000Z");
  });

  it("gives a lapsed subscription the full window from today", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const period = extendedSubscriptionPeriod(10, "2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", now);
    expect(period.current_period_end).toBe("2026-08-20T00:00:00.000Z");
  });

  it("never produces an end at or before the start", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const period = extendedSubscriptionPeriod(1, null, "2030-01-01T00:00:00.000Z", now);
    expect(new Date(period.current_period_end).getTime()).toBeGreaterThan(
      new Date(period.current_period_start).getTime(),
    );
  });

  it("activates the subscription, clears the trial, and audits the new end date", async () => {
    const writes = stubTables({
      subscriptions: {
        id: SUB_ID,
        status: "trialing",
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2026-09-01T00:00:00.000Z",
      },
    });

    const result = await extendSubscriptionDays(null, form({ clinicId: CLINIC_ID, days: "30" }));

    expect(result).toEqual({ ok: true });
    expect(writes.subscriptions[0]).toMatchObject({ status: "active", trial_ends_at: null });
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscription.extended",
        targetId: SUB_ID,
        payload: expect.objectContaining({ days: 30, previousPeriodEnd: "2026-09-01T00:00:00.000Z" }),
      }),
    );
  });

  it("refuses to 'extend' an unbounded grant instead of pretending to", async () => {
    stubTables({
      subscriptions: { id: SUB_ID, status: "active", current_period_start: null, current_period_end: null },
    });

    const result = await extendSubscriptionDays(null, form({ clinicId: CLINIC_ID, days: "30" }));
    expect(result.error).toBe("operator.subscriptionIsAlreadyUnbounded");
    expect(mocks.logOperatorAction).not.toHaveBeenCalled();
  });

  it("rejects a day count outside the accepted range", async () => {
    stubTables({});
    const result = await extendSubscriptionDays(null, form({ clinicId: CLINIC_ID, days: "0" }));
    expect(result.fieldErrors).toBeDefined();
  });
});

describe("access pause and reactivation", () => {
  it("pauses without deleting anything and without touching the plan or period", async () => {
    const writes = stubTables({ subscriptions: { id: SUB_ID, status: "active" } });

    const result = await pauseClinicAccess(null, form({ clinicId: CLINIC_ID }));

    expect(result).toEqual({ ok: true });
    const payload = writes.subscriptions[0] as Record<string, unknown>;
    expect(payload.status).toBe("past_due");
    expect(Object.keys(payload).sort()).toEqual(["status", "updated_at"]);
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscription.paused",
        payload: { previousStatus: "active", newStatus: "past_due" },
      }),
    );
  });

  it("reactivation is the exact inverse of pausing", async () => {
    const writes = stubTables({ subscriptions: { id: SUB_ID, status: "past_due" } });

    await reactivateClinicAccess(null, form({ clinicId: CLINIC_ID }));

    expect((writes.subscriptions[0] as Record<string, unknown>).status).toBe("active");
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscription.reactivated",
        payload: { previousStatus: "past_due", newStatus: "active" },
      }),
    );
  });

  it("reports a missing subscription rather than creating one", async () => {
    stubTables({});
    const result = await pauseClinicAccess(null, form({ clinicId: CLINIC_ID }));
    expect(result.error).toBe("operator.theClinicHasNoSubscriptionRow");
    expect(mocks.logOperatorAction).not.toHaveBeenCalled();
  });

  it("rejects a malformed clinic id", async () => {
    stubTables({});
    const result = await pauseClinicAccess(null, form({ clinicId: "not-a-uuid" }));
    expect(result.error).toBe("operator.invalidClinic");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
