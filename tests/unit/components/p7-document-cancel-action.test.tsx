import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentDetailActions } from "@/components/documents/module/document-detail-actions";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/actions/documents-module", () => ({
  cancelClinicDocument: mocks.cancel,
  reprintClinicDocumentFromModule: vi.fn(),
}));

describe("P7 issued document cancellation", () => {
  beforeEach(() => {
    mocks.cancel.mockReset();
    mocks.refresh.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows Cancel Document only for an issued document and refreshes after success", async () => {
    mocks.cancel.mockResolvedValue({ data: { documentId: "doc-1", status: "cancelled" } });
    render(
      <DocumentDetailActions
        documentId="doc-1"
        renderedHref="/rendered"
        verificationToken="token"
        status="issued"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel Document" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("doc-1"));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not offer cancellation again after the document is Cancelled", () => {
    render(
      <DocumentDetailActions
        documentId="doc-1"
        renderedHref="/rendered"
        verificationToken="token"
        status="cancelled"
      />,
    );
    expect(screen.queryByRole("button", { name: "Cancel Document" })).not.toBeInTheDocument();
  });
});
