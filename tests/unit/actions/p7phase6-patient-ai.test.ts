import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "admin" as const,
  },
  getEntitlements: vi.fn(),
  requireMutationRole: vi.fn(),
  setClinicAiReplyMode: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
}));
vi.mock("@/lib/entitlements", async () => {
  const actual = await vi.importActual<typeof import("@/lib/entitlements")>(
    "@/lib/entitlements",
  );
  return { ...actual, getEntitlements: mocks.getEntitlements };
});
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: vi.fn(),
  setClinicAiReplyMode: mocks.setClinicAiReplyMode,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: async (key: string) => key,
}));

import { setPatientAiReplyMode } from "@/actions/patient-ai";
import { resolveEntitlements } from "@/lib/entitlements";

function proAiEntitlements(patientAuto: boolean) {
  return resolveEntitlements({
    clinicId: mocks.user.clinicId,
    planSlug: "pro_ai",
    planFeatures: {
      ai_assistant: true,
      "ai.patient_suggest": true,
      "ai.patient_auto": patientAuto,
    },
    subscriptionAllowed: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMutationRole.mockResolvedValue(mocks.user);
  mocks.getEntitlements.mockResolvedValue(proAiEntitlements(true));
  mocks.setClinicAiReplyMode.mockResolvedValue({
    data: { ai_reply_mode: "auto" },
    error: null,
  });
});

describe("P7 Manual QA polish Phase 6 Patient AI Auto", () => {
  it("persists auto mode for an entitled Pro + AI clinic", async () => {
    await expect(setPatientAiReplyMode({ mode: "auto" })).resolves.toEqual({
      success: true,
    });
    expect(mocks.setClinicAiReplyMode).toHaveBeenCalledWith(
      mocks.user.clinicId,
      "auto",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/patient-ai");
  });

  it("continues to reject auto mode when the individual entitlement is absent", async () => {
    mocks.getEntitlements.mockResolvedValue(proAiEntitlements(false));

    await expect(setPatientAiReplyMode({ mode: "auto" })).resolves.toEqual({
      error: "settings.patientAiAutoNotEntitled",
    });
    expect(mocks.setClinicAiReplyMode).not.toHaveBeenCalled();
  });
});
