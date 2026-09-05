import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  P712_PATIENT_HISTORY_DOCUMENT_CODES,
  patientHistoryDocumentParamsSchema,
  patientHistoryDocumentSnapshotSchema,
} from "@/lib/documents/resolvers/patient-history";
import { getPatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import { DOCUMENT_CATALOG, getDocumentCatalogEntry } from "@/lib/documents/catalog";

const PATIENT = "22222222-2222-4222-8222-222222222222";

describe("P7-12 patient history & financial document contract", () => {
  it("registers the four types under the history archetype with patient subject", () => {
    const expected = {
      APPOINTMENT_HISTORY_REPORT: "APH",
      PACKAGE_HISTORY_REPORT: "PKH",
      DEPOSIT_STATEMENT: "DEP",
      PATIENT_FINANCIAL_SUMMARY: "PFS",
    } as const;
    for (const code of P712_PATIENT_HISTORY_DOCUMENT_CODES) {
      const entry = getDocumentCatalogEntry(code);
      expect(entry.archetype).toBe("history");
      expect(entry.subject).toBe("patient");
      expect(entry.template).toBe("PatientHistoryDocument");
      expect(entry.numbering.prefix).toBe(expected[code]);
      // Patient-only scope: never external subjects (doc 14 #6).
      expect(entry.allowsExternalSubject ?? false).toBe(false);
    }
  });

  it("preserves the doctor financial restriction on the two financial statements", () => {
    // History reports include scoped clinical roles; financial statements do not.
    for (const code of ["APPOINTMENT_HISTORY_REPORT", "PACKAGE_HISTORY_REPORT"] as const) {
      expect(DOCUMENT_CATALOG[code].pageRoles).toContain("doctor");
      expect(DOCUMENT_CATALOG[code].pageRoles).toContain("assistant");
    }
    for (const code of ["DEPOSIT_STATEMENT", "PATIENT_FINANCIAL_SUMMARY"] as const) {
      expect(DOCUMENT_CATALOG[code].pageRoles).not.toContain("doctor");
      expect(DOCUMENT_CATALOG[code].pageRoles).not.toContain("assistant");
    }
  });

  it("accepts a patient id + date range and rejects a non-uuid patient", () => {
    expect(
      patientHistoryDocumentParamsSchema.safeParse({
        documentType: "APPOINTMENT_HISTORY_REPORT",
        patientId: PATIENT,
        preset: "last_month",
      }).success,
    ).toBe(true);
    expect(
      patientHistoryDocumentParamsSchema.safeParse({
        documentType: "DEPOSIT_STATEMENT",
        patientId: "nope",
      }).success,
    ).toBe(false);
    expect(
      patientHistoryDocumentParamsSchema.safeParse({
        documentType: "NOT_A_TYPE",
        patientId: PATIENT,
      }).success,
    ).toBe(false);
  });

  it("freezes the issued snapshot at version one", () => {
    expect(patientHistoryDocumentSnapshotSchema.shape.version.value).toBe(1);
    expect(patientHistoryDocumentSnapshotSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it("resolves from the shared P7-11 patient-file data layer (no duplicated logic)", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/documents/resolvers/patient-history.ts"),
      "utf8",
    );
    // Reuses the single shared owner rather than re-implementing billing/deposit/
    // history queries.
    expect(source).toContain('from "@/lib/patients/file-data"');
    expect(source).toContain("loadAppointmentHistory");
    expect(source).toContain("loadPatientDeposits");
    expect(source).toContain("computeBillingTotals");
    expect(source).toContain("resolveHistoryRange");
    // Scoped clinical roles get no financial columns (reuses P7-11 flag).
    expect(source).toContain("isScopedClinical: scoped");
    // No new numbering / identity forging in the resolver.
    expect(source).not.toContain("allocate_document_number");
  });

  it("issues + reprints through the shared engine pipeline", () => {
    const actions = readFileSync(join(process.cwd(), "actions/documents.ts"), "utf8");
    const core = readFileSync(join(process.cwd(), "lib/documents/mutations.ts"), "utf8");
    expect(actions).toContain("issuePatientHistoryDocumentCore(user, {");
    expect(core).toContain("issueDocumentFoundation({");
    expect(core).toContain("render: getDocumentPdfRenderer(code)");
    expect(actions).toContain("record_patient_history_document_reprint");
    const renderer = readFileSync(
      join(process.cwd(), "lib/documents/renderers/patient-history.tsx"),
      "utf8",
    );
    expect(renderer).toContain("renderDocumentPdf");
    expect(renderer).toContain("generateDocumentVerificationQrDataUrl");
  });

  it("routes all four types from the issued-document module to the shared family reprint action", () => {
    const moduleActions = readFileSync(
      join(process.cwd(), "actions/documents-module.ts"),
      "utf8",
    );
    expect(moduleActions).toContain("P712_PATIENT_HISTORY_DOCUMENT_CODES.includes");
    expect(moduleActions).toContain("reprintPatientHistoryDocument(");
    expect(moduleActions).toContain("docType as P712PatientHistoryDocumentCode");
  });

  it("maps every family type to the patient-history renderer", () => {
    const registry = readFileSync(
      join(process.cwd(), "lib/documents/renderers/registry.ts"),
      "utf8",
    );
    for (const code of P712_PATIENT_HISTORY_DOCUMENT_CODES) {
      expect(registry).toContain(`${code}: renderIssuedPatientHistoryPdf`);
    }
  });

  it("provides bilingual copy for every type", () => {
    for (const code of P712_PATIENT_HISTORY_DOCUMENT_CODES) {
      const en = getPatientHistoryCopy("en", code);
      const ar = getPatientHistoryCopy("ar", code);
      expect(en.title.length).toBeGreaterThan(0);
      expect(ar.title.length).toBeGreaterThan(0);
      expect(ar.title).not.toBe(en.title);
    }
  });
});
