import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentEngineHarness } from "@/components/documents/harness/document-engine-harness";
import {
  DOCUMENT_ENGINE_CSS,
  DocumentPage,
  type DocumentRenderContextBoundary,
} from "@/components/documents/engine";
import { buildDocumentHtml } from "@/lib/documents/pdf";

const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("P7-1 Chromium document boundary", () => {
  it("builds self-contained EN/AR HTML with the approved local fonts", async () => {
    for (const locale of ["en", "ar"] as const) {
      const html = await buildDocumentHtml({
        renderDocument: (renderContextBoundary) => (
          <DocumentEngineHarness locale={locale} qrDataUrl={QR_DATA_URL} lifecycle="issued"
            renderContextBoundary={renderContextBoundary} />
        ),
        locale,
        title: `P7-1 ${locale}`,
      });
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain("data:font/woff2;base64,");
      expect(html).toContain("ClinicFlow Document Manrope");
      expect(html).toContain("ClinicFlow Document Thmanyah");
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).not.toMatch(/[٠-٩۰-۹]/);
    }
  });

  it.each([
    { locale: "en" as const, label: "CANCELLED", direction: "ltr" },
    { locale: "ar" as const, label: "ملغي", direction: "rtl" },
  ])("carries the shared cancelled overlay into $locale PDF HTML", async ({
    locale,
    label,
    direction,
  }) => {
    const html = await buildDocumentHtml({
      renderDocument: (renderContextBoundary) => (
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
          renderContextBoundary={renderContextBoundary}
        >
          <p>Immutable issued snapshot</p>
        </DocumentPage>
      ),
      locale,
      title: `Cancelled ${locale}`,
    });

    expect(html).toContain(label);
    expect(html).toContain(`dir="${direction}"`);
    expect(html).toContain('data-lifecycle="cancelled"');
    expect(html).toContain("color: var(--doc-danger)");
    expect(html).toContain("Immutable issued snapshot");
  });

  it("freezes browser-print pagination and anti-orphan rules in the shared stylesheet", () => {
    expect(DOCUMENT_ENGINE_CSS).toContain("@page");
    expect(DOCUMENT_ENGINE_CSS).toContain("table-header-group");
    expect(DOCUMENT_ENGINE_CSS).toContain("table-footer-group");
    expect(DOCUMENT_ENGINE_CSS).toContain("break-inside: avoid");
    expect(DOCUMENT_ENGINE_CSS).toContain("counter(pages)");
    expect(DOCUMENT_ENGINE_CSS).toContain("@page document-en-portrait");
    expect(DOCUMENT_ENGINE_CSS).toContain("@bottom-center");
    expect(DOCUMENT_ENGINE_CSS).toContain("break-after: auto");
    expect(DOCUMENT_ENGINE_CSS).toContain("overflow: visible");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-table-total-label");
    expect(DOCUMENT_ENGINE_CSS).toContain("body:has(.cf-document-print-root)");
    expect(DOCUMENT_ENGINE_CSS).toContain(
      "body:has(.cf-document-print-root) .cf-document-print-root *",
    );
    expect(DOCUMENT_ENGINE_CSS).not.toContain("body > *:not(.cf-document-print-root)");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-document-print-root header.cf-doc-header");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-document-print-root nav.cf-doc-footer-links");
    expect(DOCUMENT_ENGINE_CSS).toContain("table.cf-document-pagination");
    expect(DOCUMENT_ENGINE_CSS).toContain("table.cf-doc-table");
    const globalCss = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(globalCss).toContain("header:not(.cf-doc-header)");
    expect(globalCss).toContain("nav:not(.cf-doc-footer-links)");
  });

  it("standardizes configured clinic logos across preview, issued, and PDF output", async () => {
    const logoRule = DOCUMENT_ENGINE_CSS.match(/\.cf-doc-logo \{([\s\S]*?)\}/)?.[1] ?? "";
    const fallbackRule = DOCUMENT_ENGINE_CSS.match(/\.cf-doc-logo-fallback \{([\s\S]*?)\}/)?.[1] ?? "";
    const brandingRule = DOCUMENT_ENGINE_CSS.match(/\.cf-doc-branding \{([\s\S]*?)\}/)?.[1] ?? "";
    const logoSrc = "data:image/svg+xml;base64,PHN2Zy8+";
    const document = (lifecycle: "preview" | "issued", renderContextBoundary?: DocumentRenderContextBoundary) => (
      <DocumentPage locale="en" lifecycle={lifecycle}
        branding={{ name: "Clinic", logoSrc, address: "Medical District" }}
        identity={{ title: "Document", documentNumber: lifecycle === "issued" ? "DOC-1" : null,
          issueDate: "09 Aug 2026", labels: { documentNumber: "Document no.", issueDate: "Issued" } }}
        watermark={{ enabled: false }} renderContextBoundary={renderContextBoundary}>
        <p>Body</p>
      </DocumentPage>
    );

    expect(logoRule).toContain("block-size: 80px;");
    expect(logoRule).toContain("inline-size: auto;");
    expect(logoRule).toContain("max-inline-size: 200px;");
    expect(logoRule).toContain("object-fit: contain;");
    expect(logoRule).toContain("object-position: center;");
    expect(fallbackRule).toContain("block-size: 56px;");
    expect(fallbackRule).toContain("inline-size: 56px;");
    expect(brandingRule).toContain("align-items: center;");
    expect(brandingRule).toContain("gap: 20px;");

    for (const lifecycle of ["preview", "issued"] as const) {
      const { container, unmount } = render(document(lifecycle));
      expect(container.querySelector(".cf-doc-logo")).toHaveAttribute("src", logoSrc);
      expect(container.querySelector(".cf-doc-branding-copy")).toHaveTextContent("Clinic");
      unmount();
    }

    const html = await buildDocumentHtml({
      locale: "en", title: "Clinic logo sizing",
      renderDocument: (renderContextBoundary) => document("issued", renderContextBoundary),
    });
    expect(html).toContain('class="cf-doc-logo"');
    expect(html).toContain(`src="${logoSrc}"`);
  });

  it("keeps Chromium server-only, disables page JavaScript, and blocks external requests", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/documents/pdf/render.ts"),
      "utf8",
    );
    expect(source).toContain('import "server-only"');
    expect(source).toContain("setJavaScriptEnabled(false)");
    expect(source).toContain('request.abort("blockedbyclient")');
    expect(source).toContain('protocol === "data:"');
    expect(source).toContain("printBackground: true");
    expect(source).toContain("PDFDocument.load(pdfBytes)");
    expect(source).toContain("renderedDocument.getPageCount()");
  });

  it("routes every renderer family through the central server-safe render boundary", () => {
    const rendererFiles = [
      "revenue-report.tsx",
      "analytical-report.tsx",
      "roster-profile.tsx",
      "clinical-document.tsx",
      "invoice.tsx",
      "patient-history.tsx",
      "generic-document.tsx",
    ];
    for (const file of rendererFiles) {
      const source = readFileSync(
        join(process.cwd(), "lib/documents/renderers", file),
        "utf8",
      );
      expect(source).toContain("renderDocument: (renderContextBoundary)");
      expect(source).toContain("renderContextBoundary={renderContextBoundary}");
      expect(source).toContain('reservation.presentationLifecycle ?? "issued"');
      expect(source).not.toContain("DocumentRenderContextProvider");
      expect(source).not.toContain("StaticDocumentRenderBoundary");
    }

    const htmlBoundary = readFileSync(
      join(process.cwd(), "lib/documents/pdf/html.tsx"),
      "utf8",
    );
    expect(htmlBoundary).toContain("renderDocument(StaticDocumentRenderBoundary)");
  });
});
