import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceAuthoringForm } from "@/components/documents/module/invoice-authoring-form";
import { PatientHistorySetupForm } from "@/components/documents/module/patient-history-setup-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/actions/document-drafts", () => ({
  saveDocumentDraft: vi.fn(async (input: { documentType: string }) => ({
    data: {
      id: "draft-1",
      previewHref: input.documentType === "INVOICE"
        ? "/appointments/invoice/document?appointmentId=appointment-1&locale=en&origin=documents&draftId=draft-1"
        : "/documents/patient-history/deposit-statement?patientId=patient-1&locale=en&preset=all&origin=documents&draftId=draft-1",
    },
  })),
}));

const invoiceLabels = {
  patient: "Patient", appointment: "Completed appointment", selectPatient: "Select patient",
  selectAppointment: "Select appointment", services: "Invoice items", service: "Service",
  unitPrice: "Unit price", quantity: "Quantity", lineTotal: "Total", total: "Invoice total",
  empty: "No records", saveDraft: "Save Draft",
};
const historyLabels = {
  patient: "Patient", selectPatient: "Select patient", period: "Period", allTime: "All time",
  lastWeek: "Last week", lastMonth: "Last month", lastYear: "Last year", custom: "Custom",
  from: "From", to: "To", saveDraft: "Save Draft", empty: "No patients",
};

describe("P7 manual document authoring", () => {
  beforeEach(() => push.mockReset());

  it("persists an Invoice draft before opening its Preview", async () => {
    render(<InvoiceAuthoringForm locale="en" currency="TRY" timeZone="UTC" labels={invoiceLabels}
      options={[{ id: "appointment-1", patientId: "patient-1", patientName: "Ada Lovelace",
        fileNumber: "P-100", scheduledAt: "2026-08-01T10:00:00.000Z", total: 17650,
        services: [{ id: "service-1", name: "Consultation", unitPrice: 17650, quantity: 1, total: 17650 }] }]} />);
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "patient-1" } });
    fireEvent.change(screen.getByLabelText("Completed appointment"), { target: { value: "appointment-1" } });
    expect(screen.getByText("Consultation")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("17,650.00");
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringContaining(
      "/appointments/invoice/document?appointmentId=appointment-1&locale=en&origin=documents",
    )));
  });

  it("persists each History & Financial draft before opening Preview", async () => {
    render(<PatientHistorySetupForm locale="en" documentType="DEPOSIT_STATEMENT"
      labels={historyLabels} patients={[{ id: "patient-1", fullName: "Ada Lovelace", fileNumber: "P-100" }]} />);
    fireEvent.change(screen.getByLabelText("Patient"), { target: { value: "patient-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(
      "/documents/patient-history/deposit-statement?patientId=patient-1&locale=en&preset=all&origin=documents&draftId=draft-1",
    ));
    expect(push).not.toHaveBeenCalledWith("/patients");
  });
});
