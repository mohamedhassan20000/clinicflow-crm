import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { PatientDocumentsSection } from "@/components/patients/patient-documents-section";
import {
  deletePatientDocument,
  getPatientDocumentSignedUrl,
  uploadPatientDocument,
  type PatientDocumentsData,
} from "@/actions/patient-documents";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/actions/patient-documents", () => ({
  deletePatientDocument: vi.fn(),
  getPatientDocumentSignedUrl: vi.fn(),
  uploadPatientDocument: vi.fn(),
}));

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

const baseDocuments: PatientDocumentsData = {
  nationalId: {
    id: "national-doc",
    category: "national_id",
    label: null,
    fileName: "national-id.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    createdAt: "2026-05-10T00:00:00.000Z",
    uploadedByName: "Reception One",
  },
  insurance: {
    id: "insurance-doc",
    category: "insurance",
    label: null,
    fileName: "insurance-card.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    createdAt: "2026-05-10T00:00:00.000Z",
    uploadedByName: null,
  },
  other: [
    {
      id: "other-doc-1",
      category: "other",
      label: null,
      fileName: "lab-result.webp",
      mimeType: "image/webp",
      sizeBytes: 4096,
      createdAt: "2026-05-10T00:00:00.000Z",
      uploadedByName: "Admin One",
    },
    {
      id: "other-doc-2",
      category: "other",
      label: null,
      fileName: "referral.pdf",
      mimeType: "application/pdf",
      sizeBytes: 8192,
      createdAt: "2026-05-11T00:00:00.000Z",
      uploadedByName: null,
    },
  ],
};

function renderSection(documents: PatientDocumentsData = baseDocuments) {
  return render(
    <PatientDocumentsSection
      patientId={PATIENT_ID}
      initialDocuments={documents}
    />,
  );
}

describe("PatientDocumentsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getPatientDocumentSignedUrl).mockResolvedValue({
      data: { url: "https://signed.local/document" },
    });
    vi.mocked(uploadPatientDocument).mockResolvedValue({
      ok: true,
      data: baseDocuments,
    });
    vi.mocked(deletePatientDocument).mockResolvedValue({
      ok: true,
      data: {
        ...baseDocuments,
        nationalId: null,
      },
    });
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("renders grouped fixed slots and multiple other documents", () => {
    renderSection();

    expect(screen.getByText("National ID")).toBeInTheDocument();
    expect(screen.getByText("Insurance")).toBeInTheDocument();
    expect(screen.getByText("national-id.pdf")).toBeInTheDocument();
    expect(screen.getByText("insurance-card.png")).toBeInTheDocument();
    expect(screen.getByText("lab-result.webp")).toBeInTheDocument();
    expect(screen.getByText("referral.pdf")).toBeInTheDocument();
    expect(screen.getByText("4 files")).toBeInTheDocument();
  });

  it("explains that fixed-slot documents must be deleted before replacement", () => {
    renderSection();

    expect(
      screen.getAllByText("Delete this document before uploading a replacement."),
    ).toHaveLength(2);
  });

  it("shows a generic inline load error without document details", () => {
    render(
      <PatientDocumentsSection
        patientId={PATIENT_ID}
        initialDocuments={{ nationalId: null, insurance: null, other: [] }}
        hasLoadError
      />,
    );

    expect(
      screen.getByText("Could not load patient documents. Refresh the page and try again."),
    ).toBeInTheDocument();
  });

  it("does not request signed URLs on render and only requests one on View click", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(getPatientDocumentSignedUrl).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: /view/i })[0]);

    await waitFor(() => {
      expect(getPatientDocumentSignedUrl).toHaveBeenCalledWith(
        PATIENT_ID,
        "national-doc",
      );
    });
    expect(window.open).toHaveBeenCalledWith(
      "https://signed.local/document",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("hides fixed-slot upload buttons when National ID and Insurance exist", () => {
    renderSection();

    expect(screen.queryByRole("button", { name: /^upload$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /add document/i }),
    ).toBeInTheDocument();
  });

  it("uploads the correct category from an empty fixed slot", async () => {
    renderSection({ ...baseDocuments, nationalId: null });

    const input = screen.getByLabelText("Upload National ID document");
    fireEvent.change(input, {
      target: {
        files: [new File(["id"], "id.pdf", { type: "application/pdf" })],
      },
    });

    await waitFor(() => {
      expect(uploadPatientDocument).toHaveBeenCalledWith(
        PATIENT_ID,
        "national_id",
        expect.any(FormData),
      );
    });
  });

  it("keeps Other documents multi-entry and uploads with the other category", async () => {
    renderSection();

    expect(screen.getByText("lab-result.webp")).toBeInTheDocument();
    expect(screen.getByText("referral.pdf")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Upload other document"), {
      target: {
        files: [new File(["scan"], "scan.webp", { type: "image/webp" })],
      },
    });

    await waitFor(() => {
      expect(uploadPatientDocument).toHaveBeenCalledWith(
        PATIENT_ID,
        "other",
        expect.any(FormData),
      );
    });
  });

  it("requires delete confirmation before calling the delete action", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getAllByRole("button", { name: /delete/i })[0]);
    expect(deletePatientDocument).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deletePatientDocument).toHaveBeenCalledWith(
        PATIENT_ID,
        "national-doc",
      );
    });
  });

  it("shows upload errors and keeps local state unchanged", async () => {
    vi.mocked(uploadPatientDocument).mockResolvedValue({
      error: "Upload failed.",
    });
    renderSection({ ...baseDocuments, nationalId: null });

    fireEvent.change(screen.getByLabelText("Upload National ID document"), {
      target: {
        files: [new File(["id"], "id.pdf", { type: "application/pdf" })],
      },
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Upload failed.");
    });
    expect(screen.queryByText("national-id.pdf")).not.toBeInTheDocument();
    expect(
      screen.getByText("No national ID document uploaded yet."),
    ).toBeInTheDocument();
  });

  it("does not update local state after upload when no data is returned", async () => {
    vi.mocked(uploadPatientDocument).mockResolvedValue({ ok: true });
    renderSection({ ...baseDocuments, nationalId: null });

    fireEvent.change(screen.getByLabelText("Upload National ID document"), {
      target: {
        files: [new File(["id"], "id.pdf", { type: "application/pdf" })],
      },
    });

    await waitFor(() => {
      expect(uploadPatientDocument).toHaveBeenCalled();
    });
    expect(
      screen.getByText("No national ID document uploaded yet."),
    ).toBeInTheDocument();
  });

  it("shows view errors without opening a window", async () => {
    const user = userEvent.setup();
    vi.mocked(getPatientDocumentSignedUrl).mockResolvedValue({
      error: "Link failed.",
    });
    renderSection();

    await user.click(screen.getAllByRole("button", { name: /view/i })[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Link failed.");
    });
    expect(window.open).not.toHaveBeenCalled();
  });

  it("shows delete errors and keeps local state unchanged", async () => {
    const user = userEvent.setup();
    vi.mocked(deletePatientDocument).mockResolvedValue({
      error: "Delete failed.",
    });
    renderSection();

    await user.click(screen.getAllByRole("button", { name: /delete/i })[0]);
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Delete failed.");
    });
    expect(screen.getByText("national-id.pdf")).toBeInTheDocument();
  });

  it("does not update local state after delete when no data is returned", async () => {
    const user = userEvent.setup();
    vi.mocked(deletePatientDocument).mockResolvedValue({ ok: true });
    renderSection();

    await user.click(screen.getAllByRole("button", { name: /delete/i })[0]);
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deletePatientDocument).toHaveBeenCalled();
    });
    expect(screen.getByText("national-id.pdf")).toBeInTheDocument();
  });

  it("restricts file inputs to PDF and supported image types", () => {
    renderSection({ ...baseDocuments, nationalId: null });

    expect(screen.getByLabelText("Upload National ID document")).toHaveAttribute(
      "accept",
      "application/pdf,image/jpeg,image/png,image/webp",
    );
    expect(screen.getByLabelText("Upload other document")).toHaveAttribute(
      "accept",
      "application/pdf,image/jpeg,image/png,image/webp",
    );
  });
});
