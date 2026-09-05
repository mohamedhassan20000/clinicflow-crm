import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionExecuteSuccess } from "@/lib/ai/actions/types";
import type { AuthedUser } from "@/lib/rbac";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  checkRateLimit: vi.fn(),
  clearPendingActionConfirmation: vi.fn(),
  createClient: vi.fn(),
  executeRegisteredAction: vi.fn(),
  expiresAt: vi.fn(),
  getAuthedUser: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));
vi.mock("@/lib/ai/actions/confirm", () => ({
  actionConfirmationExpiresAt: mocks.expiresAt,
}));
vi.mock("@/lib/ai/actions/execute", () => ({
  executeRegisteredAction: mocks.executeRegisteredAction,
}));
vi.mock("@/lib/ai/conversations", () => ({
  clearPendingActionConfirmation: mocks.clearPendingActionConfirmation,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/rbac", () => ({
  getAuthedUser: mocks.getAuthedUser,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { confirmAssistantAction } from "@/actions/assistant-actions";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  fullName: "Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const ACTION_ID = "appointments.send_reminders";
const CONFIRM_TOKEN = "server-confirm-token-that-is-longer-than-forty-characters";
const EXPIRES_AT = "2099-08-13T12:10:00.000Z";
const EXECUTED: ActionExecuteSuccess = {
  action_id: ACTION_ID,
  phase: "execute",
  risk_class: "bulk",
  confirmation_required: false,
  executed: true,
  result: { summary: "Sent reminders" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthedUser.mockResolvedValue(USER);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.createClient.mockResolvedValue({ from: vi.fn() });
  mocks.expiresAt.mockReturnValue(EXPIRES_AT);
  mocks.clearPendingActionConfirmation.mockResolvedValue(undefined);
});

describe("Phase 4 confirmation context cleanup", () => {
  it("clears the exact pending confirmation after successful execution", async () => {
    mocks.executeRegisteredAction.mockResolvedValue(EXECUTED);

    await expect(confirmAssistantAction({
      conversationId: CONVERSATION_ID,
      actionId: ACTION_ID,
      input: { appointment_ids: [] },
      confirmToken: CONFIRM_TOKEN,
    })).resolves.toEqual({ ok: true, result: EXECUTED });

    expect(mocks.clearPendingActionConfirmation).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: ACTION_ID,
      expiresAt: EXPIRES_AT,
    });
  });

  it("does not change pending context when confirmation execution is denied", async () => {
    mocks.executeRegisteredAction.mockResolvedValue({
      action_id: ACTION_ID,
      phase: "execute",
      action_denied: true,
      confirmation_required: false,
      reason: "confirmation_expired",
    });

    await expect(confirmAssistantAction({
      conversationId: CONVERSATION_ID,
      actionId: ACTION_ID,
      input: { appointment_ids: [] },
      confirmToken: CONFIRM_TOKEN,
    })).resolves.toEqual({ ok: false, reason: "confirmation_expired" });

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.clearPendingActionConfirmation).not.toHaveBeenCalled();
  });
});
