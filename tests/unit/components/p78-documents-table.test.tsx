import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { DocumentsTable } from "@/components/documents/module/documents-table";
import type { DocumentModuleRow } from "@/actions/documents-module";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const TYPE_LABELS = {
  INVOICE: "Invoice",
  PRESCRIPTION: "Prescription",
  REVENUE_REPORT: "Revenue Report",
} as Record<string, string>;

function row(overrides: Partial<DocumentModuleRow>): DocumentModuleRow {
  return {
    id: "id-1",
    docType: "INVOICE",
    documentNumber: "INV-0001",
    status: "issued",
    locale: "en",
    subjectName: "Jane Doe",
    issuedByName: "Front Desk",
    issuedAt: "2026-08-01T10:00:00.000Z",
    printCount: 0,
    isDraft: false,
    viewHref: "/documents/id-1",
    editHref: null,
    ...overrides,
  };
}

function renderTable(rows: DocumentModuleRow[], total = rows.length) {
  return render(
    <NuqsTestingAdapter>
      <DocumentsTable
        rows={rows}
        total={total}
        page={1}
        pageSize={20}
        locale="en"
        typeLabels={TYPE_LABELS}
      />
    </NuqsTestingAdapter>,
  );
}

describe("P7-8 DocumentsTable", () => {
  it("groups rows by document type with financial before clinical", () => {
    renderTable([
      row({ id: "a", docType: "INVOICE", documentNumber: "INV-0001" }),
      row({ id: "b", docType: "PRESCRIPTION", documentNumber: "RX-0002", subjectName: "John Roe" }),
      row({ id: "c", docType: "INVOICE", documentNumber: "INV-0003" }),
    ]);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["Invoice", "Prescription"]);
    expect(screen.getByText("INV-0001")).toBeInTheDocument();
    expect(screen.getByText("RX-0002")).toBeInTheDocument();
    expect(screen.getByText("John Roe")).toBeInTheDocument();
  });

  it("links each row's view action to its factory detail page", () => {
    renderTable([row({ id: "detail-target", documentNumber: "INV-9", viewHref: "/documents/detail-target" })]);
    const link = screen.getByRole("link", { name: "View" });
    expect(link).toHaveAttribute("href", "/documents/detail-target");
  });

  it("renders a localized status badge and print-safe issue date in Latin digits", () => {
    renderTable([row({ status: "cancelled", documentNumber: "INV-5" })]);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    // Latin digits only — never Arabic-Indic.
    expect(document.body.textContent).not.toMatch(/[٠-٩]/);
  });

  it("renders persisted drafts as Not Issued with preview and edit actions", () => {
    renderTable([row({
      id: "draft-1",
      documentNumber: null,
      status: "not_issued",
      isDraft: true,
      viewHref: "/appointments/invoice/document?draftId=draft-1",
      editHref: "/documents/new/invoice?draftId=draft-1",
    })]);
    expect(screen.getByText("Not Issued")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preview" })).toHaveAttribute(
      "href",
      "/appointments/invoice/document?draftId=draft-1",
    );
    expect(screen.getByRole("link", { name: /Edit/ })).toHaveAttribute(
      "href",
      "/documents/new/invoice?draftId=draft-1",
    );
  });

  it("shows the total range in the pagination footer", () => {
    // page 1, pageSize 20, total 42 ⇒ the window is 1–20 of 42.
    renderTable([row({}), row({ id: "id-2", documentNumber: "INV-2" })], 42);
    expect(screen.getByText(/Showing\s*1.20\s*of\s*42/)).toBeInTheDocument();
  });

  it("renders an empty state when there are no rows", () => {
    renderTable([], 0);
    expect(screen.getByText("No documents match these filters yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("falls back to a dash for a missing subject or issuer", () => {
    renderTable([row({ subjectName: null, issuedByName: null })]);
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
