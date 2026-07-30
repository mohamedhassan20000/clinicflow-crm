import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  CALENDAR_APPOINTMENT_FINANCIAL_SELECT,
  CALENDAR_APPOINTMENT_SELECT,
  CALENDAR_APPOINTMENT_STATUSES,
  calendarDateKey,
  calendarMinutes,
  getAppointmentCalendarRange,
  mergeCalendarFinancialRows,
  resolveCalendarScopeFilters,
  startOfCalendarWeek,
  toCalendarEventPlacement,
  type CalendarFinancialRow,
} from "@/lib/appointments/calendar";

const baseAppointment = {
  id: "11111111-1111-4111-8111-111111111111",
  clinic_id: "22222222-2222-4222-8222-222222222222",
  doctor_id: "33333333-3333-4333-8333-333333333333",
  patient_id: "44444444-4444-4444-8444-444444444444",
  scheduled_at: "2026-07-29T06:15:00.000Z",
  duration_minutes: 30,
  status: "pending",
};

describe("appointment calendar data path", () => {
  it("keeps all valid statuses visible unless a filter is explicitly applied", () => {
    expect(CALENDAR_APPOINTMENT_STATUSES).toEqual([
      "pending",
      "confirmed",
      "arrived",
      "in_session",
      "completed",
      "cancelled",
      "no_show",
      "replaced",
    ]);
  });

  it("keeps optional billing fields out of the primary rendering query", () => {
    expect(CALENDAR_APPOINTMENT_SELECT).toContain("scheduled_at");
    expect(CALENDAR_APPOINTMENT_SELECT).toContain("patients(full_name");
    expect(CALENDAR_APPOINTMENT_SELECT).not.toContain(
      "insurance_calculation_mode",
    );
    expect(CALENDAR_APPOINTMENT_FINANCIAL_SELECT).toContain(
      "insurance_calculation_mode",
    );
  });

  it.each(["admin", "manager", "receptionist"] as const)(
    "accepts only valid explicit clinic filters for %s",
    (role) => {
      expect(
        resolveCalendarScopeFilters({
          role,
          userId: "staff-1",
          doctorParam: "doctor-1",
          departmentParam: "department-1",
          doctors: [{ id: "doctor-1" }],
          departments: [{ id: "department-1" }],
        }),
      ).toEqual({
        doctorId: "doctor-1",
        departmentId: "department-1",
      });
      expect(
        resolveCalendarScopeFilters({
          role,
          userId: "staff-1",
          doctorParam: "stale-doctor",
          departmentParam: "stale-department",
          doctors: [{ id: "doctor-1" }],
          departments: [{ id: "department-1" }],
        }),
      ).toEqual({
        doctorId: undefined,
        departmentId: undefined,
      });
    },
  );

  it("keeps doctor and assistant filtering aligned with their RLS scopes", () => {
    expect(
      resolveCalendarScopeFilters({
        role: "doctor",
        userId: "doctor-1",
        doctorParam: "doctor-2",
        departmentParam: "department-2",
        doctors: [{ id: "doctor-2" }],
        departments: [{ id: "department-2" }],
      }),
    ).toEqual({ doctorId: "doctor-1", departmentId: undefined });

    expect(
      resolveCalendarScopeFilters({
        role: "assistant",
        userId: "assistant-1",
        doctorParam: "stale-hidden-doctor",
        departmentParam: "stale-hidden-department",
        doctors: [],
        departments: [],
      }),
    ).toEqual({ doctorId: undefined, departmentId: undefined });
  });

  it("builds the selected day range from clinic midnight, not server midnight", () => {
    const range = getAppointmentCalendarRange({
      view: "day",
      day: "2026-07-29",
      timeZone: "Europe/Istanbul",
      weekStartsOn: 1,
    });

    expect(range).toMatchObject({
      dayAnchor: "2026-07-29",
      rangeStartDate: "2026-07-29",
      rangeEndDate: "2026-07-30",
      rangeStartIso: "2026-07-28T21:00:00.000Z",
      rangeEndIso: "2026-07-29T21:00:00.000Z",
    });
  });

  it("keeps the full clinic-local day across a daylight-saving transition", () => {
    const range = getAppointmentCalendarRange({
      view: "day",
      day: "2026-03-08",
      timeZone: "America/New_York",
      weekStartsOn: 0,
    });

    expect(range.rangeStartIso).toBe("2026-03-08T05:00:00.000Z");
    expect(range.rangeEndIso).toBe("2026-03-09T04:00:00.000Z");
  });

  it("builds stable week and month grid ranges from plain calendar dates", () => {
    expect(startOfCalendarWeek("2026-07-29", 1)).toBe("2026-07-27");
    expect(addCalendarDays("2026-07-29", 7)).toBe("2026-08-05");

    const month = getAppointmentCalendarRange({
      view: "month",
      month: "2026-08",
      timeZone: "Europe/Istanbul",
      weekStartsOn: 1,
    });
    expect(month.monthStart).toBe("2026-08-01");
    expect(month.rangeStartDate).toBe("2026-07-27");
    expect(month.rangeEndDate).toBe("2026-09-07");
  });

  it("maps an appointment to the clinic-local date and time", () => {
    const instant = "2026-07-28T21:30:00.000Z";

    expect(calendarDateKey(instant, "Europe/Istanbul")).toBe("2026-07-29");
    expect(calendarMinutes(instant, "Europe/Istanbul")).toBe(30);
    expect(calendarDateKey(instant, "America/Los_Angeles")).toBe("2026-07-28");
  });

  it("creates the exact frontend event placement used by the calendar", () => {
    expect(
      toCalendarEventPlacement(baseAppointment, "Europe/Istanbul"),
    ).toEqual({
      date: "2026-07-29",
      startMinutes: 9 * 60 + 15,
      endMinutes: 9 * 60 + 45,
    });
  });

  it("keeps every base appointment when optional financial enrichment fails", () => {
    expect(mergeCalendarFinancialRows([baseAppointment], null)).toEqual([
      baseAppointment,
    ]);
  });

  it("merges financial detail by appointment id without changing the event fields", () => {
    const financial: CalendarFinancialRow = {
      id: baseAppointment.id,
      total_amount: 100,
      insurance_amount: 20,
      insurance_calculation_mode: "amount",
      insurance_percentage: null,
      patient_responsibility: 80,
      paid_amount: 50,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: 30,
    };

    expect(mergeCalendarFinancialRows([baseAppointment], [financial])).toEqual([
      { ...baseAppointment, ...financial },
    ]);
  });
});
