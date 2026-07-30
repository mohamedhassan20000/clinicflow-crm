import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T06:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function configureWorkingMonday(
    mocks: Awaited<ReturnType<typeof loadTimeSlotsAction>>["mocks"],
  ) {
    mocks.state.tableResults["clinics.select"] = {
      data: { timezone: "Europe/Istanbul" },
      error: null,
    };
    mocks.state.tableResults["profiles.select"] = {
      data: {
        id: "doctor-1",
        full_name: "Dr Ahmed",
        is_active: true,
        is_deleted: false,
        deleted_at: null,
      },
      error: null,
    };
    mocks.state.tableResults["doctor_schedules.select"] = {
      data: [{
        day_of_week: 1,
        start_time: "09:00",
        end_time: "10:00",
        is_enabled: true,
        valid_from: null,
        valid_until: null,
      }],
      error: null,
    };
    mocks.state.tableResults["clinic_working_hours.select"] = {
      data: [{
        day_of_week: 1,
        shift_start: "09:00:00",
        shift_end: "10:00:00",
      }],
      error: null,
    };
    mocks.state.tableResults["appointments.select"] = {
      data: [],
      error: null,
    };
    mocks.state.tableResults["doctor_unavailability.select"] = {
      data: [],
      error: null,
    };
  }

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

  it("allows every role that can open and submit the booking form", async () => {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configureWorkingMonday(mocks);

    await getAvailableTimeSlots("doctor-1", "2026-01-05");

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
      "manager",
      "assistant",
    ]);
  });

  it("keeps assistant availability inside the supervised-doctor scope", async () => {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configureWorkingMonday(mocks);
    Object.assign(mocks.state.authedUser, { role: "assistant" });
    mocks.state.rpcResults.auth_supervised_doctor_ids = {
      data: ["another-doctor"],
      error: null,
    };

    const result = await getAvailableTimeSlots("doctor-1", "2026-01-05");

    expect(result).toMatchObject({ reason: "doctor_not_found", slots: [] });
    expect(
      mocks.state.queryLog.some((entry) => entry.table === "profiles"),
    ).toBe(false);
  });

  it("returns duration-aware slots and configured hours", async () => {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configureWorkingMonday(mocks);

    const thirty = await getAvailableTimeSlots("doctor-1", "2026-01-05", 30);
    const sixty = await getAvailableTimeSlots("doctor-1", "2026-01-05", 60);

    expect(thirty.reason).toBe("available");
    expect(thirty.slots.filter((slot) => !slot.disabled).map((slot) => slot.time))
      .toEqual(["09:00", "09:15", "09:30"]);
    expect(thirty.workingHours).toEqual([{ start: "09:00", end: "10:00" }]);
    expect(sixty.slots.filter((slot) => !slot.disabled).map((slot) => slot.time))
      .toEqual(["09:00"]);
  });

  it("reports when today's configured working hours have passed", async () => {
    vi.setSystemTime(new Date("2026-01-05T09:00:00.000Z")); // 12:00 Istanbul
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configureWorkingMonday(mocks);

    const result = await getAvailableTimeSlots("doctor-1", "2026-01-05", 30);

    expect(result).toMatchObject({
      reason: "working_hours_passed",
      workingHours: [{ start: "09:00", end: "10:00" }],
    });
  });

  it("distinguishes an unconfigured doctor from a weekday off", async () => {
    const first = await loadTimeSlotsAction();
    configureWorkingMonday(first.mocks);
    first.mocks.state.tableResults["doctor_schedules.select"] = {
      data: [],
      error: null,
    };
    await expect(first.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "no_schedule_configured", slots: [] });

    const second = await loadTimeSlotsAction();
    configureWorkingMonday(second.mocks);
    second.mocks.state.tableResults["doctor_schedules.select"] = {
      data: [{
        day_of_week: 2,
        start_time: "09:00",
        end_time: "10:00",
        is_enabled: true,
        valid_from: null,
        valid_until: null,
      }],
      error: null,
    };
    await expect(second.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "doctor_off_weekday", slots: [] });
  });

  it("reports disabled schedules, clinic closure, and date ranges", async () => {
    const disabled = await loadTimeSlotsAction();
    configureWorkingMonday(disabled.mocks);
    disabled.mocks.state.tableResults["doctor_schedules.select"] = {
      data: [{
        day_of_week: 1,
        start_time: "09:00",
        end_time: "10:00",
        is_enabled: false,
        valid_from: null,
        valid_until: null,
      }],
      error: null,
    };
    await expect(disabled.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "schedule_disabled" });

    const closed = await loadTimeSlotsAction();
    configureWorkingMonday(closed.mocks);
    closed.mocks.state.tableResults["clinic_working_hours.select"] = {
      data: [{
        day_of_week: 2,
        shift_start: "09:00",
        shift_end: "10:00",
      }],
      error: null,
    };
    await expect(closed.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "clinic_closed" });

    const range = await loadTimeSlotsAction();
    configureWorkingMonday(range.mocks);
    range.mocks.state.tableResults["doctor_schedules.select"] = {
      data: [{
        day_of_week: 1,
        start_time: "09:00",
        end_time: "10:00",
        is_enabled: true,
        valid_from: "2026-02-01",
        valid_until: null,
      }],
      error: null,
    };
    await expect(range.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "outside_schedule_range" });
  });

  it("distinguishes leave, booked slots, and blocked slots", async () => {
    const leave = await loadTimeSlotsAction();
    configureWorkingMonday(leave.mocks);
    leave.mocks.state.tableResults["doctor_unavailability.select"] = {
      data: [{
        starts_at: "2026-01-04T21:00:00.000Z",
        ends_at: "2026-01-05T20:59:59.999Z",
        kind: "leave",
      }],
      error: null,
    };
    await expect(leave.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "on_leave" });

    const booked = await loadTimeSlotsAction();
    configureWorkingMonday(booked.mocks);
    booked.mocks.state.tableResults["appointments.select"] = {
      data: [{
        id: "appointment-1",
        scheduled_at: "2026-01-05T06:00:00.000Z",
        duration_minutes: 30,
        status: "confirmed",
      }],
      error: null,
    };
    await expect(booked.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "all_slots_booked" });

    const blocked = await loadTimeSlotsAction();
    configureWorkingMonday(blocked.mocks);
    blocked.mocks.state.tableResults["doctor_unavailability.select"] = {
      data: [{
        starts_at: "2026-01-05T06:00:00.000Z",
        ends_at: "2026-01-05T07:00:00.000Z",
        kind: "blocked",
      }],
      error: null,
    };
    await expect(blocked.getAvailableTimeSlots("doctor-1", "2026-01-05"))
      .resolves.toMatchObject({ reason: "all_slots_blocked" });
  });
});
