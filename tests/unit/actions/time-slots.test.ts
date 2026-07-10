import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

async function loadTimeSlotsAction() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const timeSlots = await import("@/actions/time-slots");
  return { ...timeSlots, mocks };
}

describe("getAvailableTimeSlots", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the clinic timezone for appointment day bounds", async () => {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    mocks.state.tableResults["clinics.select"] = {
      data: { timezone: "America/New_York" },
      error: null,
    };
    mocks.state.tableResults["doctor_schedules.select"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["clinic_working_hours.select"] = {
      data: [{ shift_start: "09:00:00", shift_end: "10:00:00" }],
      error: null,
    };
    mocks.state.tableResults["appointments.select"] = {
      data: [],
      error: null,
    };

    await getAvailableTimeSlots("doctor-1", "2026-01-01");

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["gte", "scheduled_at", "2026-01-01T05:00:00.000Z"],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["lte", "scheduled_at", "2026-01-02T04:59:59.999Z"],
      }),
    );
  });
});
