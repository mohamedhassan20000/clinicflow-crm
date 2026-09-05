import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  clearPending: vi.fn(),
  createClient: vi.fn(),
  execute: vi.fn(),
  expiresAt: vi.fn(),
  getUser: vi.fn(),
  registeredAction: vi.fn(),
  verifyPassword: vi.fn(),
  verifyTokenStepUp: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/actions/confirm", () => ({
  ActionConfirmationError: class ActionConfirmationError extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  },
  actionConfirmationExpiresAt: mocks.expiresAt,
  verifyPrivilegedActionStepUp: mocks.verifyTokenStepUp,
}));
vi.mock("@/lib/ai/actions/execute", () => ({
  executeRegisteredAction: mocks.execute,
}));
vi.mock("@/lib/ai/actions/registry", () => ({
  registeredAction: mocks.registeredAction,
}));
vi.mock("@/lib/ai/conversations", () => ({
  clearPendingActionConfirmation: mocks.clearPending,
}));
vi.mock("@/lib/auth/step-up", () => ({
  verifyCurrentPasswordStepUp: mocks.verifyPassword,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/rbac", () => ({ getAuthedUser: mocks.getUser }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { confirmAssistantAction } from "@/actions/assistant-actions";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  fullName: "Primary Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};
const INPUT = {
  conversationId: "00000000-0000-4000-8000-000000000003",
  actionId: "staff.change_role",
  input: {
    staff_id: "00000000-0000-4000-8000-000000000004",
    role: "manager",
    department_id: null,
    supervising_doctor_ids: [],
  },
  confirmToken: "phase5f-confirm-token-that-is-longer-than-forty-characters",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue(USER);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.registeredAction.mockReturnValue({ risk: "privileged" });
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.verifyTokenStepUp.mockResolvedValue("server-reauth-nonce");
  mocks.execute.mockResolvedValue({
    action_id: INPUT.actionId,
    phase: "execute",
    action_denied: true,
    confirmation_required: false,
    reason: "step_up_required",
  });
});

describe("Phase 5f privileged step-up server boundary", () => {
  it("requires a current password and carries the denial into the receipt-producing executor", async () => {
    await expect(confirmAssistantAction(INPUT)).resolves.toEqual({
      ok: false,
      reason: "step_up_required",
    });
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        privilegedPreconditionFailure: "step_up_required",
        privilegedStepUpNonce: undefined,
      }),
    );
  });

  it("fails closed on a wrong password and never marks the token stepped up", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.execute.mockResolvedValue({
      action_id: INPUT.actionId,
      phase: "execute",
      action_denied: true,
      confirmation_required: false,
      reason: "step_up_failed",
    });

    await expect(
      confirmAssistantAction({ ...INPUT, currentPassword: "WrongPassword1" }),
    ).resolves.toEqual({ ok: false, reason: "step_up_failed" });
    expect(mocks.verifyPassword).toHaveBeenCalledWith(USER, "WrongPassword1");
    expect(mocks.verifyTokenStepUp).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ privilegedPreconditionFailure: "step_up_failed" }),
    );
  });

  it("passes only a server nonce to execution and never includes the password in action input", async () => {
    mocks.execute.mockResolvedValue({
      action_id: INPUT.actionId,
      phase: "execute",
      risk_class: "privileged",
      confirmation_required: false,
      executed: true,
      result: { summary: "Staff role changed." },
    });
    mocks.createClient.mockResolvedValue({ from: vi.fn() });
    mocks.expiresAt.mockReturnValue("2099-08-14T12:02:00.000Z");

    const result = await confirmAssistantAction({
      ...INPUT,
      currentPassword: "CurrentPassword123",
    });

    expect(result.ok).toBe(true);
    expect(mocks.verifyTokenStepUp).toHaveBeenCalledWith({
      token: INPUT.confirmToken,
      userId: USER.id,
      clinicId: USER.clinicId,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actionInput: INPUT.input,
        privilegedStepUpNonce: "server-reauth-nonce",
        privilegedPreconditionFailure: undefined,
      }),
    );
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain(
      "CurrentPassword123",
    );
  });

  it("rate-limits password attempts before credential verification", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    mocks.execute.mockResolvedValue({
      action_id: INPUT.actionId,
      phase: "execute",
      action_denied: true,
      confirmation_required: false,
      reason: "privileged_rate_limited",
    });

    await expect(
      confirmAssistantAction({ ...INPUT, currentPassword: "CurrentPassword123" }),
    ).resolves.toEqual({ ok: false, reason: "privileged_rate_limited" });
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });
});
