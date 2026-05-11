import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/actions/patients", () => ({
  deleteMedicalNote: vi.fn(),
  restoreMedicalNote: vi.fn(),
  updateMedicalNote: vi.fn(),
}));

vi.mock("@/actions/medical-note-attachments", () => ({
  uploadMedicalNoteAttachment: vi.fn(),
  getMedicalNoteAttachmentSignedUrl: vi.fn(),
  deleteMedicalNoteAttachment: vi.fn(),
  restoreMedicalNoteAttachment: vi.fn(),
}));

describe("MedicalNotesList attachments", () => {
  it("renders attachment controls and existing note attachments", () => {
    render(
      <MedicalNotesList
        patientId="patient-1"
        currentUserId="user-1"
        canManageAllAttachments={false}
        notes={[
          {
            id: "note-1",
            patient_id: "patient-1",
            doctor_id: "doctor-1",
            created_by: "user-1",
            deleted_at: null,
            created_at: "2026-05-11T00:00:00Z",
            note: "Clinical note",
            profiles: { full_name: "Dr. User" },
            attachments: [
              {
                id: "attachment-1",
                fileName: "scan.pdf",
                mimeType: "application/pdf",
                sizeBytes: 2048,
                createdAt: "2026-05-11T00:00:00Z",
                uploadedById: "user-1",
                uploadedByName: "Dr. User",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Clinical note")).toBeInTheDocument();
    expect(screen.getByText("1 attachment")).toBeInTheDocument();
    expect(screen.getByText("scan.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /attach file/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view scan.pdf/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete scan.pdf/i })).toBeInTheDocument();
  });
});
