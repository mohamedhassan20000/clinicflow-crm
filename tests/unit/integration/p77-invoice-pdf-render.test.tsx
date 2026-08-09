import { describe, expect, it } from "vitest";
import { InvoiceDocument } from "@/components/documents/templates/invoice";
import { buildDocumentHtml, renderDocumentPdf } from "@/lib/documents/pdf";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import type { InvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";

const snapshot: InvoiceDocumentSnapshot = {
  version: 1,
  generatedAt: "2026-07-29T10:30:00.000Z",
  appointmentId: "22222222-2222-4222-8222-222222222222",
  branding: {
    name: "عيادة كلينك فلو",
    logoSrc: null,
    address: "إسطنبول",
    phone: "+٩٠ ٥٥٥ ٠٠٠ ٠٠٠٠",
    email: "clinic@example.com",
    website: "clinic.example.com",
    licenseNo: "LIC-42",
    taxId: "TAX-42",
    footerText: null,
  },
  format: { currency: "TRY", timeZone: "Europe/Istanbul", timeFormat: "24h" },
  settings: {
    watermark: "سري",
    qrEnabled: false,
    numberingPrefix: "INV",
    numberingYearlyReset: true,
    sequencePadding: 4,
  },
  patient: { fullName: "مرت كايا", fileNumber: "PAT-88210", departmentName: "الجلدية" },
  appointment: {
    scheduledAt: "2026-07-29T09:00:00.000Z",
    paidAt: "2026-07-29T10:00:00.000Z",
    doctorName: "د. أحمد",
  },
  status: "partially_paid",
  lineItems: [
    { id: "line-1", name: "تقشير كيميائي", reference: "DR-CP-001", unitPrice: 2000, quantity: 2, lineTotal: 4000 },
  ],
  totals: {
    subtotal: 4000,
    insuranceCoverage: 1000,
    amountDue: 3000,
    paidTotal: 1000,
    outstanding: 2000,
  },
  payments: [{ method: "cash", amount: 1000 }],
  billingNotes: null,
};

describe("P7-7 Invoice Chromium rendering", () => {
  it("produces a valid Arabic A4 PDF through the production renderer", async () => {
    const copy = await getInvoiceCopy("ar");
    const renderDocument = (renderContextBoundary: Parameters<typeof InvoiceDocument>[0]["renderContextBoundary"]) => (
      <InvoiceDocument
        locale="ar"
        lifecycle="issued"
        snapshot={snapshot}
        copy={copy}
        documentNumber="INV-٢٠٢٦-٠٠٠١"
        renderContextBoundary={renderContextBoundary}
      />
    );
    const html = await buildDocumentHtml({
      renderDocument,
      locale: "ar",
      title: "P7-7 Invoice Arabic roundtrip",
    });
    expect(html).toContain("الفاتورة");
    expect(html).toContain("INV-2026-0001");
    expect(html).toContain("ختم العيادة");
    expect(html).toContain("توقيع المعتمد");
    expect(html).not.toMatch(/[٠-٩۰-۹]/);
    expect(html.length).toBeGreaterThan(50_000);

    const result = await renderDocumentPdf({
      locale: "ar",
      title: "P7-7 Invoice Arabic roundtrip",
      renderDocument,
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(10_000);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
