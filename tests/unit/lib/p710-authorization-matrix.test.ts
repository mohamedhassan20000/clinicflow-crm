import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CATALOG,
  DOCUMENT_TYPE_CODES,
  SAFE_VERIFICATION_DISCLOSURE,
  getDocumentCatalogEntry,
  type DocumentTypeCode,
} from "@/lib/documents/catalog";
import type { PermissionUserRole } from "@/lib/page-permissions";

/**
 * P7-10 — final hardening. A single frozen contract over the whole catalog so that
 * no future document type can silently widen who may issue it, expose more than the
 * safe verification set, prepare a document for an unregistered person, or hand a
 * financial statement to a doctor. Each assertion maps to an approved rule
 * (SHARED_REQUIREMENTS §7/§8, doc 16 §4.2/§7/§8, doc 09 §1.2).
 */

const ALL_ROLES: readonly PermissionUserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];

// doc 16 §4.2/§7 — external-subject snapshot identity is a clinical-only capability.
const EXTERNAL_SUBJECT_TYPES: readonly DocumentTypeCode[] = [
  "PRESCRIPTION",
  "SICK_LEAVE_CERTIFICATE",
  "LAB_REQUEST",
];

// doc 16 §8 — the doctor no-financials rule: financial statements never list a
// doctor/assistant in their page roles.
const FINANCIAL_TYPES: readonly DocumentTypeCode[] = [
  "INVOICE",
  "DEPOSIT_STATEMENT",
  "PATIENT_FINANCIAL_SUMMARY",
];

// Performance/roster analytics restricted to administrative oversight roles.
const PERFORMANCE_ONLY_TYPES: readonly DocumentTypeCode[] = [
  "DOCTOR_PERFORMANCE_REPORT",
  "RECEPTIONIST_PERFORMANCE_REPORT",
  "SYSTEM_MEMBERS_REPORT",
  "STAFF_FILE",
];

describe("P7-10 document authorization & policy matrix", () => {
  it("registers exactly the 20 approved types with catalog entries in sync", () => {
    expect(Object.keys(DOCUMENT_CATALOG).sort()).toEqual([...DOCUMENT_TYPE_CODES].sort());
    for (const code of DOCUMENT_TYPE_CODES) {
      expect(getDocumentCatalogEntry(code).code).toBe(code);
    }
  });

  it("gives every type a non-empty, valid, admin-inclusive page-role set", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const { pageRoles } = getDocumentCatalogEntry(code);
      expect(pageRoles.length).toBeGreaterThan(0);
      // No unknown role slips into an authorization list.
      for (const role of pageRoles) expect(ALL_ROLES).toContain(role);
      // No duplicate roles.
      expect(new Set(pageRoles).size).toBe(pageRoles.length);
      // Admin can always issue every document type.
      expect(pageRoles).toContain("admin");
    }
  });

  it("exposes only the safe five-field disclosure set on every type", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      // Same frozen reference — no type may substitute a wider disclosure list.
      expect(getDocumentCatalogEntry(code).verificationDisclosure).toBe(
        SAFE_VERIFICATION_DISCLOSURE,
      );
      expect([...getDocumentCatalogEntry(code).verificationDisclosure]).toEqual([
        "status",
        "documentNumber",
        "documentType",
        "issueDate",
        "clinicName",
      ]);
    }
  });

  it("permits external-subject preparation only for the three clinical types", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const allowed = getDocumentCatalogEntry(code).allowsExternalSubject === true;
      expect(allowed).toBe(EXTERNAL_SUBJECT_TYPES.includes(code));
    }
  });

  it("keeps doctors and assistants out of every financial statement (no-financials rule)", () => {
    for (const code of FINANCIAL_TYPES) {
      const { pageRoles } = getDocumentCatalogEntry(code);
      expect(pageRoles).not.toContain("doctor");
      expect(pageRoles).not.toContain("assistant");
    }
  });

  it("restricts performance/roster analytics to administrative oversight roles", () => {
    for (const code of PERFORMANCE_ONLY_TYPES) {
      const { pageRoles } = getDocumentCatalogEntry(code);
      expect(pageRoles).not.toContain("receptionist");
      expect(pageRoles).not.toContain("doctor");
      expect(pageRoles).not.toContain("assistant");
    }
  });

  it("uses immutable, unique, well-formed numbering identity per type", () => {
    const prefixes = new Set<string>();
    for (const code of DOCUMENT_TYPE_CODES) {
      const { numbering } = getDocumentCatalogEntry(code);
      // Latin-uppercase prefix, no separators that would clash with the sequence.
      expect(numbering.prefix).toMatch(/^[A-Z][A-Z0-9]{0,15}$/);
      expect(numbering.sequencePadding).toBeGreaterThanOrEqual(1);
      expect(numbering.sequencePadding).toBeLessThanOrEqual(8);
      expect(typeof numbering.yearlyReset).toBe("boolean");
      // Every type carries a distinct prefix so issued numbers stay disambiguable.
      expect(prefixes.has(numbering.prefix)).toBe(false);
      prefixes.add(numbering.prefix);
    }
    expect(prefixes.size).toBe(DOCUMENT_TYPE_CODES.length);
  });

  it("wires every type to a resolver, template, and issuance trigger", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const entry = getDocumentCatalogEntry(code);
      expect(entry.template.length).toBeGreaterThan(0);
      expect(entry.issuanceTrigger.href.startsWith("/")).toBe(true);
      if (entry.resolver.kind === "report") {
        expect(entry.resolver.reportId.length).toBeGreaterThan(0);
      } else {
        expect(entry.resolver.resolverId.length).toBeGreaterThan(0);
      }
    }
  });

  it("only lets the two attachment-merge profile types opt into attachments", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const supports = getDocumentCatalogEntry(code).supportsAttachments === true;
      expect(supports).toBe(code === "PATIENT_FILE" || code === "STAFF_FILE");
    }
  });
});
