import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticalReportDocument } from "@/components/documents/templates/analytical-reports";
import type { AnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import type {
  AnalyticalDocumentSnapshot,
  P74AnalyticalDocumentCode,
} from "@/lib/documents/resolvers/analytical-report";
import en from "../../../messages/en.json";
import ar from "../../../messages/ar.json";

const reportKey = {
  FOLLOW_UP_PAGE_REPORT: "followUpPage",
  CANCELLATION_REPORT: "cancellation",
  NO_SHOW_REPORT: "noShow",
  SALES_REPORT: "sales",
  FOLLOW_UP_ANALYTICS_REPORT: "followUpAnalytics",
  DOCTOR_PERFORMANCE_REPORT: "doctorPerformance",
  RECEPTIONIST_PERFORMANCE_REPORT: "receptionistPerformance",
} as const;

function copyFor(
  locale: "ar" | "en",
  code: P74AnalyticalDocumentCode,
): AnalyticalReportCopy {
  const messages = locale === "ar" ? ar : en;
  const source = messages.documentPlatform.analytical;
  const report = source.reports[reportKey[code]];
  return {
    ...report,
    labels: source.labels,
    terms: source.terms,
    outcomes: {
      all_fine: source.outcomes.allFine,
      has_problem: source.outcomes.hasProblem,
      no_response: source.outcomes.noResponse,
    },
    paymentMethods: {
      cash: source.paymentMethods.cash,
      card: source.paymentMethods.card,
      credit_card: source.paymentMethods.card,
      bank_transfer: source.paymentMethods.bankTransfer,
      paypal: source.paymentMethods.paypal,
      insurance: source.paymentMethods.insurance,
      other: source.paymentMethods.other,
    },
    verificationTitle: source.verificationTitle,
    verificationCaption: source.verificationCaption,
    signatureLabel: source.signatureLabel,
    signatureRole: source.signatureRole,
    footerAttribution: source.footerAttribution,
    copyright: source.copyright,
    page: source.page,
    of: source.of,
  };
}

const dataByType: Record<
  P74AnalyticalDocumentCode,
  AnalyticalDocumentSnapshot["data"]
> = {
  FOLLOW_UP_PAGE_REPORT: {
    kind: "follow-up-page",
    pendingCount: 0,
    completedCount: 1,
    allFineCount: 1,
    hasProblemCount: 0,
    noResponseCount: 0,
    rows: [{
      id: "follow-up-1",
      recordedAt: "2026-07-15T08:22:00.000Z",
      outcome: "all_fine",
      notes: null,
      patientName: "Ada Lovelace",
      patientFileNumber: "CF-0013",
      doctorName: "Dr. Sara Emad",
      departmentName: "Dermatology",
    }],
  },
  CANCELLATION_REPORT: {
    kind: "cancellation",
    totalAppointments: 4,
    cancelledCount: 1,
    cancellationRate: 25,
    replacedCount: 1,
    replacementRate: 25,
    byDoctor: [{
      doctorId: "doctor-1",
      doctorName: "Dr. Sara Emad",
      total: 4,
      cancelled: 1,
      rate: 25,
    }],
    byReason: [{ reason: "Schedule conflict", count: 1 }],
  },
  NO_SHOW_REPORT: {
    kind: "no-show",
    totalAppointments: 4,
    noShowCount: 1,
    noShowRate: 25,
    replacedCount: 0,
    replacementRate: 0,
    byDoctor: [{
      doctorId: "doctor-1",
      doctorName: "Dr. Sara Emad",
      total: 4,
      noShow: 1,
      rate: 25,
    }],
  },
  SALES_REPORT: {
    kind: "sales",
    serviceTotal: 15150,
    primaryTotal: 10100,
    secondaryTotal: 2600,
    insuranceTotal: 1700,
    depositTotal: 0,
    settlementTotal: 750,
    outstandingTotal: 0,
    collectedTotal: 15150,
    transactionCount: 8,
    settlementCount: 2,
    paymentMethods: [{ method: "cash", amount: 10850 }],
  },
  FOLLOW_UP_ANALYTICS_REPORT: {
    kind: "follow-up-analytics",
    completedCount: 1,
    allFineCount: 1,
    hasProblemCount: 0,
    noResponseCount: 0,
    outcomes: [
      { outcome: "all_fine", count: 1, rate: 100 },
      { outcome: "has_problem", count: 0, rate: 0 },
      { outcome: "no_response", count: 0, rate: 0 },
    ],
  },
  DOCTOR_PERFORMANCE_REPORT: {
    kind: "doctor-performance",
    doctors: [{
      doctorId: "doctor-1",
      doctorName: "Dr. Sara Emad",
      departmentId: "department-1",
      sessions: 1,
      completed: 1,
      cancelled: 0,
      noShow: 0,
      uniquePatients: 1,
      revenue: 3500,
      completionRate: 100,
      cancellationRate: 0,
      noShowRate: 0,
      deptPatientShare: 100,
      clinicPatientShare: 100,
      deptRevenueShare: 100,
      clinicRevenueShare: 100,
    }],
  },
  RECEPTIONIST_PERFORMANCE_REPORT: {
    kind: "receptionist-performance",
    receptionists: [{
      id: "receptionist-1",
      name: "Nada Ali",
      appointmentsBooked: 2,
      appointmentShare: 100,
      followupsHandled: 1,
      followupShare: 100,
    }],
  },
};

function snapshot(
  code: P74AnalyticalDocumentCode,
): AnalyticalDocumentSnapshot {
  return {
    version: 1,
    documentType: code,
    generatedAt: "2026-08-01T09:15:00.000Z",
    range: {
      from: "2026-07-01",
      to: "2026-07-31",
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-07-31T23:59:59.999Z",
    },
    filters: {
      doctorId: null,
      departmentId: null,
      receptionistId: null,
      outcome: null,
      patientQuery: null,
      patientName: null,
      patientFileNumber: null,
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
      numberingPrefix: "RPT",
      numberingYearlyReset: true,
      sequencePadding: 4,
    },
    data: dataByType[code],
  };
}

const primitiveOrder: Record<P74AnalyticalDocumentCode, string[]> = {
  FOLLOW_UP_PAGE_REPORT: ["section-header", "stat-card-row", "data-table"],
  CANCELLATION_REPORT: ["notes-callout", "stat-card-row", "section-header", "data-table", "totals-summary"],
  NO_SHOW_REPORT: ["stat-card-row", "section-header", "data-table", "totals-summary", "notes-callout"],
  SALES_REPORT: ["section-header", "stat-card-row", "data-table", "data-table", "totals-summary", "notes-callout"],
  FOLLOW_UP_ANALYTICS_REPORT: ["section-header", "notes-callout", "stat-card-row", "data-table"],
  DOCTOR_PERFORMANCE_REPORT: ["stat-card-row", "section-header", "data-table", "notes-callout"],
  RECEPTIONIST_PERFORMANCE_REPORT: ["section-header", "notes-callout", "stat-card-row", "data-table"],
};

describe("P7-4 analytical document templates", () => {
  it.each(["en", "ar"] as const)(
    "supports the Follow-up document Preview in %s",
    (locale) => {
      const { container } = render(
        <AnalyticalReportDocument
          locale={locale}
          lifecycle="preview"
          snapshot={snapshot("FOLLOW_UP_PAGE_REPORT")}
          copy={copyFor(locale, "FOLLOW_UP_PAGE_REPORT")}
        />,
      );
      expect(container.querySelector("[data-testid='document-page']"))
        .toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      expect(container).toHaveTextContent(copyFor(locale, "FOLLOW_UP_PAGE_REPORT").title);
      expect(container).toHaveTextContent(locale === "ar" ? "معاينة" : "PREVIEW");
    },
  );

  it.each(Object.keys(dataByType) as P74AnalyticalDocumentCode[])(
    "renders %s through its approved primitive order",
    (code) => {
      const { container } = render(
        <AnalyticalReportDocument
          locale="en"
          lifecycle="preview"
          snapshot={snapshot(code)}
          copy={copyFor("en", code)}
        />,
      );
      const directBodyPrimitives = Array.from(
        container.querySelectorAll(".cf-document-body > [data-testid]"),
      ).map((node) => node.getAttribute("data-testid"));
      expect(directBodyPrimitives).toEqual([
        ...primitiveOrder[code],
        "signature-block",
      ]);
      expect(container).toHaveTextContent("DRAFT");
      expect(container).toHaveTextContent("PREVIEW");
      expect(container.querySelector("[data-testid='verification-block']")).toBeNull();
    },
  );

  it.each(Object.keys(dataByType) as P74AnalyticalDocumentCode[])(
    "renders %s issued in Arabic with Latin digits and a real QR slot",
    (code) => {
      const copy = copyFor("ar", code);
      const { container } = render(
        <AnalyticalReportDocument
          locale="ar"
          lifecycle="issued"
          snapshot={snapshot(code)}
          copy={copy}
          documentNumber="RPT-2026-0001"
          qrDataUrl="data:image/png;base64,iVBORw0KGgo="
        />,
      );
      expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
      expect(container).toHaveTextContent("RPT-2026-0001");
      expect(container.querySelector("[data-testid='verification-block'] img"))
        .toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
      expect(container.querySelector(".cf-doc-title")).toHaveTextContent(copy.title);
      expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم التقرير");
      expect(container).toHaveTextContent(copy.sectionTitle);
      expect(container.querySelector("[data-testid='verification-block']"))
        .toHaveTextContent(copy.verificationTitle);
      expect(container.querySelector("[data-testid='signature-block']"))
        .toHaveTextContent(copy.signatureLabel);
      expect(container.querySelector("[data-testid='document-footer']"))
        .toHaveTextContent(copy.footerAttribution);
      for (const english of [
        copyFor("en", code).title,
        "Report ID",
        "Authorized signature",
        "Clinic administrator",
        "ClinicFlow Medical Records System",
      ]) {
        expect(container).not.toHaveTextContent(english);
      }
      expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
    },
  );
});
