import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("appointment calendar render performance", () => {
  it("pre-groups week appointments by date instead of filtering per cell", () => {
    const weekCalendar = source("components/appointments/week-calendar.tsx");

    expect(weekCalendar).toContain("useMemo");
    expect(weekCalendar).toContain("appointmentsByDate");
    expect(weekCalendar).not.toContain(".filter((a) => isSameDay");
  });

  it("pre-groups month appointments by date instead of filtering per cell", () => {
    const monthCalendar = source("components/appointments/month-calendar.tsx");

    expect(monthCalendar).toContain("useMemo");
    expect(monthCalendar).toContain("appointmentsByDate");
    expect(monthCalendar).not.toContain(".filter((a) => isSameDay");
  });

  it("memoizes day appointment sorting", () => {
    const dayCalendar = source("components/appointments/day-calendar.tsx");

    expect(dayCalendar).toContain("useMemo");
    expect(dayCalendar).toContain("[appointments]");
  });
});
