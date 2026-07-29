import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AppointmentPaymentRow,
  type AppointmentPaymentRowData,
} from "@/components/patients/appointment-payment-row";
import { AppointmentsReportList } from "@/components/patients/appointments-report-list";

vi.mock("@/components/appointments/send-invoice-button", () => ({
  SendInvoiceButton: () => <button type="button">Send invoice</button>,
}));

const appointment: AppointmentPaymentRowData = {
  id: "appointment-1",
  scheduled_at: "2026-07-29T09:00:00.000Z",
  status: "completed",
  paid_at: "2026-07-29T09:30:00.000Z",
  total_amount: 1000,
  paid_amount: 600,
  insurance_amount: 150,
  insurance_calculation_mode: "percentage",
  insurance_percentage: 15,
  patient_responsibility: 850,
  secondary_amount: 100,
  deposit_amount: 0,
  outstanding_amount: 150,
  payment_method: "cash",
  secondary_payment_method: "credit_card",
  payment_note: null,
  profiles: { full_name: "Doctor One" },
  departments: { name: "General", color: "#0891b2" },
  insurance_providers: { name: "Acme Insurance" },
  appointment_services: [
    { id: "line-1", name: "Consultation", price: 1000, quantity: 1 },
  ],
};

describe("saved and printable appointment insurance display", () => {
  it("shows insurance, responsibility, both patient payments, and remaining balance", async () => {
    const user = userEvent.setup();
    render(<AppointmentPaymentRow a={appointment} />);

    await user.click(screen.getByRole("button", { name: /Jul 29, 2026/i }));

    expect(screen.getByText("Insurance contribution")).toBeInTheDocument();
    expect(screen.getByText("Patient responsibility")).toBeInTheDocument();
    expect(screen.getByText("Primary payment")).toBeInTheDocument();
    expect(screen.getByText("Secondary payment")).toBeInTheDocument();
    expect(screen.getByText("Total patient paid")).toBeInTheDocument();
    expect(screen.getByText("Remaining patient balance")).toBeInTheDocument();
    expect(screen.getByText("Acme Insurance")).toBeInTheDocument();
    expect(screen.getByText("(15%)")).toBeInTheDocument();
  });

  it("keeps insurance separate from patient-paid totals in the print table", () => {
    render(
      <AppointmentsReportList
        appointments={[appointment]}
        settlementsByAppt={{}}
      />,
    );

    expect(screen.getByText("Insurance contribution")).toBeInTheDocument();
    expect(screen.getByText("Patient responsibility")).toBeInTheDocument();
    expect(screen.getByText("Total patient paid")).toBeInTheDocument();
    expect(screen.getByText("Remaining patient balance")).toBeInTheDocument();
  });
});
