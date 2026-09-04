import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCompleted: vi.fn(),
  finalizeDraft: vi.fn(),
  issueFoundation: vi.fn(),
  resolveSnapshot: vi.fn(),
  renderer: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  findCompletedClinicDocument: mocks.findCompleted,
}));

vi.mock("@/lib/documents/catalog", () => ({
  getDocumentCatalogEntry: vi.fn(() => ({ code: "INVOICE" })),
}));

vi.mock("@/lib/documents/renderers/registry", () => ({
  getDocumentPdfRenderer: vi.fn(() => mocks.renderer),
}));

vi.mock("@/lib/documents/resolvers/invoice", () => ({
  resolveInvoiceDocumentSnapshot: mocks.resolveSnapshot,
}));

vi.mock("@/lib/documents/issuance", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/documents/issuance")>();
  return {
    ...original,
    finalizeDocumentDraft: mocks.finalizeDraft,
    issueDocumentFoundation: mocks.issueFoundation,
  };
});

import { issueInvoiceDocument } from "@/lib/documents/invoice-issuance";
import { describeDocumentIssueFailure } from "@/lib/documents/issuance";

const input = {
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  actorId: "11111111-1111-4111-8111-111111111111",
  appointmentId: "22222222-2222-4222-8222-222222222222",
  locale: "ar" as const,
  draftId: "33333333-3333-4333-8333-333333333333",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCompleted.mockResolvedValue({ data: null, error: null });
  mocks.resolveSnapshot.mockResolvedValue({
    generatedAt: "2026-08-09T12:00:00.000Z",
    settings: {
      numberingPrefix: "INV",
      numberingYearlyReset: true,
      sequencePadding: 4,
      watermark: null,
    },
  });
  mocks.issueFoundation.mockResolvedValue({
    documentId: "44444444-4444-4444-8444-444444444444",
    documentNumber: "INV-2026-0001",
    verificationToken: "token",
    reused: false,
  });
});

describe("P7-7 Invoice issuance regression", () => {
  it("reuses the completed canonical invoice across actor/locale draft retries", async () => {
    mocks.findCompleted.mockResolvedValue({
      data: {
        id: "55555555-5555-4555-8555-555555555555",
        document_number: "INV-2026-0042",
        verification_token: "existing-token",
        status: "issued",
      },
      error: null,
    });

    await expect(issueInvoiceDocument(input)).resolves.toEqual({
      documentId: "55555555-5555-4555-8555-555555555555",
      documentNumber: "INV-2026-0042",
      verificationToken: "existing-token",
      reused: true,
    });
    expect(mocks.finalizeDraft).toHaveBeenCalledWith(expect.objectContaining({
      draftId: input.draftId,
      documentId: "55555555-5555-4555-8555-555555555555",
    }));
    expect(mocks.resolveSnapshot).not.toHaveBeenCalled();
    expect(mocks.issueFoundation).not.toHaveBeenCalled();
  });

  it("labels plain invoice snapshot/Postgres failures with their real fields", async () => {
    mocks.resolveSnapshot.mockRejectedValue({
      message: "column patients.avatar_path does not exist",
      code: "42703",
      details: "The invoice snapshot query failed",
      hint: "Apply the matching migration",
    });

    let thrown: unknown;
    try {
      await issueInvoiceDocument(input);
    } catch (error) {
      thrown = error;
    }

    expect(describeDocumentIssueFailure(thrown)).toEqual({
      stage: "invoice-data-resolution",
      message: "column patients.avatar_path does not exist",
      code: "42703",
      details: "The invoice snapshot query failed",
      hint: "Apply the matching migration",
    });
  });

  it("keeps the canonical natural idempotency key and passes the source draft", async () => {
    await issueInvoiceDocument(input);

    expect(mocks.issueFoundation).toHaveBeenCalledWith(expect.objectContaining({
      documentType: "INVOICE",
      idempotencyKey: `invoice:${input.appointmentId}`,
      draftId: input.draftId,
      appointmentId: input.appointmentId,
      render: mocks.renderer,
    }));
  });
});
