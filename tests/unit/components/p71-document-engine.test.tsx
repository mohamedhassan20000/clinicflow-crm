import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DOCUMENT_ENGINE_CSS, DocumentPage } from "@/components/documents/engine";
import { DocumentEngineHarness } from "@/components/documents/harness/document-engine-harness";
import { VerificationBlock } from "@/components/documents/primitives";

const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("P7-1 document engine", () => {
  it.each([
    { locale: "en" as const, direction: "ltr", watermark: "DRAFT" },
    { locale: "ar" as const, direction: "rtl", watermark: "مسودة" },
  ])("renders every frozen primitive in $locale", ({ locale, direction, watermark }) => {
    render(<DocumentEngineHarness locale={locale} qrDataUrl={QR_DATA_URL} />);

    expect(screen.getByTestId("document-page")).toHaveAttribute("dir", direction);
    expect(screen.getByTestId("document-page")).toHaveAttribute("data-digits", "latn");
    expect(screen.getByTestId("document-watermark")).toHaveTextContent(watermark);
    for (const testId of [
      "document-header",
      "document-footer",
      "section-header",
      "identity-hero",
      "status-badge",
      "field-grid",
      "stat-card-row",
      "data-table",
      "grouped-tables",
      "totals-summary",
      "checklist-panel",
      "certifying-prose",
      "notes-callout",
      "verification-block",
      "signature-block",
    ]) {
      expect(screen.getAllByTestId(testId).length).toBeGreaterThan(0);
    }

    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });

  it("applies lifecycle watermark rules and gracefully omits optional branding", () => {
    const common = {
      locale: "en" as const,
      branding: { name: "ClinicFlow Clinic" },
      identity: {
        title: "TEST",
        documentNumber: "T-2026-0001",
        issueDate: "01 Aug 2026",
        labels: {
          documentNumber: "Document no.",
          issueDate: "Issued",
          issueTime: "Time",
          period: "Period",
        },
      },
      footer: {},
      children: <p>Body</p>,
    };
    const { rerender } = render(
      <DocumentPage {...common} lifecycle="preview" watermark={{ enabled: false, text: "SECRET" }} />,
    );
    expect(screen.getByTestId("document-watermark")).toHaveTextContent("DRAFT");
    expect(document.body).not.toHaveTextContent("License");

    rerender(<DocumentPage {...common} lifecycle="issued" watermark={{ enabled: false }} />);
    expect(screen.queryByTestId("document-watermark")).not.toBeInTheDocument();

    rerender(<DocumentPage {...common} lifecycle="issued" watermark={{ enabled: true, text: " " }} />);
    expect(screen.getByTestId("document-watermark")).toHaveTextContent("ClinicFlow Clinic");
  });

  it.each([
    { locale: "en" as const, direction: "ltr", label: "CANCELLED" },
    { locale: "ar" as const, direction: "rtl", label: "ملغي" },
  ])("renders the shared red cancelled presentation in $locale", ({ locale, direction, label }) => {
    render(
      <DocumentPage
        locale={locale}
        lifecycle="cancelled"
        branding={{ name: locale === "ar" ? "العيادة" : "Clinic" }}
        identity={{
          title: locale === "ar" ? "مستند" : "Document",
          documentNumber: "DOC-2026-0001",
          issueDate: "09 Aug 2026",
          labels: {
            documentNumber: locale === "ar" ? "رقم المستند" : "Document no.",
            issueDate: locale === "ar" ? "تاريخ الإصدار" : "Issued",
          },
        }}
        watermark={{ enabled: false }}
      >
        <p>Immutable issued content</p>
      </DocumentPage>,
    );

    expect(screen.getByTestId("document-page"))
      .toHaveAttribute("data-lifecycle", "cancelled");
    expect(screen.getByTestId("document-page")).toHaveAttribute("dir", direction);
    expect(screen.getByTestId("document-watermark")).toHaveTextContent(label);
    expect(screen.getByTestId("document-watermark"))
      .toHaveAttribute("data-watermark-kind", "cancelled");
    expect(DOCUMENT_ENGINE_CSS).toContain(
      '.cf-document-page[data-lifecycle="cancelled"] .cf-document-watermark',
    );
    expect(DOCUMENT_ENGINE_CSS).toContain("color: var(--doc-danger)");
  });

  it("rejects remote or placeholder QR images at the primitive boundary", () => {
    expect(() => render(
      <VerificationBlock
        qrDataUrl="https://example.com/placeholder.png"
        title="Verify"
        caption="Scan"
      />,
    )).toThrow("inlined QR data URI");
  });

  it("fails closed instead of falling back to English metadata copy", () => {
    expect(() => render(
      <DocumentPage
        locale="ar"
        lifecycle="preview"
        branding={{ name: "العيادة" }}
        identity={{
          title: "مستند",
          issueDate: "08/08/2026",
          period: "01/08/2026 — 08/08/2026",
          labels: {
            documentNumber: "رقم المستند",
            issueDate: "تاريخ الإصدار",
          },
        }}
        watermark={{ enabled: false }}
      >
        <p>المحتوى</p>
      </DocumentPage>,
    )).toThrow("localized period label");
  });
});
