import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PatientHistoryDocument } from "@/components/documents/templates/patient-history-documents";
import { getPatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import {
  patientHistoryDocumentSnapshotSchema,
  type PatientHistoryDocumentSnapshot,
} from "@/lib/documents/resolvers/patient-history";

const BASE = {
  version: 1 as const,
  generatedAt: "2026-08-02T10:00:00.000Z",
  range: { preset: "all", from: null, to: null },
  branding: {
    name: "Clinic", logoSrc: null, address: null, phone: null, email: null,
    website: null, licenseNo: null, taxId: null, footerText: null,
  },
  format: { currency: "TRY", timeZone: "Europe/Istanbul", timeFormat: "24h" as const },
  settings: {
    watermark: null, qrEnabled: true, numberingPrefix: "APH",
    numberingYearlyReset: true, sequencePadding: 4,
  },
  patient: { fullName: "Jane Doe", fileNumber: "F-100", phone: "5551234" },
};

const DATA: Record<PatientHistoryDocumentSnapshot["documentType"], PatientHistoryDocumentSnapshot["data"]> = {
  APPOINTMENT_HISTORY_REPORT: {
    kind: "appointment-history", financialVisible: true, totalCount: 1,
    entries: [{
      id: "a1", scheduledAt: "2026-07-01T09:00:00.000Z", status: "completed",
      doctorName: "Dr. Smith", departmentName: "Dental",
      followUps: [{ outcome: "all_fine", notes: null, recordedAt: "2026-07-02T09:00:00.000Z" }],
      note: "Routine check", relatedDocuments: [{ docType: "INVOICE", documentNumber: "INV-2026-0001" }],
      billing: { total: 250, collected: 200, outstanding: 50 },
    }],
    billingTotals: { billed: 250, collected: 200, outstanding: 50 },
  },
  PACKAGE_HISTORY_REPORT: {
    kind: "package-history",
    packages: [{
      id: "p1", name: "Cleaning x5", departmentName: "Dental", purchasedSessions: 5,
      usedSessions: 2, remainingSessions: 3, pricePerSession: 100, isActive: true,
      createdAt: "2026-06-01T09:00:00.000Z",
    }],
    totals: { purchasedSessions: 5, usedSessions: 2, remainingSessions: 3 },
  },
  DEPOSIT_STATEMENT: {
    kind: "deposit-statement", openingBalance: 0, currentBalance: 300,
    totalDeposited: 500, totalSpent: 200,
    transactions: [{
      id: "d1", createdAt: "2026-06-10T09:00:00.000Z", amount: 500, note: "Cash deposit",
      recordedByName: "Reception", runningBalance: 500,
    }],
  },
  PATIENT_FINANCIAL_SUMMARY: {
    kind: "financial-summary", appointmentCharges: 1000, payments: 800, outstanding: 200,
    depositsBalance: 300, totalDeposited: 500, packageBalance: 400, activePackages: 1,
  },
};

function snapshotFor(
  documentType: PatientHistoryDocumentSnapshot["documentType"],
): PatientHistoryDocumentSnapshot {
  return patientHistoryDocumentSnapshotSchema.parse({
    ...BASE,
    documentType,
    data: DATA[documentType],
  });
}

describe("P7-12 patient history document rendering", () => {
  const types = [
    "APPOINTMENT_HISTORY_REPORT",
    "PACKAGE_HISTORY_REPORT",
    "DEPOSIT_STATEMENT",
    "PATIENT_FINANCIAL_SUMMARY",
  ] as const;

  it("renders each type on the shared document chrome in EN and AR with Latin digits", () => {
    for (const documentType of types) {
      const snapshot = snapshotFor(documentType);
      for (const locale of ["en", "ar"] as const) {
        const copy = getPatientHistoryCopy(locale, documentType);
        const { container, unmount } = render(
          <PatientHistoryDocument
            locale={locale}
            lifecycle="issued"
            snapshot={snapshot}
            copy={copy}
            documentNumber="APH-2026-0001"
            qrDataUrl="data:image/png;base64,iVBORw0KGgo="
          />,
        );
        const page = container.querySelector<HTMLElement>("[data-testid='document-page']");
        expect(page).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(container.textContent).toContain(copy.title);
        expect(container.textContent).toContain("Jane Doe");
        // A history report is not the patient file: it carries no person photo,
        // only the initials identity avatar.
        expect(container.querySelector(".cf-doc-avatar-foreground")).toBeNull();
        expect(container.querySelector(".cf-doc-avatar-background")).toBeNull();
        expect(container.querySelectorAll(".cf-doc-list-avatar")).toHaveLength(0);
        if (documentType === "APPOINTMENT_HISTORY_REPORT" && locale === "ar") {
          expect(container).toHaveTextContent("مكتمل");
          expect(container).toHaveTextContent("كل شيء بخير");
          expect(container).not.toHaveTextContent("completed");
          expect(container).not.toHaveTextContent("all_fine");
        }
        if (locale === "ar") {
          expect(container.querySelector(".cf-doc-title")).toHaveTextContent(copy.title);
          expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم المستند");
          expect(container.querySelector("[data-testid='verification-block']"))
            .toHaveTextContent("التحقق");
          expect(container.querySelector("[data-testid='signature-block']"))
            .toHaveTextContent(
              documentType === "DEPOSIT_STATEMENT" || documentType === "PATIENT_FINANCIAL_SUMMARY"
                ? "الحسابات / التوقيع المعتمد"
                : "التوقيع المعتمد",
            );
          expect(container.querySelector(".cf-doc-stamp-slot")).toHaveTextContent("ختم العيادة");
          expect(container.querySelector("[data-testid='document-footer']"))
            .toHaveTextContent("نظام كلينيك فلو للسجلات الطبية");
          for (const english of [
            getPatientHistoryCopy("en", documentType).title,
            "Document no.",
            "Authorized signature",
            "Accounts / authorized signature",
            "Clinic stamp",
            "ClinicFlow Medical Records System",
          ]) {
            expect(container).not.toHaveTextContent(english);
          }
        }
        // Latin digits only — no Arabic-Indic glyphs leak into the rendered doc.
        expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
        unmount();
      }
    }
  });

  it("hides billing for scoped clinical roles in the appointment history report", () => {
    const snapshot = patientHistoryDocumentSnapshotSchema.parse({
      ...BASE,
      documentType: "APPOINTMENT_HISTORY_REPORT",
      data: {
        kind: "appointment-history", financialVisible: false, totalCount: 1,
        entries: [{
          id: "a1", scheduledAt: "2026-07-01T09:00:00.000Z", status: "completed",
          doctorName: "Dr. Smith", departmentName: "Dental", followUps: [],
          note: "Routine check", relatedDocuments: [], billing: null,
        }],
        billingTotals: null,
      },
    });
    const copy = getPatientHistoryCopy("en", "APPOINTMENT_HISTORY_REPORT");
    const { container } = render(
      <PatientHistoryDocument
        locale="en" lifecycle="issued" snapshot={snapshot} copy={copy}
        documentNumber="APH-2026-0001" qrDataUrl="data:image/png;base64,iVBORw0KGgo="
      />,
    );
    // No money value is present and the outstanding-totals block is absent.
    expect(container.textContent).not.toMatch(/₺|TRY/);
  });
});
