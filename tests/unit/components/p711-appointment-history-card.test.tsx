import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AppointmentHistoryCard,
  type AppointmentHistoryCardData,
} from "@/components/patients/file/appointment-history-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// The financial billing row pulls in the invoice send action; stub it so the
// non-scoped path renders in isolation.
vi.mock("@/components/appointments/send-invoice-button", () => ({
  SendInvoiceButton: () => null,
}));
vi.mock("@/components/patients/note-composer", () => ({
  NoteComposer: ({ patientId, appointmentId }: { patientId: string; appointmentId: string }) => (
    <div data-testid="note-composer" data-patient-id={patientId} data-appointment-id={appointmentId} />
  ),
}));

const DOC_LABELS = { PRESCRIPTION: "Prescription", INVOICE: "Invoice" };

function makeEntry(
  overrides: Partial<AppointmentHistoryCardData> = {},
): AppointmentHistoryCardData {
  return {
    appointment: {
      id: "a1",
      scheduled_at: "2026-05-10T09:00:00.000Z",
      status: "completed",
      total_amount: 250,
      paid_amount: 250,
      insurance_amount: 0,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: 0,
      payment_method: "cash",
      secondary_payment_method: null,
      payment_note: null,
      paid_at: "2026-05-10T09:30:00.000Z",
      profiles: { full_name: "Sarah Ahmed" },
      departments: { name: "Dermatology", color: "#f00" },
      insurance_providers: null,
      appointment_services: [],
    },
    followups: [
      { id: "f1", outcome: "all_fine", notes: "Doing well", recorded_at: "2026-05-12T10:00:00.000Z", recorded_by_name: "Reception" },
    ],
    notes: [
      {
        id: "n1",
        patient_id: "p1",
        doctor_id: "doctor-1",
        created_by: "doctor-1",
        note: "Prescribed topical cream",
        created_at: "2026-05-10T09:20:00.000Z",
        profiles: { full_name: "Sarah Ahmed" },
        attachments: [],
      },
    ],
    documents: [
      { id: "d1", docType: "PRESCRIPTION", documentNumber: "RX-000123", status: "issued", issuedAt: "2026-05-10T09:25:00.000Z", verificationToken: "tok" },
    ],
    ...overrides,
  };
}

const NOTE_PERMISSIONS = {
  patientId: "p1",
  currentUserId: "doctor-1",
  canManageAllAttachments: false,
  canMutateNotes: false,
  canViewNoteAttachments: true,
  canUploadNoteAttachments: false,
  canAuthorNotes: false,
};

describe("AppointmentHistoryCard", () => {
  it("scoped clinical role: shows details, note, follow-up and related documents but no money", () => {
    render(
      <AppointmentHistoryCard
        entry={makeEntry()}
        settlements={[]}
        isScopedClinical
        docTypeLabels={DOC_LABELS}
        {...NOTE_PERMISSIONS}
      />,
    );

    expect(screen.getAllByText(/Sarah Ahmed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Doing well/)).toBeInTheDocument();
    expect(screen.getByText("Prescribed topical cream")).toBeInTheDocument();
    expect(screen.getByText("Prescription")).toBeInTheDocument();
    expect(screen.getByText("RX-000123")).toBeInTheDocument();
    // No billing figures are rendered for a scoped clinical role.
    expect(screen.queryByText(/250/)).not.toBeInTheDocument();
    // Related document links to its detail page.
    expect(screen.getByRole("link", { name: /Prescription/ })).toHaveAttribute(
      "href",
      "/documents/d1",
    );
  });

  it("non-scoped role: renders the billing amount via the reused payment row", () => {
    render(
      <AppointmentHistoryCard
        entry={makeEntry()}
        settlements={[]}
        isScopedClinical={false}
        docTypeLabels={DOC_LABELS}
        {...NOTE_PERMISSIONS}
      />,
    );
    // The financial payment row surfaces the invoice total.
    expect(screen.getByText(/250/)).toBeInTheDocument();
    expect(screen.getByText("Prescribed topical cream")).toBeInTheDocument();
  });

  it("renders cleanly when an appointment has no linked extras", () => {
    render(
      <AppointmentHistoryCard
        entry={makeEntry({ followups: [], notes: [], documents: [] })}
        settlements={[]}
        isScopedClinical
        docTypeLabels={DOC_LABELS}
        {...NOTE_PERMISSIONS}
      />,
    );
    expect(screen.getByText(/Sarah Ahmed/)).toBeInTheDocument();
    expect(screen.queryByText("Related documents")).not.toBeInTheDocument();
  });

  it("keeps each note's attachments and note authoring inside its appointment", () => {
    const entry = makeEntry({
      notes: [
        {
          id: "n1",
          patient_id: "p1",
          doctor_id: "doctor-1",
          created_by: "doctor-1",
          note: "Appointment-specific note",
          created_at: "2026-05-10T09:20:00.000Z",
          profiles: { full_name: "Sarah Ahmed" },
          attachments: [
            {
              id: "att-1",
              fileName: "scan.pdf",
              mimeType: "application/pdf",
              sizeBytes: 2048,
              createdAt: "2026-05-10T09:21:00.000Z",
              uploadedById: "doctor-1",
              uploadedByName: "Sarah Ahmed",
            },
          ],
        },
      ],
    });

    render(
      <AppointmentHistoryCard
        entry={entry}
        settlements={[]}
        isScopedClinical
        docTypeLabels={DOC_LABELS}
        {...NOTE_PERMISSIONS}
        canMutateNotes
        canUploadNoteAttachments
        canAuthorNotes
      />,
    );

    expect(screen.getByText("Appointment-specific note")).toBeInTheDocument();
    expect(screen.getByText("scan.pdf")).toBeInTheDocument();
    expect(screen.getByTestId("note-composer")).toHaveAttribute("data-patient-id", "p1");
    expect(screen.getByTestId("note-composer")).toHaveAttribute("data-appointment-id", "a1");
    expect(screen.getByRole("button", { name: /attach file/i })).toBeInTheDocument();
  });

  it("does not expose attachment controls to roles without existing attachment access", () => {
    render(
      <AppointmentHistoryCard
        entry={makeEntry()}
        settlements={[]}
        isScopedClinical
        docTypeLabels={DOC_LABELS}
        {...NOTE_PERMISSIONS}
        canViewNoteAttachments={false}
      />,
    );

    expect(screen.getByText("Prescribed topical cream")).toBeInTheDocument();
    expect(screen.queryByText(/attachment/)).not.toBeInTheDocument();
  });
});
