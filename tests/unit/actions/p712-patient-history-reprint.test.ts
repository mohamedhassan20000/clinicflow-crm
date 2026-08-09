import { beforeEach, describe, expect, it, vi } from "vitest";
import { P712_PATIENT_HISTORY_DOCUMENT_CODES } from "@/lib/documents/resolvers/patient-history";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireActiveSubscription: vi.fn(),
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

vi.mock("@/lib/billing/subscriptions", () => ({
  requireActiveSubscription: mocks.requireActiveSubscription,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: mocks.rpc,
  })),
}));

import { reprintPatientHistoryDocument } from "@/actions/documents";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSubscription.mockResolvedValue(undefined);
});

describe("P7-12 History & Financial canonical PDF reprint", () => {
  it.each(P712_PATIENT_HISTORY_DOCUMENT_CODES)(
    "records the reprint and returns the status-aware PDF endpoint for %s",
    async (documentType) => {
      const storagePath =
        `documents/33333333-3333-4333-8333-333333333333/${documentType}/${DOCUMENT_ID}.pdf`;
      mocks.rpc.mockResolvedValue({
        data: [{
          pdf_storage_path: storagePath,
          document_number: `${documentType}-0001`,
          print_count: 2,
        }],
        error: null,
      });

      const result = await reprintPatientHistoryDocument(DOCUMENT_ID, documentType);

      expect(mocks.rpc).toHaveBeenCalledWith(
        "record_patient_history_document_reprint",
        { p_document_id: DOCUMENT_ID },
      );
      expect(result).toEqual({
        data: {
          url: `/documents/${DOCUMENT_ID}/pdf`,
          documentNumber: `${documentType}-0001`,
          printCount: 2,
        },
      });
    },
  );

  it("reports stored PDF lookup as the failure stage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({
      data: null,
      error: new Error("DOCUMENT_PDF_UNAVAILABLE"),
    });

    const result = await reprintPatientHistoryDocument(
      DOCUMENT_ID,
      "APPOINTMENT_HISTORY_REPORT",
    );

    expect(result).toEqual({
      errorCode: "reprintFailed",
      failureStage: "storedPdfLookup",
    });
    expect(log).toHaveBeenCalledWith(
      "patient_history_document_reprint_failed",
      expect.objectContaining({ stage: "storedPdfLookup" }),
    );
    log.mockRestore();
  });

});
