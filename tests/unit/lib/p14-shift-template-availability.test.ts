import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// Availability authority after P14: a bookable slot must sit inside the clinic's
// opening intervals AND inside the staff member's own schedule. Staff schedules
// now come from shift templates copied into concrete intervals, and a staff day
// may hold more than one interval.

async function loadTimeSlotsAction() {
  vi.resetModules();
  const mocks = createServerActionMocks();
  vi.doMock("@/lib/rbac", () => ({ requireRole: mocks.state.requireRole }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  const timeSlots = await import("@/actions/time-slots");
  return { ...timeSlots, mocks };
}

type Interval = { start: string; end: string };

function configure(
  mocks: Awaited<ReturnType<typeof loadTimeSlotsAction>>["mocks"],
  staffIntervals: Interval[],
  clinicIntervals: Interval[] = [{ start: "09:00", end: "22:00" }],
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
    data: staffIntervals.map((interval) => ({
      day_of_week: 1,
      start_time: interval.start,
      end_time: interval.end,
      is_enabled: true,
      valid_from: null,
      valid_until: null,
    })),
    error: null,
  };
  mocks.state.tableResults["clinic_working_hours.select"] = {
    data: clinicIntervals.map((interval) => ({
      day_of_week: 1,
      shift_start: `${interval.start}:00`,
      shift_end: `${interval.end}:00`,
    })),
    error: null,
  };
  mocks.state.tableResults["appointments.select"] = { data: [], error: null };
  mocks.state.tableResults["doctor_unavailability.select"] = { data: [], error: null };
}

// 2026-01-05 is a Monday; the fake clock sits well before the clinic opens.
const MONDAY = "2026-01-05";

describe("P14 · availability from staff shift templates", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T06:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function bookable(staff: Interval[], clinic?: Interval[]) {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configure(mocks, staff, clinic);
    const result = await getAvailableTimeSlots("doctor-1", MONDAY, 30);
    return {
      result,
      times: result.slots.filter((slot) => !slot.disabled).map((slot) => slot.time),
    };
  }

  it("Morning 09:00–17:00 exposes nothing at or after 17:00", async () => {
    const { times, result } = await bookable([{ start: "09:00", end: "17:00" }]);
    expect(result.workingHours).toEqual([{ start: "09:00", end: "17:00" }]);
    expect(times[0]).toBe("09:00");
    expect(times.at(-1)).toBe("16:30");
    expect(times.some((time) => time >= "17:00")).toBe(false);
  });

  it("Evening 15:00–22:00 exposes nothing before 15:00", async () => {
    const { times, result } = await bookable([{ start: "15:00", end: "22:00" }]);
    expect(result.workingHours).toEqual([{ start: "15:00", end: "22:00" }]);
    expect(times[0]).toBe("15:00");
    expect(times.at(-1)).toBe("21:30");
    expect(times.some((time) => time < "15:00")).toBe(false);
  });

  it("Morning + Evening becomes one union with no duplicated overlap slots", async () => {
    const { times, result } = await bookable([
      { start: "09:00", end: "17:00" },
      { start: "15:00", end: "22:00" },
    ]);
    expect(result.workingHours).toEqual([{ start: "09:00", end: "22:00" }]);
    expect(new Set(times).size).toBe(times.length);
    // The 15:00–17:00 overlap appears exactly once.
    expect(times.filter((time) => time === "15:00")).toHaveLength(1);
    expect(times.filter((time) => time === "16:45")).toHaveLength(1);
    expect(times[0]).toBe("09:00");
    expect(times.at(-1)).toBe("21:30");
  });

  it("non-overlapping templates keep the gap closed", async () => {
    const { times, result } = await bookable([
      { start: "09:00", end: "13:00" },
      { start: "16:00", end: "22:00" },
    ]);
    expect(result.workingHours).toEqual([
      { start: "09:00", end: "13:00" },
      { start: "16:00", end: "22:00" },
    ]);
    expect(times.some((time) => time >= "13:00" && time < "16:00")).toBe(false);
    expect(times).toContain("12:30");
    expect(times).toContain("16:00");
  });

  it("stays inside the clinic's opening intervals", async () => {
    // Clinic closes at 20:00 even though the staff shift runs to 22:00.
    const { times, result } = await bookable(
      [{ start: "15:00", end: "22:00" }],
      [{ start: "09:00", end: "20:00" }],
    );
    expect(result.workingHours).toEqual([{ start: "15:00", end: "20:00" }]);
    expect(times.some((time) => time >= "20:00")).toBe(false);
  });

  it("custom hours still resolve to their own window", async () => {
    const { times } = await bookable([{ start: "10:00", end: "18:00" }]);
    expect(times[0]).toBe("10:00");
    expect(times.at(-1)).toBe("17:30");
  });

  it("a day with no staff intervals is a day off", async () => {
    const { getAvailableTimeSlots, mocks } = await loadTimeSlotsAction();
    configure(mocks, [{ start: "09:00", end: "17:00" }]);
    // Tuesday: the doctor only has a Monday interval configured.
    const result = await getAvailableTimeSlots("doctor-1", "2026-01-06", 30);
    expect(result).toMatchObject({ reason: "doctor_off_weekday", slots: [] });
  });
});
