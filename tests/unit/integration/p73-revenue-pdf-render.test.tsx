import { describe, expect, it } from "vitest";
import { RevenueReportDocument } from "@/components/documents/templates/revenue-report";
import { buildDocumentHtml, renderDocumentPdf } from "@/lib/documents/pdf";
import { getRevenueReportCopy } from "@/lib/documents/revenue-copy";
import type { RevenueDocumentSnapshot } from "@/lib/documents/resolvers/revenue-report";

const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

const snapshot: RevenueDocumentSnapshot = {
  version: 1,
  generatedAt: "2026-08-01T10:30:00.000Z",
  range: {
    from: "2026-07-01",
    to: "2026-07-31",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-31T23:59:59.999Z",
  },
  filters: { doctorId: null, departmentId: null },
  branding: {
    name: "عيادة كلينك فلو",
    logoSrc: null,
    address: "إسطنبول",
    phone: "+90 555 000 0000",
    email: "clinic@example.com",
    website: "clinic.example.com",
    licenseNo: "LIC-42",
    taxId: "TAX-42",
    footerText: null,
  },
  format: { currency: "TRY", timeZone: "Europe/Istanbul", timeFormat: "24h" },
  settings: {
    watermark: "سري",
    qrEnabled: true,
    numberingPrefix: "REV",
    numberingYearlyReset: true,
    sequencePadding: 4,
  },
  summary: {
    totalAmount: 6000,
    primaryTotal: 6000,
    secondaryTotal: 0,
    insuranceTotal: 0,
    depositTotal: 0,
    outstandingTotal: 0,
    settlementsTotal: 0,
    patientCollectedTotal: 6000,
    grossTotal: 6000,
    transactionCount: 60,
    settlementCount: 0,
    methodBreakdown: [{ method: "cash", amount: 6000 }],
  },
  transactions: Array.from({ length: 60 }, (_, index) => ({
    id: `revenue-row-${index + 1}`,
    paidAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T08:15:00.000Z`,
    patientName: `Patient ${index + 1}`,
    doctorName: "Dr. Ahmed",
    departmentName: "Dental",
    totalAmount: 100,
    primaryAmount: 100,
    secondaryAmount: 0,
    insuranceAmount: 0,
    depositAmount: 0,
    outstandingAmount: 0,
  })),
};

describe("P7-3 Revenue Report Chromium rendering", () => {
  async function issuedRender() {
    const copy = await getRevenueReportCopy("ar");
    return function renderIssuedRevenue(
      renderContextBoundary: Parameters<typeof RevenueReportDocument>[0]["renderContextBoundary"],
    ) {
      return (
        <RevenueReportDocument
          locale="ar"
          lifecycle="issued"
          snapshot={snapshot}
          copy={copy}
          documentNumber="REV-2026-0001"
          qrDataUrl={QR_DATA_URL}
          renderContextBoundary={renderContextBoundary}
        />
      );
    };
  }

  it("statically renders the issued multi-page source through the server-safe boundary", async () => {
    const renderDocument = await issuedRender();
    const html = await buildDocumentHtml({
      renderDocument,
      locale: "ar",
      title: "P7-3 Revenue Report Arabic roundtrip",
    });
    expect(html).toContain("تقرير الإيرادات");
    expect(html).toContain("REV-2026-0001");
    expect(html).toContain("Patient 60");
    expect(html).toContain("سياق التقرير والسجل المحاسبي");
    expect(html).toContain("ختم العيادة");
    expect(html).toContain(QR_DATA_URL);
    expect(html).toContain("cf-doc-footer");
    expect(html.length).toBeGreaterThan(50_000);
  });

  it("produces a paginated Arabic A4 PDF through the production renderer", async () => {
    const renderDocument = await issuedRender();
    const result = await renderDocumentPdf({
      locale: "ar",
      title: "P7-3 Revenue Report Arabic roundtrip",
      renderDocument,
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(10_000);
    expect(result.pageCount).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
