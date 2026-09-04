import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RevenueReportDocument,
  type RevenueReportCopy,
} from "@/components/documents/templates/revenue-report";
import { getRevenueReportCopy } from "@/lib/documents/revenue-copy";
import type { RevenueDocumentSnapshot } from "@/lib/documents/resolvers/revenue-report";


const copy: RevenueReportCopy = {
  title: "Revenue Report",
  labels: { documentNumber: "Number", issueDate: "Date", issueTime: "Time", period: "Period" },
  stats: {
    totalRevenue: "Total revenue",
    primary: "Primary",
    secondary: "Secondary",
    insurance: "Insurance",
    deposit: "Deposit",
    settlements: "Settlements",
    sessionsAndDeposits: "Sessions and deposits",
  },
  sectionTitle: "Transactions",
  columns: {
    paidAt: "Paid at",
    patient: "Patient",
    doctorDepartment: "Doctor / department",
    total: "Total",
    primary: "Primary",
    secondary: "Secondary",
    insurance: "Insurance",
    deposit: "Deposit",
    outstanding: "Outstanding",
  },
  emptyTransactions: "No transactions",
  totals: {
    patientCollected: "Patient collected",
    grossAllocated: "Gross allocated",
    outstanding: "Outstanding",
  },
  reportContext: "Report context",
  scope: "Scope",
  consolidatedScope: "All clinic",
  filteredScope: "Filtered",
  accountingBasis: "Accounting basis",
  accrualPaidAtDate: "Paid-at date",
  currency: "Currency",
  legalNote: "Internal accounting report.",
  verificationTitle: "Verify",
  verificationCaption: "Scan to verify",
  accountingApproval: "Accounting approval",
  clinicStamp: "Clinic stamp",
  footerAttribution: "ClinicFlow",
  copyright: "ClinicFlow",
  page: "Page",
  of: "of",
  paymentMethods: {
    cash: "Cash",
    card: "Card",
    bank_transfer: "Bank transfer",
    insurance: "Insurance",
    other: "Other",
  },
};

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
    name: "ClinicFlow Demo",
    logoSrc: null,
    address: "Istanbul",
    phone: "+90 555 000 0000",
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
    numberingPrefix: "REV",
    numberingYearlyReset: true,
    sequencePadding: 4,
  },
  summary: {
    totalAmount: 1250,
    primaryTotal: 900,
    secondaryTotal: 100,
    insuranceTotal: 150,
    depositTotal: 100,
    outstandingTotal: 50,
    settlementsTotal: 75,
    patientCollectedTotal: 1100,
    grossTotal: 1250,
    transactionCount: 1,
    settlementCount: 1,
    methodBreakdown: [{ method: "cash", amount: 900 }],
  },
  transactions: [{
    id: "00000000-0000-4000-8000-000000000001",
    paidAt: "2026-07-15T08:15:00.000Z",
    patientName: "Ada Lovelace",
    doctorName: "Dr. Ahmed",
    departmentName: "Dental",
    totalAmount: 1250,
    primaryAmount: 900,
    secondaryAmount: 100,
    insuranceAmount: 150,
    depositAmount: 100,
    outstandingAmount: 50,
  }],
};

describe("P7-3 Revenue Report document", () => {
  it("renders a draft with the frozen primitive order and no official identity", () => {
    const { container } = render(
      <RevenueReportDocument locale="en" lifecycle="preview" snapshot={snapshot} copy={copy} />,
    );
    const page = container.querySelector("[data-testid='document-page']");
    const bodyPrimitives = Array.from(container.querySelectorAll(".cf-document-body [data-testid]"))
      .map((node) => node.getAttribute("data-testid"));

    expect(page).toHaveAttribute("dir", "ltr");
    expect(page).toHaveAttribute("data-lifecycle", "preview");
    expect(bodyPrimitives).toEqual([
      "stat-card-row",
      "section-header",
      "data-table",
      "totals-summary",
      "notes-callout",
      "signature-block",
    ]);
    expect(container).toHaveTextContent("DRAFT");
    expect(container).toHaveTextContent("PREVIEW");
    expect(container).not.toHaveTextContent("REV-2026-0001");
    expect(container.querySelector("[data-testid='verification-block']")).toBeNull();
    expect(container.querySelector(".cf-doc-page-number")).toBeNull();
    expect(container.querySelector(".cf-doc-stamp-slot")).toHaveTextContent("Clinic stamp");
    expect(container.querySelector(".cf-doc-table-total-label"))
      .toHaveTextContent("Gross allocated");
    expect(container.querySelector(".cf-doc-table-total-label"))
      .toHaveStyle({ whiteSpace: "nowrap" });
    expect(container.querySelector(".cf-doc-table col:nth-child(2)"))
      .toHaveStyle({ width: "16%" });
    expect(container).toHaveTextContent("Report context");
    expect(container).toHaveTextContent("TRY 1,250");
    expect(container).not.toHaveTextContent("1,250.00");
    // A revenue report carries no person photos, only names.
    expect(container.querySelectorAll(".cf-doc-list-avatar")).toHaveLength(0);
  });

  it("renders fully localized Arabic system copy with canonical number and QR", async () => {
    const arabicCopy = await getRevenueReportCopy("ar");
    const { container } = render(
      <RevenueReportDocument
        locale="ar"
        lifecycle="issued"
        snapshot={snapshot}
        copy={arabicCopy}
        documentNumber="REV-2026-0001"
        qrDataUrl="data:image/png;base64,iVBORw0KGgo="
        pageCount={2}
      />,
    );

    expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
    expect(container).toHaveTextContent("REV-2026-0001");
    expect(container).toHaveTextContent("Ada Lovelace");
    expect(container).toHaveTextContent("Dr. Ahmed");
    expect(container.querySelectorAll(".cf-doc-table thead th")).toHaveLength(9);
    expect(container.querySelector("[data-testid='verification-block'] img"))
      .toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(container.querySelector("[data-testid='verification-block']")?.closest("footer"))
      .toBe(container.querySelector("[data-testid='document-footer']"));
    expect(container.querySelector(".cf-document-body [data-testid='verification-block']"))
      .toBeNull();
    expect(container.querySelector(".cf-doc-title")).toHaveTextContent("تقرير الإيرادات");
    expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم التقرير");
    expect(container.querySelector("[data-testid='stat-card-row']"))
      .toHaveTextContent("إجمالي الإيرادات");
    expect(container.querySelector("[data-testid='section-header']"))
      .toHaveTextContent("التوزيع حسب الوسيلة والمعاملة");
    expect(container.querySelector("[data-testid='data-table'] thead"))
      .toHaveTextContent("الطبيب / القسم");
    expect(container.querySelector("[data-testid='signature-block']"))
      .toHaveTextContent("اعتماد المحاسبة / التوقيع المعتمد");
    expect(container.querySelector(".cf-doc-stamp-slot")).toHaveTextContent("ختم العيادة");
    expect(container.querySelector("[data-testid='document-footer']"))
      .toHaveTextContent("نظام كلينيك فلو للسجلات الطبية");
    expect(container.querySelector(".cf-doc-page-number")).toHaveTextContent("صفحة 1 من 2");
    for (const english of [
      "Revenue Report",
      "Report ID",
      "Total revenue",
      "Breakdown by method and transaction",
      "Accounting approval / Authorized signature",
      "Clinic stamp",
      "ClinicFlow Medical Records System",
      "Page 1 of 2",
    ]) {
      expect(container).not.toHaveTextContent(english);
    }
    expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });

  it("keeps long fixed-layout report rows free of person photos", () => {
    const transactions = Array.from({ length: 100 }, (_, index) => ({
      ...snapshot.transactions[0],
      id: `row-${index}`,
    }));
    const { container } = render(
      <RevenueReportDocument locale="en" lifecycle="preview"
        snapshot={{ ...snapshot, transactions }} copy={copy} />,
    );
    expect(container.querySelectorAll(".cf-doc-table tbody tr")).toHaveLength(100);
    expect(container.querySelectorAll(".cf-doc-list-avatar")).toHaveLength(0);
    expect(container.querySelector(".cf-doc-table")).toHaveClass("cf-doc-table");
  });
});
