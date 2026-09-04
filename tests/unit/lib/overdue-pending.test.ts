import { describe, expect, it } from "vitest";
import {
  isOverduePending,
  overdueMinutes,
  overduePendingThreshold,
} from "@/lib/appointments/overdue-pending";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    scheduled_at: "2026-09-02T10:00:00.000Z",
    duration_minutes: 30,
    deleted_at: null,
    displaced_at: null,
    replaced_by_appointment_id: null,
    ...overrides,
  };
}

describe("OVERDUE_PENDING derivation", () => {
  it("uses the authoritative scheduled end and a strict passed threshold", () => {
    expect(overduePendingThreshold(appointment())).toBe(Date.parse("2026-09-02T10:30:00Z"));
    expect(isOverduePending(appointment({ scheduled_at: "2026-09-02T11:45:00Z" }), NOW)).toBe(false);
    expect(isOverduePending(appointment({ scheduled_at: "2026-09-02T11:30:00Z" }), NOW)).toBe(false);
    expect(isOverduePending(appointment(), NOW)).toBe(true);
    expect(overdueMinutes(appointment(), NOW)).toBe(90);
  });

  it.each(["confirmed", "completed", "cancelled", "no_show", "replaced"])(
    "does not derive overdue for %s",
    (status) => expect(isOverduePending(appointment({ status }), NOW)).toBe(false),
  );

  it("excludes deleted, displaced, and already-replaced rows", () => {
    expect(isOverduePending(appointment({ deleted_at: "2026-09-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isOverduePending(appointment({ displaced_at: "2026-09-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isOverduePending(appointment({ replaced_by_appointment_id: "replacement" }), NOW)).toBe(false);
  });

  it("is pure and falls back to start only when duration is invalid", () => {
    const source = appointment({ duration_minutes: null });
    const before = structuredClone(source);
    expect(isOverduePending(source, NOW)).toBe(true);
    expect(source).toEqual(before);
  });
});
