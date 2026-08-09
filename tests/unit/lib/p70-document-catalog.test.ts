import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CATALOG,
  DOCUMENT_TYPE_CODES,
  SAFE_VERIFICATION_DISCLOSURE,
  getDocumentCatalogEntry,
  isDocumentTypeCode,
  isRegisteredDocumentType,
} from "@/lib/documents/catalog";
import { DOCUMENT_PDF_RENDERERS } from "@/lib/documents/renderers/registry";

describe("P7-0 document catalog skeleton", () => {
  it("defines the vocabulary: 16 imported designs + 4 P7-12 + 1 P7 Phase 4 generic", () => {
    expect(DOCUMENT_TYPE_CODES).toHaveLength(21);
    expect(new Set(DOCUMENT_TYPE_CODES).size).toBe(21);
    expect(isDocumentTypeCode("REVENUE_REPORT")).toBe(true);
    expect(isDocumentTypeCode("APPOINTMENT_HISTORY_REPORT")).toBe(true);
    expect(isDocumentTypeCode("GENERIC_DOCUMENT")).toBe(true);
    expect(isDocumentTypeCode("RECEIPT")).toBe(false);
  });

  it("preserves the P7-0 entries while later approved batches extend the registry", () => {
    expect(Object.keys(DOCUMENT_CATALOG)).toEqual([
      "REVENUE_REPORT",
      "FOLLOW_UP_PAGE_REPORT",
      "CANCELLATION_REPORT",
      "NO_SHOW_REPORT",
      "SALES_REPORT",
      "FOLLOW_UP_ANALYTICS_REPORT",
      "DOCTOR_PERFORMANCE_REPORT",
      "RECEPTIONIST_PERFORMANCE_REPORT",
      "PATIENT_LIST_REPORT",
      "PATIENT_FILE",
      "PRESCRIPTION",
      "SICK_LEAVE_CERTIFICATE",
      "LAB_REQUEST",
      "SYSTEM_MEMBERS_REPORT",
      "STAFF_FILE",
      "INVOICE",
      // P7-12 — patient history & financial documents.
      "APPOINTMENT_HISTORY_REPORT",
      "PACKAGE_HISTORY_REPORT",
      "DEPOSIT_STATEMENT",
      "PATIENT_FINANCIAL_SUMMARY",
      // P7 Phase 4 — generic free-form ("from scratch") type, registered last.
      "GENERIC_DOCUMENT",
    ]);
    expect(isRegisteredDocumentType("REVENUE_REPORT")).toBe(true);
    expect(isRegisteredDocumentType("STAFF_FILE")).toBe(true);
    expect(isRegisteredDocumentType("PRESCRIPTION")).toBe(true);
    expect(isRegisteredDocumentType("DEPOSIT_STATEMENT")).toBe(true);
    expect(isRegisteredDocumentType("GENERIC_DOCUMENT")).toBe(true);
  });

  it("uses immutable numbering defaults and the strict safe disclosure set", () => {
    expect(getDocumentCatalogEntry("REVENUE_REPORT").numbering).toEqual({
      prefix: "REV",
      yearlyReset: true,
      sequencePadding: 4,
    });
    for (const entry of Object.values(DOCUMENT_CATALOG)) {
      expect(entry.verificationDisclosure).toBe(SAFE_VERIFICATION_DISCLOSURE);
    }
    expect(getDocumentCatalogEntry("REVENUE_REPORT").pageRoles).not.toContain("doctor");
    expect(getDocumentCatalogEntry("INVOICE").pageRoles).not.toContain("assistant");
  });

  it("registers one server PDF renderer for every catalog document type", () => {
    expect(new Set(Object.keys(DOCUMENT_PDF_RENDERERS)))
      .toEqual(new Set(Object.keys(DOCUMENT_CATALOG)));
    for (const code of DOCUMENT_TYPE_CODES) {
      expect(DOCUMENT_PDF_RENDERERS[code]).toEqual(expect.any(Function));
    }
  });
});
