import { describe, expect, it } from "vitest";
import { getAnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import { DOCUMENT_TYPE_CODES, type DocumentTypeCode } from "@/lib/documents/catalog";
import { getClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import { getGenericDocumentCopy } from "@/lib/documents/generic-copy";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import { getPatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import { getRevenueReportCopy } from "@/lib/documents/revenue-copy";
import { getRosterProfileCopy } from "@/lib/documents/roster-profile-copy";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

const ENGLISH_SYSTEM_COPY = [
  "Revenue Report",
  "Report ID",
  "Issued",
  "Time",
  "Period",
  "Total revenue",
  "Breakdown by method and transaction",
  "Paid at",
  "Doctor / Department",
  "Authorized signature",
  "Clinic stamp",
  "Record verification",
  "ClinicFlow Medical Records System",
  "Invoice",
  "Patient information",
  "Responsible physician",
  "Verification",
  "Page",
] as const;

function values(record: Record<string, string>): string[] {
  return Object.values(record);
}

async function arabicSystemCopyFor(code: DocumentTypeCode): Promise<string[]> {
  switch (code) {
    case "REVENUE_REPORT": {
      const copy = await getRevenueReportCopy("ar");
      return [
        copy.title,
        ...values(copy.labels),
        ...values(copy.stats),
        copy.sectionTitle,
        ...values(copy.columns),
        ...values(copy.totals),
        copy.reportContext,
        copy.legalNote,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.accountingApproval,
        copy.clinicStamp,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "FOLLOW_UP_PAGE_REPORT":
    case "CANCELLATION_REPORT":
    case "NO_SHOW_REPORT":
    case "SALES_REPORT":
    case "FOLLOW_UP_ANALYTICS_REPORT":
    case "DOCTOR_PERFORMANCE_REPORT":
    case "RECEPTIONIST_PERFORMANCE_REPORT": {
      const copy = await getAnalyticalReportCopy("ar", code);
      return [
        copy.title,
        ...values(copy.labels),
        copy.sectionTitle,
        copy.description,
        copy.notesTitle,
        copy.notesBody,
        copy.terms.total,
        copy.terms.patient,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.signatureLabel,
        copy.signatureRole,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "PATIENT_LIST_REPORT":
    case "PATIENT_FILE":
    case "SYSTEM_MEMBERS_REPORT":
    case "STAFF_FILE": {
      const copy = getRosterProfileCopy("ar", code);
      return [
        copy.title,
        ...values(copy.labels),
        copy.patientList,
        copy.systemMembers,
        copy.personalDetails,
        copy.employmentDetails,
        copy.weeklySchedule,
        copy.patient,
        copy.doctor,
        copy.department,
        copy.status,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.authorizedSignature,
        copy.medicalDirector,
        copy.employeeSignature,
        copy.stamp,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "PRESCRIPTION":
    case "SICK_LEAVE_CERTIFICATE":
    case "LAB_REQUEST": {
      const copy = getClinicalDocumentCopy("ar", code);
      return [
        copy.title,
        ...values(copy.labels),
        copy.patientInformation,
        copy.physician,
        copy.patientName,
        copy.physicianName,
        copy.medications,
        copy.requestedTests,
        copy.certificateDetails,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.physicianSignature,
        copy.manualSignature,
        copy.stamp,
        copy.clinicApprovalStamp,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "INVOICE": {
      const copy = await getInvoiceCopy("ar");
      return [
        copy.title,
        ...values(copy.labels),
        copy.billTo,
        copy.patientId,
        copy.status,
        ...values(copy.statuses),
        ...values(copy.cards),
        ...values(copy.columns),
        ...values(copy.summary),
        copy.verificationTitle,
        copy.verificationCaption,
        copy.authorizedSignature,
        copy.patientSignature,
        copy.clinicStamp,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "APPOINTMENT_HISTORY_REPORT":
    case "PACKAGE_HISTORY_REPORT":
    case "DEPOSIT_STATEMENT":
    case "PATIENT_FINANCIAL_SUMMARY": {
      const copy = getPatientHistoryCopy("ar", code);
      return [
        copy.title,
        ...values(copy.labels),
        copy.patient,
        copy.fileNumber,
        copy.appointmentHistory,
        copy.packages,
        copy.depositStatement,
        copy.financialSummary,
        copy.date,
        copy.doctor,
        copy.department,
        copy.status,
        copy.amount,
        copy.outstanding,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.authorizedSignature,
        copy.accountsSignature,
        copy.stamp,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
    case "GENERIC_DOCUMENT": {
      const copy = getGenericDocumentCopy("ar");
      return [
        copy.title,
        ...values(copy.labels),
        copy.documentLabel,
        copy.authorizedSignature,
        copy.recipientSignature,
        copy.stamp,
        copy.verificationTitle,
        copy.verificationCaption,
        copy.footerAttribution,
        copy.copyright,
        copy.page,
        copy.of,
      ];
    }
  }
}

describe("P7 Arabic document copy registry", () => {
  it("keeps every shared notice, approval, verification, and footer string locale-pure", () => {
    const flatten = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (!value || typeof value !== "object") return [];
      return Object.values(value).flatMap(flatten);
    };
    const arabic = flatten(getSharedDocumentSectionCopy("ar"));
    const english = flatten(getSharedDocumentSectionCopy("en"));

    expect(arabic.length).toBeGreaterThan(20);
    expect(arabic.join(" | ")).not.toMatch(/[A-Za-z]/);
    expect(english.join(" | ")).not.toMatch(/[\u0600-\u06ff]/);
  });

  it("audits Arabic system copy for all 21 registered document types", async () => {
    expect(DOCUMENT_TYPE_CODES).toHaveLength(21);

    for (const code of DOCUMENT_TYPE_CODES) {
      const copy = await arabicSystemCopyFor(code);
      const joined = copy.join(" | ");

      expect(copy.length, code).toBeGreaterThan(10);
      for (const value of copy) {
        expect(value, `${code}: ${value}`).toMatch(/[\u0600-\u06ff]/);
      }
      for (const english of ENGLISH_SYSTEM_COPY) {
        expect(joined, `${code} leaked: ${english}`).not.toContain(english);
      }
      expect(joined, `${code} leaked Latin system copy`).not.toMatch(/[A-Za-z]/);
      expect(joined, `${code} used Arabic-Indic digits`).not.toMatch(/[٠-٩۰-۹]/);
    }
  });
});
