import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";

vi.mock("@/contexts/clinic-settings-context", () => ({
  useClinicSettings: () => ({
    formatTime: () => "09:00",
    formatDate: () => "Thursday, 30 July 2026",
    formatCurrency: (value: number) => `${value.toFixed(2)} TRY`,
  }),
}));

vi.mock("@/components/appointments/appointment-actions", () => ({
  AppointmentActions: () => <button type="button">Complete</button>,
}));

vi.mock("@/components/appointments/replacement-chain", () => ({
  ReplacementChain: () => <section>Replacement chain</section>,
}));

vi.mock("@/components/activity/activity-timeline", () => ({
  ActivityTimeline: () => (
    <section>
      <p>Appointment completed</p>
      <p>Appointment completion undone</p>
    </section>
  ),
}));

vi.mock("@/components/appointments/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}));

vi.mock("@/actions/appointments", () => ({
  restoreAppointment: vi.fn(),
  softDeleteAppointment: vi.fn(),
}));

const restoredAppointment: AppointmentForDetail = {
  id: "appointment-1",
  patient_id: "patient-1",
  doctor_id: "doctor-1",
  scheduled_at: "2026-07-30T06:00:00.000Z",
  status: "confirmed",
  insurance_provider_id: null,
  notes: "A long appointment note that contributes to the restored dialog content.",
  duration_minutes: 30,
  package_id: "package-1",
  package_session_number: 2,
  replaces_appointment_id: "appointment-original",
  replaced_by_appointment_id: null,
  patients: {
    full_name: "Restored appointment patient",
    phone: "05551234567",
    file_number: "RESTORED-1",
  },
  profiles: { full_name: "Restored Doctor" },
  departments: { name: "General", color: "#0d9488" },
  patient_packages: {
    name: "Treatment package",
    total_sessions: 6,
    used_sessions: 2,
    price_per_session: 50,
  },
};

describe("AppointmentDetailDialog layout", () => {
  it("keeps post-undo sections inside a viewport-bounded internal scroller", () => {
    render(
      <AppointmentDetailDialog
        appointment={restoredAppointment}
        open
        onOpenChange={vi.fn()}
        canEdit
        currentUserRole="receptionist"
      />,
    );

    const dialog = screen.getByTestId("appointment-detail-dialog");
    const scroller = screen.getByTestId("appointment-detail-scroll-area");
    const header = screen
      .getByRole("heading", { name: "Restored appointment patient" })
      .closest('[data-slot="dialog-header"]');
    const footer = screen
      .getByRole("button", { name: "Complete" })
      .closest('[data-slot="dialog-footer"]');

    expect(dialog).toHaveClass(
      "flex",
      "flex-col",
      "max-h-[calc(100dvh-1rem)]",
      "sm:max-h-[calc(100dvh-2rem)]",
      "overflow-hidden",
    );
    expect(scroller).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(header).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(scroller.contains(header)).toBe(false);
    expect(scroller.contains(footer)).toBe(false);
    expect(scroller).toHaveTextContent("Replacement chain");
    expect(scroller).toHaveTextContent("Appointment completion undone");
    expect(document.body).toHaveAttribute("data-scroll-locked");
  });

  it("shows completed appointment insurance as a separate financial line", () => {
    render(
      <AppointmentDetailDialog
        appointment={{
          ...restoredAppointment,
          status: "completed",
          total_amount: 1000,
          insurance_amount: 150,
          insurance_calculation_mode: "percentage",
          insurance_percentage: 15,
          patient_responsibility: 850,
          paid_amount: 700,
          secondary_amount: 0,
          deposit_amount: 0,
          outstanding_amount: 150,
        }}
        open
        onOpenChange={vi.fn()}
        canEdit
        currentUserRole="receptionist"
      />,
    );

    expect(screen.getByText("Insurance contribution (15%)")).toBeInTheDocument();
    expect(screen.getByText("Patient responsibility")).toBeInTheDocument();
    expect(screen.getByText("Total patient paid")).toBeInTheDocument();
    expect(screen.getByText("Remaining patient balance")).toBeInTheDocument();
  });
});
