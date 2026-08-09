import { describe, expect, it } from "vitest";
import { AnalyticalReportDocument } from "@/components/documents/templates/analytical-reports";
import { buildDocumentHtml, renderDocumentPdf } from "@/lib/documents/pdf";
import { getAnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import type { AnalyticalDocumentSnapshot } from "@/lib/documents/resolvers/analytical-report";

const snapshot: AnalyticalDocumentSnapshot = {
  version: 1,
  documentType: "FOLLOW_UP_PAGE_REPORT",
  generatedAt: "2026-08-09T10:00:00.000Z",
  range: {
    from: "2026-08-02",
    to: "2026-08-07",
    start: "2026-08-01T21:00:00.000Z",
    end: "2026-08-07T20:59:59.999Z",
  },
  filters: {
    doctorId: "11111111-1111-4111-8111-111111111111",
    departmentId: "22222222-2222-4222-8222-222222222222",
    receptionistId: null,
    outcome: "has_problem",
    patientQuery: "Ada",
    patientName: "Lovelace",
    patientFileNumber: "CF-0013",
    patientNationalId: null,
    patientPhone: null,
  },
  branding: {
    name: "ClinicFlow Medical Group",
    logoSrc: null,
    address: "Medical District",
    phone: "+90 212 555 0199",
    email: "clinic@example.com",
    website: "clinic.example.com",
    licenseNo: "LIC-42",
    taxId: "TAX-42",
    footerText: null,
  },
  format: { currency: "TRY", timeZone: "Europe/Istanbul", timeFormat: "24h" },
  settings: {
    watermark: "CONFIDENTIAL",
    qrEnabled: true,
    numberingPrefix: "FU",
    numberingYearlyReset: true,
    sequencePadding: 4,
  },
  data: {
    kind: "follow-up-page",
    pendingCount: 0,
    completedCount: 1,
    allFineCount: 0,
    hasProblemCount: 1,
    noResponseCount: 0,
    rows: [{
      id: "follow-up-1",
      recordedAt: "2026-08-05T08:22:00.000Z",
      outcome: "has_problem",
      notes: "Filtered follow-up note",
      patientName: "Ada Lovelace",
      patientFileNumber: "CF-0013",
      doctorName: "Dr. Sara Emad",
      departmentName: "Dermatology",
    }],
  },
};

describe("P7 Follow-ups filtered PDF rendering", () => {
  async function issuedRender() {
    const copy = await getAnalyticalReportCopy("en", "FOLLOW_UP_PAGE_REPORT");
    return function renderIssuedFollowups(
      renderContextBoundary: Parameters<typeof AnalyticalReportDocument>[0]["renderContextBoundary"],
    ) {
      return (
        <AnalyticalReportDocument
          locale="en"
          lifecycle="issued"
          snapshot={snapshot}
          copy={copy}
          documentNumber="FU-2026-0001"
          qrDataUrl="data:image/png;base64,iVBORw0KGgo="
          renderContextBoundary={renderContextBoundary}
        />
      );
    };
  }

  it("keeps the selected period and filtered row in the PDF source", async () => {
    const html = await buildDocumentHtml({
      locale: "en",
      title: "Filtered Follow-up document",
      renderDocument: await issuedRender(),
    });
    expect(html).toContain("Aug 2, 2026 — Aug 7, 2026");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Filtered follow-up note");
    expect(html).toContain("FU-2026-0001");
  });

  it("produces a real PDF through the production renderer", async () => {
    const result = await renderDocumentPdf({
      locale: "en",
      title: "Filtered Follow-up document",
      renderDocument: await issuedRender(),
    });
    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(10_000);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
