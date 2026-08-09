import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueRevenueReportDocument: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/actions/documents", () => ({
  issueRevenueReportDocument: mocks.issueRevenueReportDocument,
  reprintRevenueReportDocument: vi.fn(),
}));

import { RevenueDocumentActions } from "@/components/documents/revenue-document-actions";
import { issuedDocumentDetailHref } from "@/lib/documents/module";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const labels = {
  issue: "Issue",
  issuing: "Issuing",
  printDraft: "Print draft",
  reprint: "Download",
  preparing: "Preparing",
  issued: "Issued",
  issueFailed: "Issue failed",
  reprintFailed: "Download failed",
};

describe("P7 post-Issue navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueRevenueReportDocument.mockResolvedValue({
      data: { documentId: DOCUMENT_ID, documentNumber: "REV-1", reused: false },
    });
  });

  it("redirects a successful Issue to the newly issued document detail", async () => {
    render(
      <RevenueDocumentActions
        locale="en"
        params={{ from: "2026-08-01", to: "2026-08-08" }}
        idempotencyKey="22222222-2222-4222-8222-222222222222"
        labels={labels}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Issue" }));

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(`/documents/${DOCUMENT_ID}`);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("builds the canonical detail destination from the returned issued ID", () => {
    expect(issuedDocumentDetailHref("issued/id")).toBe("/documents/issued%2Fid");
  });

  it("uses the same canonical success destination in every issuing UI", () => {
    const issuingSurfaces = [
      "components/documents/revenue-document-actions.tsx",
      "components/documents/analytical-document-actions.tsx",
      "components/documents/roster-profile-document-actions.tsx",
      "components/documents/clinical-document-actions.tsx",
      "components/documents/invoice-document-actions.tsx",
      "components/documents/patient-history-document-actions.tsx",
      "components/documents/module/generic-document-composer.tsx",
    ];

    for (const file of issuingSurfaces) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toContain(
        "router.replace(issuedDocumentDetailHref(result.data.documentId))",
      );
      expect(source, file).not.toContain(
        "?documentId=${encodeURIComponent(result.data.documentId)}",
      );
    }
  });
});
