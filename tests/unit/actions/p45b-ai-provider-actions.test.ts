import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  isPrimary: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasAiProviderMode: vi.fn(),
  checkRateLimit: vi.fn(),
  getSettings: vi.fn(),
  activate: vi.fn(),
  testStored: vi.fn(),
  updatePolicy: vi.fn(),
  revoke: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithPassword: mocks.signIn, signOut: mocks.signOut } }),
}));
vi.mock("@/lib/ai/authorization", () => ({ AI_ASSISTANT_FEATURE: "ai_assistant" }));
vi.mock("@/lib/rbac", () => ({ requireMutationRole: mocks.requireMutationRole }));
vi.mock("@/lib/primary-admin", () => ({ isPrimaryClinicAdmin: mocks.isPrimary }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
  hasAiProviderMode: mocks.hasAiProviderMode,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  AiProviderConfigurationError: class AiProviderConfigurationError extends Error {},
  getAiProviderSettings: mocks.getSettings,
  activateAnthropicCredential: mocks.activate,
  testStoredAiProviderConnection: mocks.testStored,
  updateAiProviderPolicy: mocks.updatePolicy,
  revokeActiveAiProviderConnection: mocks.revoke,
}));

import {
  revokeAiProviderCredential,
  saveAiProviderCredential,
  setAiProviderMode,
  testAiProviderCredential,
} from "@/actions/ai-provider";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "primary@example.com",
  fullName: "Primary Admin",
  role: "admin" as const,
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMutationRole.mockResolvedValue(USER);
  mocks.isPrimary.mockResolvedValue(true);
  mocks.getEntitlements.mockResolvedValue({ features: { ai_assistant: true } });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasAiProviderMode.mockReturnValue(true);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.getSettings.mockResolvedValue({ mode: "managed", connection: null });
  mocks.activate.mockResolvedValue({ ok: true });
  mocks.testStored.mockResolvedValue("valid");
  mocks.updatePolicy.mockResolvedValue(undefined);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.signIn.mockResolvedValue({ data: { user: { id: USER.id } }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("P4.5B provider-management actions", () => {
  it("accepts a new key only through the primary-admin server boundary", async () => {
    const secret = "sk-ant-api03_example-secret-value";
    const result = await saveAiProviderCredential(null, form({ apiKey: secret }));

    expect(result).toEqual({ success: true, health: "valid", operation: "created" });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith("admin");
    expect(mocks.isPrimary).toHaveBeenCalledWith(USER.id, USER.clinicId);
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({
      clinicId: USER.clinicId,
      actorId: USER.id,
      secret,
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("denies a secondary admin before credential validation or storage", async () => {
    mocks.isPrimary.mockResolvedValue(false);
    const result = await saveAiProviderCredential(
      null,
      form({ apiKey: "sk-ant-api03_example-secret-value" }),
    );

    expect(result.error).toBe("aiProvider.couldNotCompleteRequest");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("requires current-password reauthentication for rotation", async () => {
    mocks.getSettings.mockResolvedValue({
      mode: "byok_strict",
      connection: { id: "existing" },
    });
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });
    const result = await saveAiProviderCredential(
      null,
      form({ apiKey: "sk-ant-api03_example-secret-value", currentPassword: "wrong" }),
    );

    expect(result.error).toBe("aiProvider.reauthenticationFailed");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("requires explicit hybrid disclosure and reauthentication", async () => {
    const missingConsent = await setAiProviderMode(
      null,
      form({ mode: "hybrid", currentPassword: password }),
    );
    expect(missingConsent.error).toBe("aiProvider.acceptHybridDisclosure");
    expect(mocks.updatePolicy).not.toHaveBeenCalled();

    const accepted = await setAiProviderMode(
      null,
      form({ mode: "hybrid", currentPassword: password, hybridAccepted: "on" }),
    );
    expect(accepted).toEqual({ success: true });
    expect(mocks.signIn).toHaveBeenCalled();
    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      clinicId: USER.clinicId,
      actorId: USER.id,
      mode: "hybrid",
      hybridAccepted: true,
    });
  });

  it("rejects a provider mode that is not included in the clinic contract", async () => {
    mocks.hasAiProviderMode.mockReturnValue(false);
    const result = await setAiProviderMode(
      null,
      form({ mode: "byok_strict", currentPassword: password }),
    );

    expect(result.error).toBe("aiProvider.modeNotIncluded");
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("rate-limits tests and reauthentication-protects revocation", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const tested = await testAiProviderCredential();
    expect(tested.error).toBe("aiProvider.tooManyRequests");
    expect(mocks.testStored).not.toHaveBeenCalled();

    mocks.signIn.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });
    const revoked = await revokeAiProviderCredential(
      null,
      form({ currentPassword: "wrong" }),
    );
    expect(revoked.error).toBe("aiProvider.reauthenticationFailed");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

const password = "current-password";
