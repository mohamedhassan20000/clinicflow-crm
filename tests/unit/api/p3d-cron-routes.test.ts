import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runReminders: vi.fn(),
  runFollowups: vi.fn(),
  runBookingExpiry: vi.fn(),
  runAlertScan: vi.fn(),
  runChannelReconcile: vi.fn(),
  runWhatsAppHealth: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/messaging/reminders", () => ({
  runAppointmentReminders: mocks.runReminders,
}));
vi.mock("@/lib/messaging/followups", () => ({
  runInvoiceFollowups: mocks.runFollowups,
}));
vi.mock("@/lib/booking/expiry", () => ({
  runAiPendingBookingExpiry: mocks.runBookingExpiry,
}));
// P6B alert scan + P6C channel-state reconciliation ride this cron as extra
// allSettled jobs; mock them so this test isolates the three core-job semantics.
vi.mock("@/lib/ops/alert-scan", () => ({
  runMessagingAlertScan: mocks.runAlertScan,
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  runChannelStateReconciliation: mocks.runChannelReconcile,
}));
vi.mock("@/lib/messaging/health", () => ({
  runWhatsAppHealthChecks: mocks.runWhatsAppHealth,
}));

import { GET as remindersGet } from "@/app/api/cron/reminders/route";

function request(authorization?: string) {
  return new Request("https://clinic.example/api/cron/reminders", {
    headers: authorization ? { authorization } : undefined,
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  mocks.runReminders.mockResolvedValue({ appointments: 1, sent: 1, failed: 0, skipped: 0 });
  mocks.runFollowups.mockResolvedValue({ due: 1, sent: 1, failed: 0, stopped: 0, skipped: 0 });
  mocks.runBookingExpiry.mockResolvedValue({ expired: 1, expiredRequests: 2 });
  mocks.runAlertScan.mockResolvedValue({ scanned: 0, alerts: 0 });
  mocks.runChannelReconcile.mockResolvedValue({ scanned: 0, transitioned: 0, failed: 0 });
  mocks.runWhatsAppHealth.mockResolvedValue({ scanned: 0, healthy: 0, degraded: 0, failed: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
});

// P5A reuses the single daily morning cron for pending-booking expiry.
describe("/api/cron/reminders (daily messaging cron)", () => {
  it("rejects a missing bearer secret without running either job", async () => {
    const response = await remindersGet(request());
    expect(response.status).toBe(401);
    expect(mocks.runReminders).not.toHaveBeenCalled();
    expect(mocks.runFollowups).not.toHaveBeenCalled();
    expect(mocks.runBookingExpiry).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer secret", async () => {
    const response = await remindersGet(request("Bearer nope"));
    expect(response.status).toBe(401);
    expect(mocks.runReminders).not.toHaveBeenCalled();
    expect(mocks.runFollowups).not.toHaveBeenCalled();
    expect(mocks.runBookingExpiry).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const response = await remindersGet(request("Bearer "));
    expect(response.status).toBe(401);
    expect(mocks.runReminders).not.toHaveBeenCalled();
    expect(mocks.runFollowups).not.toHaveBeenCalled();
    expect(mocks.runBookingExpiry).not.toHaveBeenCalled();
  });

  it("runs all jobs and reports each summary with the correct secret", async () => {
    const response = await remindersGet(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.reminders.sent).toBe(1);
    expect(body.followups.sent).toBe(1);
    expect(body.bookingExpiry.expired).toBe(1);
    expect(body.bookingExpiry.expiredRequests).toBe(2);
    expect(body.whatsappHealth.scanned).toBe(0);
    expect(mocks.runReminders).toHaveBeenCalledOnce();
    expect(mocks.runFollowups).toHaveBeenCalledOnce();
    expect(mocks.runBookingExpiry).toHaveBeenCalledOnce();
    expect(mocks.runWhatsAppHealth).toHaveBeenCalledOnce();
  });

  it("still succeeds (200) and reports to Sentry when only one job fails", async () => {
    mocks.runFollowups.mockRejectedValueOnce(new Error("dunning boom"));
    const response = await remindersGet(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.reminders.sent).toBe(1);
    expect(body.followups).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it("returns 503 only when all jobs fail", async () => {
    mocks.runReminders.mockRejectedValueOnce(new Error("boom"));
    mocks.runFollowups.mockRejectedValueOnce(new Error("boom"));
    mocks.runBookingExpiry.mockRejectedValueOnce(new Error("boom"));
    const response = await remindersGet(request("Bearer cron-secret"));
    expect(response.status).toBe(503);
    expect(mocks.captureException).toHaveBeenCalledTimes(3);
  });

  it("keeps a read-only reconciliation rejection visible without retrying successful core jobs", async () => {
    mocks.runChannelReconcile.mockRejectedValueOnce(new Error("reconcile boom"));
    const response = await remindersGet(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      reminders: { sent: 1 },
      followups: { sent: 1 },
      bookingExpiry: { expired: 1 },
      channelReconcile: null,
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "reconcile boom" }),
      { tags: { scope: "messaging-cron", job: "channel-reconcile" } },
    );
  });

  it("keeps a read-only health-scan rejection visible without retrying successful core jobs", async () => {
    mocks.runWhatsAppHealth.mockRejectedValueOnce(new Error("health boom"));
    const response = await remindersGet(request("Bearer cron-secret"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      reminders: { sent: 1 },
      followups: { sent: 1 },
      bookingExpiry: { expired: 1 },
      whatsappHealth: null,
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "health boom" }),
      { tags: { scope: "messaging-cron", job: "whatsapp-health" } },
    );
  });

  it("returns fulfilled read-only failure counts without failing the cron route", async () => {
    mocks.runChannelReconcile.mockResolvedValueOnce({
      scanned: 2,
      transitioned: 0,
      failed: 2,
    });
    mocks.runWhatsAppHealth.mockResolvedValueOnce({
      scanned: 3,
      healthy: 0,
      degraded: 0,
      failed: 3,
    });

    const response = await remindersGet(request("Bearer cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channelReconcile: { scanned: 2, failed: 2 },
      whatsappHealth: { scanned: 3, failed: 3 },
    });
  });
});
