import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  deleteMedicalNoteAttachment,
  getMedicalNoteAttachmentSignedUrl,
  restoreMedicalNoteAttachment,
} from "@/actions/medical-note-attachments";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { MedicalNoteAttachments } from "@/components/patients/medical-note-attachments";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
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

const baseAttachment = {
  id: "attachment-1",
  fileName: "scan.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  createdAt: "2026-05-11T00:00:00Z",
  uploadedById: "user-1",
  uploadedByName: "Dr. User",
};

describe("MedicalNotesList attachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(deleteMedicalNoteAttachment).mockResolvedValue({ data: [] });
    vi.mocked(restoreMedicalNoteAttachment).mockResolvedValue({
      data: [baseAttachment],
    });
    vi.mocked(getMedicalNoteAttachmentSignedUrl).mockResolvedValue({
      data: { url: "https://signed.local/attachment" },
    });
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

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
            attachments: [baseAttachment],
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

  it("restores a deleted note attachment from the undo toast and shows it immediately", async () => {
    const user = userEvent.setup();
    render(
      <MedicalNoteAttachments
        patientId="patient-1"
        noteId="note-1"
        noteAuthorId="user-1"
        currentUserId="user-1"
        canManageAllAttachments={false}
        initialAttachments={[baseAttachment]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete scan.pdf/i }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText("scan.pdf")).not.toBeInTheDocument();
    });

    const undoOptions = vi.mocked(toast.success).mock.calls.find(
      ([message]) => message === "Attachment moved to trash.",
    )?.[1] as
      | { action?: { onClick?: () => void | Promise<void> } }
      | undefined;
    const undo = undoOptions?.action?.onClick;
    expect(undo).toBeTypeOf("function");

    await act(async () => {
      await undo?.();
    });

    await waitFor(() => {
      expect(restoreMedicalNoteAttachment).toHaveBeenCalledWith(
        "patient-1",
        "note-1",
        "attachment-1",
      );
      expect(screen.getByText("scan.pdf")).toBeInTheDocument();
    });
  });

  it("can view a note attachment after undo restore", async () => {
    const user = userEvent.setup();
    render(
      <MedicalNoteAttachments
        patientId="patient-1"
        noteId="note-1"
        noteAuthorId="user-1"
        currentUserId="user-1"
        canManageAllAttachments={false}
        initialAttachments={[baseAttachment]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete scan.pdf/i }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    const undoOptions = vi.mocked(toast.success).mock.calls.find(
      ([message]) => message === "Attachment moved to trash.",
    )?.[1] as
      | { action?: { onClick?: () => void | Promise<void> } }
      | undefined;
    const undo = undoOptions?.action?.onClick;

    await act(async () => {
      await undo?.();
    });
    await waitFor(() => {
      expect(screen.getByText("scan.pdf")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /view scan.pdf/i }));

    await waitFor(() => {
      expect(getMedicalNoteAttachmentSignedUrl).toHaveBeenCalledWith(
        "patient-1",
        "note-1",
        "attachment-1",
      );
    });
  });
});
