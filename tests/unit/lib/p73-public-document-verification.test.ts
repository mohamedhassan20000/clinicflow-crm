import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));

import { lookupPublicDocumentVerification } from "@/lib/documents/verification";

describe("P7-3 public document verification boundary", () => {
  beforeEach(() => rpc.mockReset());

  it("rejects malformed and uppercase tokens without querying", async () => {
    await expect(lookupPublicDocumentVerification("../documents"))
      .resolves.toMatchObject({ status: "unavailable", documentNumber: null });
    await expect(lookupPublicDocumentVerification("ABCDEF0123456789ABCDEF0123456789"))
      .resolves.toMatchObject({ status: "unavailable", documentNumber: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns only the approved five public fields", async () => {
    rpc.mockResolvedValue({
      data: [{
        verification_status: "valid",
        document_number: "REV-2026-0001",
        document_type: "REVENUE_REPORT",
        issue_date: "2026-08-01T10:30:00.000Z",
        clinic_name: "ClinicFlow Demo",
        snapshot: { confidential: true },
      }],
      error: null,
    });

    const result = await lookupPublicDocumentVerification("0123456789abcdef0123456789abcdef");
    expect(rpc).toHaveBeenCalledWith("verify_document_token", {
      p_token: "0123456789abcdef0123456789abcdef",
    });
    expect(result).toEqual({
      status: "valid",
      documentNumber: "REV-2026-0001",
      documentType: "REVENUE_REPORT",
      issueDate: "2026-08-01T10:30:00.000Z",
      clinicName: "ClinicFlow Demo",
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("collapses misses, RPC errors, and unknown statuses to unavailable", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(lookupPublicDocumentVerification("0123456789abcdef0123456789abcdef"))
      .resolves.toMatchObject({ status: "unavailable" });

    rpc.mockResolvedValueOnce({ data: [{ verification_status: "rendering" }], error: null });
    await expect(lookupPublicDocumentVerification("fedcba9876543210fedcba9876543210"))
      .resolves.toMatchObject({ status: "unavailable" });
  });

  it("reports a cancelled token as cancelled and never as valid", async () => {
    rpc.mockResolvedValue({
      data: [{
        verification_status: "cancelled",
        document_number: "RX-2026-0001",
        document_type: "PRESCRIPTION",
        issue_date: "2026-08-08T12:00:00.000Z",
        clinic_name: "ClinicFlow Demo",
      }],
      error: null,
    });

    const result = await lookupPublicDocumentVerification(
      "0123456789abcdef0123456789abcdef",
    );

    expect(result.status).toBe("cancelled");
    expect(result.status).not.toBe("valid");
  });
});
