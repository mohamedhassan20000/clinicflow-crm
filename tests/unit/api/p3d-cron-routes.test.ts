import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runReminders: vi.fn(),
  runFollowups: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/messaging/reminders", () => ({
  runAppointmentReminders: mocks.runReminders,
}));
vi.mock("@/lib/messaging/followups", () => ({
  runInvoiceFollowups: mocks.runFollowups,
}));

import { GET as remindersGet } from "@/app/api/cron/reminders/route";
import { GET as followupsGet } from "@/app/api/cron/invoice-followups/route";

function request(authorization?: string) {
  return new Request("https://clinic.example/api/cron/x", {
    headers: authorization ? { authorization } : undefined,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  mocks.runReminders.mockResolvedValue({ appointments: 1, sent: 1, failed: 0, skipped: 0 });
  mocks.runFollowups.mockResolvedValue({ due: 1, sent: 1, failed: 0, stopped: 0, skipped: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
});

describe.each([
  ["reminders", () => remindersGet, mocks.runReminders],
  ["invoice-followups", () => followupsGet, mocks.runFollowups],
] as const)("/api/cron/%s", (_name, handler, runner) => {
  it("rejects a missing bearer secret without running", async () => {
    const response = await handler()(request());
    expect(response.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer secret", async () => {
    const response = await handler()(request("Bearer nope"));
    expect(response.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const response = await handler()(request("Bearer "));
    expect(response.status).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs and reports the summary with the correct secret", async () => {
    const response = await handler()(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("returns 503 and reports to Sentry when the run throws", async () => {
    runner.mockRejectedValueOnce(new Error("boom"));
    const response = await handler()(request("Bearer cron-secret"));
    expect(response.status).toBe(503);
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });
});
