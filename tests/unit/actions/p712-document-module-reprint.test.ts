import { beforeEach, describe, expect, it, vi } from "vitest";
import { P712_PATIENT_HISTORY_DOCUMENT_CODES } from "@/lib/documents/resolvers/patient-history";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  documentType: "APPOINTMENT_HISTORY_REPORT",
  reprintPatientHistoryDocument: vi.fn(),
}));

vi.mock("@/actions/documents", () => ({
  reprintAnalyticalReportDocument: vi.fn(),
  reprintInvoiceDocument: vi.fn(),
  reprintPatientHistoryDocument: mocks.reprintPatientHistoryDocument,
  reprintRevenueReportDocument: vi.fn(),
  reprintRosterProfileDocument: vi.fn(),
}));

vi.mock("@/actions/clinical-documents", () => ({
  reprintClinicalDocument: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requireUser: vi.fn(async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    clinicId: "33333333-3333-4333-8333-333333333333",
    email: "admin@clinic.test",
    role: "admin",
    fullName: "Clinic Admin",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  })),
}));

function createTableQuery(table: string) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(async () => ({
      data: table === "patients"
        ? [{ id: "patient-1", full_name: "Test Patient" }]
        : [{ id: "22222222-2222-4222-8222-222222222222", full_name: "Clinic Admin" }],
      error: null,
    })),
    order: vi.fn(async () => ({ data: [], error: null })),
    maybeSingle: vi.fn(async () => ({
      data: {
        id: DOCUMENT_ID,
        doc_type: mocks.documentType,
        document_number: "DOC-0001",
        status: "issued",
        locale: "en",
        patient_id: "patient-1",
        staff_id: null,
        doctor_id: null,
        appointment_id: null,
        issued_at: "2026-08-08T12:00:00.000Z",
        issued_by: "22222222-2222-4222-8222-222222222222",
        print_count: 1,
        verification_token: "verification-token",
        page_count: 2,
      },
      error: null,
    })),
  });
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => createTableQuery(table)),
  })),
}));

import { reprintClinicDocumentFromModule } from "@/actions/documents-module";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reprintPatientHistoryDocument.mockResolvedValue({
    data: {
      url: "https://storage.test/canonical.pdf",
      documentNumber: "DOC-0001",
      printCount: 2,
    },
  });
});

describe("P7-12 issued-document module reprint dispatch", () => {
  it.each(P712_PATIENT_HISTORY_DOCUMENT_CODES)(
    "dispatches %s through the shared History & Financial action",
    async (documentType) => {
      mocks.documentType = documentType;

      const result = await reprintClinicDocumentFromModule(DOCUMENT_ID);

      expect(mocks.reprintPatientHistoryDocument).toHaveBeenCalledWith(
        DOCUMENT_ID,
        documentType,
      );
      expect(result).toEqual({
        data: {
          url: "https://storage.test/canonical.pdf",
          documentNumber: "DOC-0001",
          printCount: 2,
        },
      });
    },
  );

  it("preserves the family action's concrete failure stage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.documentType = "PATIENT_FINANCIAL_SUMMARY";
    mocks.reprintPatientHistoryDocument.mockResolvedValue({
      errorCode: "reprintFailed",
      failureStage: "signedUrlCreation",
    });

    const result = await reprintClinicDocumentFromModule(DOCUMENT_ID);

    expect(result).toEqual({
      errorCode: "reprintFailed",
      failureStage: "signedUrlCreation",
    });
    expect(log).toHaveBeenCalledWith(
      "document_module_reprint_failed",
      expect.objectContaining({ stage: "signedUrlCreation" }),
    );
    log.mockRestore();
  });
});
