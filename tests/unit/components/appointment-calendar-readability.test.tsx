import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CalendarNowIndicator,
  getCalendarGridBounds,
  getCalendarNonWorkingBands,
  minutesInClinicTimeZone,
} from "@/components/appointments/calendar-visuals";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";

const clinicHours = [
  {
    day_of_week: 1,
    open: true,
    shifts: [
      { shift_start: "09:00", shift_end: "12:00" },
      { shift_start: "13:00", shift_end: "17:00" },
    ],
  },
  {
    day_of_week: 2,
    open: true,
    shifts: [{ shift_start: "08:00", shift_end: "18:00" }],
  },
] satisfies ClinicWorkingHoursValues;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("WS5 appointment calendar readability", () => {
  it("derives opening, break, and closing bands without changing slot availability", () => {
    const bounds = getCalendarGridBounds(clinicHours);
    expect(bounds).toEqual({ startMin: 8 * 60, endMin: 18 * 60 });
    expect(getCalendarNonWorkingBands(clinicHours, 1, bounds)).toEqual([
      { startMin: 8 * 60, endMin: 9 * 60, kind: "non-working", label: "non-working" },
      { startMin: 12 * 60, endMin: 13 * 60, kind: "break", label: "break" },
      { startMin: 17 * 60, endMin: 18 * 60, kind: "non-working", label: "non-working" },
    ]);
  });

  it("keeps the historical open fallback when no working-hours rows exist", () => {
    const bounds = getCalendarGridBounds([]);
    expect(bounds).toEqual({ startMin: 8 * 60, endMin: 18 * 60 });
    expect(getCalendarNonWorkingBands([], 1, bounds)).toEqual([]);
  });

  it("marks configured closed days without touching booking logic", () => {
    const bounds = getCalendarGridBounds(clinicHours);
    expect(getCalendarNonWorkingBands(clinicHours, 3, bounds)).toEqual([
      { startMin: 8 * 60, endMin: 18 * 60, kind: "closed", label: "closed" },
    ]);
  });

  it("keeps current-time placement in the existing clinic timezone", () => {
    expect(minutesInClinicTimeZone(new Date("2026-07-13T09:30:00.000Z"))).toBe(12 * 60 + 30);
  });

  it("renders an accessible, testable current-time indicator", () => {
    render(<CalendarNowIndicator top={264} label="Current time, 12:30" />);
    const line = screen.getByRole("separator", { name: "Current time, 12:30" });
    expect(line).toHaveAttribute("data-calendar-now-indicator");
    expect(line).toHaveStyle({ top: "264px" });
  });

  it("routes all three views through the shared visual system", () => {
    for (const file of ["week-calendar.tsx", "day-calendar.tsx", "month-calendar.tsx"]) {
      const calendar = source(`components/appointments/${file}`);
      expect(calendar).toContain("CALENDAR_STYLES");
      expect(calendar).toContain("data-calendar-view");
      expect(calendar).toContain("data-calendar-grid");
      expect(calendar).not.toContain("text-muted-foreground/50");
      expect(calendar).not.toContain("border-border/20");
    }
  });

  it("exposes a clear selected time-slot state in the create flow", () => {
    const form = source("components/appointments/appointment-form.tsx");
    expect(form).toContain("data-calendar-slot-selected");
    expect(form).toContain("selectedSlotTrigger");
    expect(form).toContain("selectedSlotItem");
  });
});
