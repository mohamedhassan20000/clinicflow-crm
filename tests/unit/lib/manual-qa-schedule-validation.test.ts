import { describe, expect, it } from "vitest";
import {
  canonicalClock,
  clinicShiftsOverlap,
  clockMinutes,
  validateStaffInterval,
} from "@/lib/scheduling/clock";
import { clinicDayScheduleSchema } from "@/lib/validations/settings";

describe("manual QA · clinic/staff schedule boundaries", () => {
  const split = [
    { shift_start: "09:00:00", shift_end: "14:00:00" },
    { shift_start: "16:00:00", shift_end: "22:00:00" },
  ];

  it("normalizes HH:mm and HH:mm:ss before comparing exact boundaries", () => {
    expect(clockMinutes("22:00")).toBe(clockMinutes("22:00:00"));
    expect(canonicalClock("09:00:00")).toBe("09:00");
    expect(validateStaffInterval("09:00", "22:00", split)).toMatchObject({
      ok: true,
      start: "09:00",
      end: "22:00",
    });
    expect(validateStaffInterval("16:00", "22:00", split).ok).toBe(true);
  });

  it("rejects outside and gap-only staff intervals", () => {
    expect(validateStaffInterval("08:59", "14:00", split)).toMatchObject({
      ok: false,
      reason: "outside_clinic_hours",
    });
    expect(validateStaffInterval("14:30", "15:30", split)).toMatchObject({
      ok: false,
      reason: "outside_clinic_hours",
    });
    expect(validateStaffInterval("16:00", "22:01", split)).toMatchObject({
      ok: false,
      reason: "outside_clinic_hours",
    });
  });

  // P14: staff shifts are no longer derived from clinic opening intervals.
  // Template selection and its concrete-hours resolution are covered by
  // tests/unit/lib/p14-shift-templates.test.ts.

  it("allows touching shifts but rejects overlapping clinic shifts", () => {
    expect(clinicShiftsOverlap([
      { shift_start: "09:00", shift_end: "14:00" },
      { shift_start: "14:00", shift_end: "18:00" },
    ])).toBe(false);
    expect(clinicDayScheduleSchema.safeParse({
      day_of_week: 1,
      open: true,
      shifts: [
        { shift_start: "09:00", shift_end: "14:00" },
        { shift_start: "13:59", shift_end: "18:00" },
      ],
    }).success).toBe(false);
  });
});
