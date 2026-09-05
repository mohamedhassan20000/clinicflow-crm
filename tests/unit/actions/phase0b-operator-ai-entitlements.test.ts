import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
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
vi.mock("@/lib/operator", () => ({
  couponExpiryFromInput: vi.fn(),
  manualGrantPeriod: vi.fn(),
}));
vi.mock("@/lib/rbac", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: mocks.from })),
}));
vi.mock("@/lib/platform-audit", () => ({
  logOperatorAction: mocks.logOperatorAction,
}));
vi.mock("@/lib/email/resend", () => ({
  DEFAULT_FROM: "ClinicFlow <noreply@example.com>",
  getResend: vi.fn(),
}));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/validations/server", () => ({
  localizeZodFieldErrors: vi.fn(),
}));

import {
  acceptAiCommercialTerms,
  revokeAiCommercialTerms,
  updateAiCommercialTerms,
  upsertFeatureOverride,
} from "@/actions/operator";

const CLINIC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ id: ADMIN_ID });
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.maybeSingle.mockResolvedValue({ data: { clinic_id: CLINIC_ID }, error: null });
  mocks.select.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  mocks.eq.mockReturnValue({ select: mocks.select });
  mocks.update.mockReturnValue({ eq: mocks.eq });
  mocks.from.mockImplementation(() => ({ upsert: mocks.upsert, update: mocks.update }));
});

describe("Phase 0b operator AI entitlement controls", () => {
  it("allows a known AI override without querying or requiring a plan slug", async () => {
    const result = await upsertFeatureOverride(null, form({
      clinicId: CLINIC_ID,
      featureKey: "ai.read_operational",
      enabled: "true",
    }));

    expect(result).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledWith("clinic_feature_overrides");
    expect(mocks.from).not.toHaveBeenCalledWith("subscriptions");
    expect(mocks.upsert).toHaveBeenCalledWith(
      {
        clinic_id: CLINIC_ID,
        feature_key: "ai.read_operational",
        enabled: true,
      },
      { onConflict: "clinic_id,feature_key" },
    );
  });

  it("updates AI budgets without implicitly accepting terms", async () => {
    const result = await updateAiCommercialTerms(null, form({
      clinicId: CLINIC_ID,
      includedBudgetUsd: "",
      addonBudgetUsd: "0",
      overageMode: "hard_cap",
      overageBudgetUsd: "0",
      reason: "pilot",
    }));

    expect(result).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledWith("ai_commercial_terms");
    expect(mocks.from).not.toHaveBeenCalledWith("subscriptions");
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      clinic_id: CLINIC_ID,
      updated_by: ADMIN_ID,
    }));
    expect(mocks.upsert.mock.calls[0]?.[0]).not.toHaveProperty("accepted_at");
  });

  it("accepts AI terms only through the explicit acceptance action", async () => {
    const result = await acceptAiCommercialTerms(null, form({ clinicId: CLINIC_ID }));

    expect(result).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      accepted_at: expect.any(String),
      updated_by: ADMIN_ID,
    }));
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai_commercial_terms.accepted",
      clinicId: CLINIC_ID,
    }));
  });

  it("revokes acceptance without changing the clinic plan or overrides", async () => {
    const result = await revokeAiCommercialTerms(null, form({ clinicId: CLINIC_ID }));

    expect(result).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("ai_commercial_terms");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      accepted_at: null,
      updated_by: ADMIN_ID,
    }));
    expect(mocks.from).not.toHaveBeenCalledWith("subscriptions");
    expect(mocks.from).not.toHaveBeenCalledWith("clinic_feature_overrides");
    expect(mocks.logOperatorAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai_commercial_terms.revoked",
      clinicId: CLINIC_ID,
    }));
  });
});
