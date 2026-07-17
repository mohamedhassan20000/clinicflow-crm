import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitRows: vi.fn(),
  captureException: vi.fn(),
  members: { data: [] as unknown[], error: null as unknown },
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/supabase/admin", () => ({
  emitClinicNotificationRows: mocks.emitRows,
  createClinicScopedAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is"]) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) => resolve(mocks.members);
      return chain;
    },
  }),
}));

import {
  emitClinicNotification,
  notificationDedupeKey,
} from "@/lib/notifications/emit";

const clinicId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.members = { data: [], error: null };
  mocks.emitRows.mockResolvedValue({ data: 1, error: null });
});

describe("notificationDedupeKey", () => {
  it("is stable regardless of dedupeData key order", () => {
    const a = notificationDedupeKey({
      type: "reminder_failed",
      link: "/appointments",
      dedupeData: { appointmentId: "x", step: "1" },
    });
    const b = notificationDedupeKey({
      type: "reminder_failed",
      link: "/appointments",
      dedupeData: { step: "1", appointmentId: "x" },
    });
    expect(a).toBe(b);
  });

  it("separates different types, links, and data", () => {
    const keys = new Set([
      notificationDedupeKey({ type: "reminder_failed", link: "/a" }),
      notificationDedupeKey({ type: "followup_failed", link: "/a" }),
      notificationDedupeKey({ type: "reminder_failed", link: "/b" }),
      notificationDedupeKey({ type: "reminder_failed", link: "/a", dedupeData: { id: "1" } }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("emitClinicNotification", () => {
  it("passes a dedupe key to the atomic RPC when dedupeUnread is set", async () => {
    const result = await emitClinicNotification({
      clinicId,
      type: "reminder_failed",
      link: "/appointments",
      recipientIds: ["r1"],
      dedupeUnread: true,
      dedupeData: { appointmentId: "appt-1" },
    });
    expect(result).toEqual({ created: 1 });
    expect(mocks.emitRows).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId,
        recipientIds: ["r1"],
        type: "reminder_failed",
        dedupeKey: "reminder_failed|/appointments|appointmentId=appt-1",
      }),
    );
  });

  it("emits without a dedupe key when dedupeUnread is not set", async () => {
    await emitClinicNotification({
      clinicId,
      type: "inbox_message",
      link: "/inbox",
      recipientIds: ["r1"],
    });
    expect(mocks.emitRows).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: null }),
    );
  });

  it("resolves role fan-out to concrete recipient rows", async () => {
    mocks.members = { data: [{ id: "a" }, { id: "b" }], error: null };
    await emitClinicNotification({
      clinicId,
      type: "inbox_message",
      link: "/inbox",
      roles: ["admin", "receptionist"],
    });
    expect(mocks.emitRows).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIds: ["a", "b"] }),
    );
  });

  it("never throws — a failed emit is swallowed and reported", async () => {
    mocks.emitRows.mockResolvedValue({ data: null, error: { message: "boom" } });
    const result = await emitClinicNotification({
      clinicId,
      type: "reminder_failed",
      link: "/appointments",
      recipientIds: ["r1"],
    });
    expect(result).toEqual({ created: 0 });
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
