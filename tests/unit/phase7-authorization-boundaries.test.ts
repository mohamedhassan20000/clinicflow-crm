import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createStaffSchema,
  updateStaffSchema,
} from "@/lib/validations/settings";

const UUID_1 = "11111111-1111-4111-8111-111111111111";

describe("Phase 7 application authorization boundaries", () => {
  it("requires at least one supervising doctor for every assistant write", () => {
    const createBase = {
      full_name: "Clinical Assistant",
      email: "assistant@example.test",
      temporary_password: "Secure123",
      role: "assistant" as const,
      department_id: null,
      phone: null,
    };
    expect(
      createStaffSchema.safeParse({
        ...createBase,
        supervising_doctor_ids: [],
      }).success,
    ).toBe(false);
    expect(
      createStaffSchema.safeParse({
        ...createBase,
        supervising_doctor_ids: [UUID_1],
      }).success,
    ).toBe(true);

    expect(
      updateStaffSchema.safeParse({
        full_name: "Clinical Assistant",
        role: "assistant",
        department_id: null,
        phone: null,
        is_active: true,
        supervising_doctor_ids: [],
      }).success,
    ).toBe(false);
  });

  it("keeps assistant dashboard and patient appointment views on non-financial branches", () => {
    const dashboard = readFileSync(
      "app/(protected)/dashboard/page.tsx",
      "utf8",
    );
    const patient = readFileSync(
      "app/(protected)/patients/[id]/page.tsx",
      "utf8",
    );
    const patientReport = readFileSync(
      "app/(protected)/patients/[id]/appointments-report/page.tsx",
      "utf8",
    );

    expect(dashboard).toContain(
      'user.role === "receptionist" || user.role === "assistant"',
    );
    expect(dashboard.indexOf('user.role === "assistant"')).toBeLessThan(
      dashboard.indexOf("// Manager"),
    );
    expect(patient).toContain("const isScopedClinical = isDoctor || isAssistant");
    expect(patient).toContain("if (!isScopedClinical)");
    expect(patientReport).toContain(
      'user.role === "doctor" || user.role === "assistant"',
    );
  });

  it("separates assistant appointment operation from trash and dismiss authority", () => {
    const appointments = readFileSync(
      "app/(protected)/appointments/page.tsx",
      "utf8",
    );
    expect(appointments).toContain("const canManageAppointmentTrash");
    expect(appointments).toContain(
      "canDismiss={canManageAppointmentTrash}",
    );
    const trashGuard = appointments.slice(
      appointments.indexOf("const canManageAppointmentTrash"),
      appointments.indexOf("const cutoff"),
    );
    expect(trashGuard).not.toContain('user.role === "assistant"');
  });

  it("fails report discovery closed when overrides cannot be read", () => {
    const permissions = readFileSync(
      "lib/server-report-permissions.ts",
      "utf8",
    );
    expect(permissions).toContain("if (error) return []");
  });
});
