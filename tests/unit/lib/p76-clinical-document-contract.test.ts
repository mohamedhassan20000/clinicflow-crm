import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  P76_CLINICAL_DOCUMENT_CODES,
  clinicalDocumentParamsSchema,
  clinicalDocumentSnapshotSchema,
  mapClinicalCreatorProfile,
} from "@/lib/documents/resolvers/clinical-document";
import { DOCUMENT_PDF_RENDERERS } from "@/lib/documents/renderers/registry";

const id = "11111111-1111-4111-8111-111111111111";

function snapshotData(documentType: (typeof P76_CLINICAL_DOCUMENT_CODES)[number]) {
  const common = {
    id,
    appointmentId: null,
    createdAt: "2026-08-02T08:00:00.000Z",
    finalizedAt: null,
    createdBy: mapClinicalCreatorProfile({ id, full_name: "Dr. Sarah Ahmed" }),
  };
  if (documentType === "PRESCRIPTION") {
    return { ...common, kind: "prescription" as const, validUntil: null, notes: null, medications: [] };
  }
  if (documentType === "LAB_REQUEST") {
    return { ...common, kind: "lab-request" as const, priority: "routine" as const,
      laboratoryName: null, clinicalContext: null, instructions: null, tests: [] };
  }
  return { ...common, kind: "sick-leave" as const, leaveStartDate: "2026-08-02",
    leaveEndDate: "2026-08-03", recipientOrganization: null, recipientReference: null,
    restrictions: null, returnDate: null };
}

describe("P7-6 clinical document contract", () => {
  it("requires a persisted clinical record id and freezes version one snapshots", () => {
    expect(clinicalDocumentParamsSchema.safeParse({ documentType: "PRESCRIPTION",
      recordId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(clinicalDocumentParamsSchema.safeParse({ documentType: "PRESCRIPTION", medications: [] }).success).toBe(false);
    expect(clinicalDocumentSnapshotSchema.shape.version.value).toBe(1);
  });

  it("derives idempotency from the persisted record, snapshots credential assets, and blocks controlled medicine", () => {
    const action = readFileSync(join(process.cwd(), "actions/clinical-documents.ts"), "utf8");
    const resolver = readFileSync(join(process.cwd(), "lib/documents/resolvers/clinical-document.ts"), "utf8");
    expect(action).toContain("clinical:${parsed.data.documentType.toLowerCase()}:${parsed.data.recordId}:${parsed.data.locale}");
    expect(action).toContain("item.isControlled");
    expect(action).toContain('controlledMedicineBlocked');
    expect(resolver).toContain('options.allowDraft ? ["draft", "finalized"] : ["finalized"]');
    expect(action).toContain("ensureClinicalRecordFinalizedForIssue");
    expect(action).toContain("allowDraft: true");
    expect(action).toContain("render: getDocumentPdfRenderer(parsed.data.documentType)");
    expect(resolver).toContain("inlineClinicianSignature");
    expect(resolver).not.toContain("medical_notes");
  });

  it("uses the same shared issued-PDF renderer for all three clinical types", () => {
    for (const documentType of P76_CLINICAL_DOCUMENT_CODES) {
      expect(DOCUMENT_PDF_RENDERERS[documentType])
        .toBe(DOCUMENT_PDF_RENDERERS.PRESCRIPTION);
    }
  });

  it.each(P76_CLINICAL_DOCUMENT_CODES)("maps the persisted creator profile for %s draft preview", (documentType) => {
    const result = clinicalDocumentSnapshotSchema.safeParse({
      version: 1,
      documentType,
      generatedAt: "2026-08-02T10:30:00.000Z",
      sourceRecordId: id,
      subject: { patientId: id, fullName: "Omar Hassan", dateOfBirth: null,
        nationalId: null, fileNumber: null, phone: null, bloodType: null },
      physician: { id, fullName: "Dr. Sarah Ahmed", professionalLicenseNo: null,
        specialty: null, professionalTitle: null, departmentName: null, signatureSrc: null },
      branding: { name: "Clinic", logoSrc: null, address: null, phone: null,
        email: null, website: null, licenseNo: null, taxId: null, footerText: null },
      format: { timeZone: "Europe/Istanbul", timeFormat: "24h" },
      settings: { watermark: null, qrEnabled: true, numberingPrefix: "DOC",
        numberingYearlyReset: true, sequencePadding: 4 },
      data: snapshotData(documentType),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data.createdBy.fullName).toBe("Dr. Sarah Ahmed");
  });

  it("rejects a creator profile without the required persisted display name", () => {
    expect(() => mapClinicalCreatorProfile({ id, full_name: null }))
      .toThrow("Clinical document preparer is missing a display name");
  });
});
