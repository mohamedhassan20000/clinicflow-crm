import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertAccess: vi.fn(),
  rateLimit: vi.fn(),
  resolveMount: vi.fn(),
  confirm: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));
vi.mock("@/lib/ai/authorization", () => ({
  authorizeStaffAssistant: mocks.authorize,
  assertWorkflowAccess: mocks.assertAccess,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/ai/tools", () => ({
  resolveWorkflowStepMount: mocks.resolveMount,
}));
vi.mock("@/lib/ai/workflows/executor", () => ({
  confirmOrResumeWorkflow: mocks.confirm,
}));

import { confirmAssistantWorkflow } from "@/actions/assistant-workflows";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  role: "admin" as const,
};
const INPUT = {
  runId: "00000000-0000-4000-8000-000000000099",
  plan: {
    version: 1 as const,
    steps: [
      {
        id: "notify",
        tool: "send_appointment_reminders",
        input: {
          appointments: [
            { id: "00000000-0000-4000-8000-000000000020" },
          ],
        },
        depends_on: [],
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(USER);
  mocks.assertAccess.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.resolveMount.mockResolvedValue({ definitions: [], tools: {} });
  mocks.confirm.mockResolvedValue(null);
});

describe("P4.11 comprehensive confirmation failure mapping", () => {
  it("keeps authorization failures distinct from infrastructure failures", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new AiToolAuthorizationError("page_hidden"),
    );
    await expect(confirmAssistantWorkflow(INPUT)).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
    expect(mocks.captureException).not.toHaveBeenCalled();

    const failure = new Error("database unavailable");
    mocks.confirm.mockRejectedValueOnce(failure);
    await expect(confirmAssistantWorkflow(INPUT)).resolves.toEqual({
      ok: false,
      reason: "internal_error",
    });
    expect(mocks.captureException).toHaveBeenCalledWith(failure, {
      tags: { area: "assistant-workflow-confirmation" },
    });
  });
});
