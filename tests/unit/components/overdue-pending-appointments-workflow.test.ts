import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const section = readFileSync(
  "components/dashboard/overdue-pending-appointments-section.tsx", "utf8",
);
const list = readFileSync(
  "components/dashboard/overdue-pending-appointments-list.tsx", "utf8",
);
const actions = readFileSync("components/appointments/appointment-actions.tsx", "utf8");

describe("overdue pending appointments workflow", () => {
  it("queries a read-only pending superset and derives the end-time condition", () => {
    expect(section).toContain('.eq("status", "pending")');
    expect(section).toContain("isOverduePending(appointment, now)");
    expect(section).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });

  it("shows patient, doctor, time, current state, and existing actions", () => {
    expect(list).toContain("appointment.patientName");
    expect(list).toContain("appointment.doctorName");
    expect(list).toContain("formatDate(appointment.scheduledAt)");
    expect(list).toContain("overduePending");
    expect(list).toContain("<AppointmentActions");
  });

  it("exposes cancel, no-show, and replacement without confirming overdue rows", () => {
    expect(actions).toContain("effectiveStatus === \"pending\" && !overduePending");
    expect(actions).toContain("overduePending && effectiveStatus === \"pending\"");
    expect(actions).toContain("new Date(scheduledAt) > new Date() || overduePending");
    expect(actions).toContain("<CancelAppointmentDialog");
    expect(actions).toContain("<NoShowDialog");
    expect(actions).toContain("<ReplaceAppointmentDialog");
  });

  it("removes a reviewed row from the derived client collection after success", () => {
    expect(list).toContain("onActionComplete={() => setRemoved");
    expect(list).toContain("!removed.includes(appointment.id)");
  });
});
