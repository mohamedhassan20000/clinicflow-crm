import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CATALOG,
  getDocumentCatalogEntry,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import {
  REGISTERED_DOCUMENT_TYPE_CODES,
  canRoleAccessDocumentType,
  createDocumentHref,
  createFlowIsDirect,
  documentFilterKeysFor,
  documentNeedsSetup,
  DOCUMENT_STATUS_VALUES,
  documentDraftHrefs,
  documentPreviewSurfaceHref,
  documentSetupFields,
  documentSurfaceKind,
  getAccessibleDocumentTypeCodes,
  groupDocumentTypesByArchetype,
  renderedDocumentHref,
} from "@/lib/documents/module";

describe("P7-8 document-module helpers", () => {
  it("registers all 21 document types (16 imported + 4 P7-12 + 1 P7 Phase 4 generic)", () => {
    expect(REGISTERED_DOCUMENT_TYPE_CODES).toHaveLength(21);
    expect(REGISTERED_DOCUMENT_TYPE_CODES).toContain("GENERIC_DOCUMENT");
  });

  it("role accessibility mirrors each catalog entry's pageRoles", () => {
    for (const code of REGISTERED_DOCUMENT_TYPE_CODES) {
      const roles = DOCUMENT_CATALOG[code].pageRoles as readonly string[];
      for (const role of ["admin", "manager", "receptionist", "doctor", "assistant"] as const) {
        expect(canRoleAccessDocumentType(role, code)).toBe(roles.includes(role));
      }
    }
  });

  it("gives an admin the full catalog and a doctor only its scoped subset", () => {
    expect(getAccessibleDocumentTypeCodes("admin")).toHaveLength(21);
    const doctor = getAccessibleDocumentTypeCodes("doctor");
    // A doctor cannot issue the invoice, revenue, or performance reports.
    expect(doctor).not.toContain("INVOICE");
    expect(doctor).not.toContain("REVENUE_REPORT");
    expect(doctor).not.toContain("DOCTOR_PERFORMANCE_REPORT");
    // But can prepare clinical documents and see the follow-up report.
    expect(doctor).toContain("PRESCRIPTION");
    expect(doctor).toContain("LAB_REQUEST");
    expect(doctor).toContain("SICK_LEAVE_CERTIFICATE");
  });

  it("never invents a type the role cannot access", () => {
    for (const role of ["admin", "manager", "receptionist", "doctor", "assistant"] as const) {
      for (const code of getAccessibleDocumentTypeCodes(role)) {
        expect(canRoleAccessDocumentType(role, code)).toBe(true);
      }
    }
  });

  it("groups codes by archetype in the fixed display order", () => {
    const groups = groupDocumentTypesByArchetype(REGISTERED_DOCUMENT_TYPE_CODES);
    expect(groups.map((group) => group.archetype)).toEqual([
      "financial",
      "clinical",
      "analytical",
      "roster",
      "profile",
      "history",
      "generic",
    ]);
    const grouped = groups.flatMap((group) => group.codes);
    expect(grouped.sort()).toEqual([...REGISTERED_DOCUMENT_TYPE_CODES].sort());
  });

  it("drops archetypes with no present codes", () => {
    const groups = groupDocumentTypesByArchetype(["INVOICE", "PRESCRIPTION"]);
    expect(groups.map((group) => group.archetype)).toEqual(["financial", "clinical"]);
  });

  it("maps every registered type to a rendering surface", () => {
    for (const code of REGISTERED_DOCUMENT_TYPE_CODES) {
      const href = renderedDocumentHref(code, "doc-123");
      expect(href).not.toBeNull();
      expect(href).toContain("documentId=doc-123");
    }
  });

  it("routes rendering surfaces to the already-built P7-3…P7-7 pages", () => {
    expect(renderedDocumentHref("REVENUE_REPORT", "d")).toBe(
      "/reports/revenue/document?documentId=d",
    );
    expect(renderedDocumentHref("NO_SHOW_REPORT", "d")).toBe(
      "/reports/no-shows/document?documentId=d",
    );
    expect(renderedDocumentHref("PATIENT_FILE", "d")).toBe(
      "/documents/roster-profile/patient-file?documentId=d",
    );
    expect(renderedDocumentHref("PRESCRIPTION", "d")).toBe(
      "/documents/clinical/prescription?documentId=d",
    );
    expect(renderedDocumentHref("INVOICE", "d")).toBe(
      "/appointments/invoice/document?documentId=d",
    );
    expect(renderedDocumentHref("APPOINTMENT_HISTORY_REPORT", "d")).toBe(
      "/documents/patient-history/appointment-history?documentId=d",
    );
    expect(renderedDocumentHref("DEPOSIT_STATEMENT", "d")).toBe(
      "/documents/patient-history/deposit-statement?documentId=d",
    );
  });

  it("encodes the document id into the rendering href", () => {
    expect(renderedDocumentHref("INVOICE", "a b/c")).toContain("documentId=a%20b%2Fc");
  });

  it("dispatches clinical create flows to the shared authoring form", () => {
    expect(createDocumentHref("PRESCRIPTION")).toBe("/documents/new/clinical/prescription");
    expect(createDocumentHref("LAB_REQUEST")).toBe("/documents/new/clinical/lab-request");
    expect(createDocumentHref("SICK_LEAVE_CERTIFICATE")).toBe(
      "/documents/new/clinical/sick-leave",
    );
  });

  it("routes subject-bound create flows to their dedicated setup or source surfaces", () => {
    expect(createDocumentHref("PATIENT_FILE")).toBe("/patients");
    expect(createDocumentHref("STAFF_FILE")).toBe("/settings/staff");
    expect(createDocumentHref("INVOICE")).toBe("/documents/new/invoice");
    expect(createFlowIsDirect("PATIENT_FILE")).toBe(false);
    expect(createFlowIsDirect("STAFF_FILE")).toBe(false);
    expect(createFlowIsDirect("INVOICE")).toBe(true);
    expect(createFlowIsDirect("REVENUE_REPORT")).toBe(true);
    expect(createFlowIsDirect("PRESCRIPTION")).toBe(true);
    expect(createDocumentHref("APPOINTMENT_HISTORY_REPORT")).toBe(
      "/documents/new/patient-history/appointment-history",
    );
    expect(createDocumentHref("PACKAGE_HISTORY_REPORT")).toBe(
      "/documents/new/patient-history/package-history",
    );
    expect(createDocumentHref("DEPOSIT_STATEMENT")).toBe(
      "/documents/new/patient-history/deposit-statement",
    );
    expect(createDocumentHref("PATIENT_FINANCIAL_SUMMARY")).toBe(
      "/documents/new/patient-history/financial-summary",
    );
    expect(createFlowIsDirect("DEPOSIT_STATEMENT")).toBe(true);
  });

  it("never sends a New Document flow to an unrelated fallback route", () => {
    const forbidden = new Set(["/", "/dashboard", "/appointments"]);
    for (const code of REGISTERED_DOCUMENT_TYPE_CODES) {
      const href = createDocumentHref(code);
      expect(forbidden.has(href), code).toBe(false);
      if (code !== "PATIENT_FILE") expect(href, code).not.toBe("/patients");
      expect(href, code).not.toContain("404");
    }
  });

  it("shows only shared filters when no type is selected", () => {
    expect(documentFilterKeysFor(null).sort()).toEqual(
      ["creator", "date", "documentNumber", "search", "status"].sort(),
    );
  });

  it("uses the Not Issued → Issued → Cancelled module lifecycle without Void", () => {
    expect(DOCUMENT_STATUS_VALUES).toEqual(["not_issued", "issued", "cancelled"]);
    expect(DOCUMENT_STATUS_VALUES).not.toContain("void" as never);
  });

  it("reconstructs editable and previewable draft links for every family", () => {
    expect(documentDraftHrefs("INVOICE", "draft-1", { appointmentId: "appt-1" }, "en"))
      .toEqual({
        previewHref: "/appointments/invoice/document?locale=en&origin=documents&draftId=draft-1&appointmentId=appt-1",
        editHref: "/documents/new/invoice?draftId=draft-1",
      });
    expect(documentDraftHrefs("PRESCRIPTION", "draft-2", { recordId: "record-1" }, "ar"))
      .toEqual({
        previewHref: "/documents/clinical/prescription?locale=ar&origin=documents&draftId=draft-2&recordId=record-1",
        editHref: "/documents/new/clinical/prescription?draftId=draft-2",
      });
    expect(documentDraftHrefs("GENERIC_DOCUMENT", "draft-3", {}, "en"))
      .toEqual({
        previewHref: "/documents/new/scratch?draftId=draft-3",
        editHref: "/documents/new/scratch?draftId=draft-3",
      });
  });

  it("adds a type's own filters on top of the always-present shared keys", () => {
    const keys = documentFilterKeysFor("PRESCRIPTION");
    expect(keys).toContain("patient");
    expect(keys).toContain("doctor");
    expect(keys).toContain("date");
    expect(keys).toContain("documentNumber");
    expect(keys).toContain("creator");
  });

  it("enables external-subject support only for the three clinical types (founder decision)", () => {
    const externalSubjectTypes = new Set<RegisteredDocumentTypeCode>([
      "PRESCRIPTION",
      "LAB_REQUEST",
      "SICK_LEAVE_CERTIFICATE",
    ]);
    for (const code of REGISTERED_DOCUMENT_TYPE_CODES as RegisteredDocumentTypeCode[]) {
      expect(getDocumentCatalogEntry(code).allowsExternalSubject ?? false).toBe(
        externalSubjectTypes.has(code),
      );
    }
  });
});

describe("P7 Phase 4 — setup flow + generic document routing", () => {
  it("routes data-generated (Type A) create flows through the setup popup", () => {
    for (const code of [
      "REVENUE_REPORT", "FOLLOW_UP_PAGE_REPORT", "CANCELLATION_REPORT", "NO_SHOW_REPORT",
      "SALES_REPORT", "FOLLOW_UP_ANALYTICS_REPORT", "DOCTOR_PERFORMANCE_REPORT",
      "RECEPTIONIST_PERFORMANCE_REPORT", "PATIENT_LIST_REPORT", "SYSTEM_MEMBERS_REPORT",
    ] as const) {
      expect(documentNeedsSetup(code)).toBe(true);
      expect(createDocumentHref(code)).toBe(`/documents/new/setup/${code}`);
    }
  });

  it("resolves each Type A type's preview surface for the setup Save target", () => {
    expect(documentPreviewSurfaceHref("REVENUE_REPORT")).toBe("/reports/revenue/document");
    expect(documentPreviewSurfaceHref("NO_SHOW_REPORT")).toBe("/reports/no-shows/document");
    expect(documentPreviewSurfaceHref("PATIENT_LIST_REPORT")).toBe(
      "/documents/roster-profile/patient-list",
    );
    expect(documentPreviewSurfaceHref("SYSTEM_MEMBERS_REPORT")).toBe(
      "/documents/roster-profile/system-members",
    );
  });

  it("derives type-appropriate setup fields from the catalog filterSchema", () => {
    expect(documentSetupFields("REVENUE_REPORT")).toEqual([
      { key: "dateRange" },
      { key: "doctor", param: "doctor" },
      { key: "department", param: "department" },
    ]);
    expect(documentSetupFields("RECEPTIONIST_PERFORMANCE_REPORT")).toEqual([
      { key: "dateRange" },
      { key: "receptionist", param: "receptionist" },
    ]);
    expect(documentSetupFields("PATIENT_LIST_REPORT")).toEqual([
      { key: "doctor", param: "doctor" },
      { key: "department", param: "department" },
      { key: "search", param: "q" },
    ]);
    expect(documentSetupFields("SYSTEM_MEMBERS_REPORT")).toEqual([
      { key: "department", param: "department" },
      { key: "search", param: "q" },
    ]);
  });

  it("classifies surface families used by the setup + preview filters", () => {
    expect(documentSurfaceKind("REVENUE_REPORT")).toBe("analytical");
    expect(documentSurfaceKind("PATIENT_LIST_REPORT")).toBe("roster");
    expect(documentSurfaceKind("PATIENT_FILE")).toBe("other");
    expect(documentSurfaceKind("GENERIC_DOCUMENT")).toBe("other");
  });

  it("opens the generic free-form type on its empty authoring form, not a setup popup", () => {
    expect(documentNeedsSetup("GENERIC_DOCUMENT")).toBe(false);
    expect(documentSetupFields("GENERIC_DOCUMENT")).toEqual([]);
    expect(createDocumentHref("GENERIC_DOCUMENT")).toBe("/documents/new/scratch");
    expect(renderedDocumentHref("GENERIC_DOCUMENT", "gen-1")).toBe(
      "/documents/generic?documentId=gen-1",
    );
  });

  it("keeps subject-bound and clinical types out of the setup flow", () => {
    for (const code of ["PATIENT_FILE", "STAFF_FILE", "INVOICE", "PRESCRIPTION",
      "APPOINTMENT_HISTORY_REPORT"] as const) {
      expect(documentNeedsSetup(code)).toBe(false);
    }
  });

  it("registers the generic type last, under its own archetype", () => {
    expect(getDocumentCatalogEntry("GENERIC_DOCUMENT").archetype).toBe("generic");
    const groups = groupDocumentTypesByArchetype(REGISTERED_DOCUMENT_TYPE_CODES);
    expect(groups.at(-1)?.archetype).toBe("generic");
    expect(groups.at(-1)?.codes).toEqual(["GENERIC_DOCUMENT"]);
  });
});
