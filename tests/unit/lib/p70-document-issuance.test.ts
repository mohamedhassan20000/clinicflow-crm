import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  describeDocumentIssueFailure,
  issueDocumentWithGuard,
  type DocumentIssueReservation,
} from "@/lib/documents/issuance";

function reservation(
  overrides: Partial<DocumentIssueReservation> = {},
): DocumentIssueReservation {
  return {
    documentId: randomUUID(),
    documentNumber: "REV-2026-0001",
    verificationToken: "0123456789abcdef0123456789abcdef",
    status: "rendering",
    reused: false,
    documentType: "REVENUE_REPORT",
    locale: "en",
    params: {},
    snapshot: { total: 100 },
    watermark: null,
    ...overrides,
  };
}

describe("P7-0 idempotent issuance guard", () => {
  it("returns an already-issued reservation without rendering or storing", async () => {
    const existing = reservation({ status: "issued", reused: true });
    const render = vi.fn();
    const store = vi.fn();
    const result = await issueDocumentWithGuard({
      reserve: async () => existing,
      render,
      store,
      complete: vi.fn(),
      fail: vi.fn(),
    });

    expect(result).toMatchObject({
      documentId: existing.documentId,
      documentNumber: existing.documentNumber,
      reused: true,
    });
    expect(render).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("marks a render failure and leaves no issued artifact", async () => {
    const pending = reservation();
    const fail = vi.fn(async () => true);
    const store = vi.fn();

    await expect(issueDocumentWithGuard({
      reserve: async () => pending,
      render: async () => { throw new Error("chromium failed"); },
      store,
      complete: vi.fn(),
      fail,
    })).rejects.toMatchObject({ stage: "render" });

    expect(fail).toHaveBeenCalledWith(pending, "DOCUMENT_RENDER_FAILED");
    expect(store).not.toHaveBeenCalled();
  });

  it("retries the same failed reservation and completes the same number", async () => {
    const failed = reservation({ status: "failed", reused: true });
    const complete = vi.fn(async () => ({ ...failed, status: "issued" as const }));

    const result = await issueDocumentWithGuard({
      reserve: async () => failed,
      render: async (value) => {
        expect(value.documentNumber).toBe("REV-2026-0001");
        return { pdf: new Uint8Array([1, 2, 3]), pageCount: 1 };
      },
      store: async () => `documents/clinic/REVENUE_REPORT/${failed.documentId}.pdf`,
      complete,
      fail: vi.fn(),
    });

    expect(result.documentId).toBe(failed.documentId);
    expect(result.documentNumber).toBe("REV-2026-0001");
    expect(result.reused).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not delete an artifact after an ambiguous committed completion", async () => {
    const pending = reservation();
    const cleanup = vi.fn();
    const fail = vi.fn(async () => false); // false means the row is already issued

    await expect(issueDocumentWithGuard({
      reserve: async () => pending,
      render: async () => ({ pdf: new Uint8Array([1]), pageCount: 1 }),
      store: async () => "documents/expected.pdf",
      complete: async () => { throw new Error("response lost after commit"); },
      fail,
      cleanup,
    })).rejects.toMatchObject({ stage: "issuance-rpc" });

    expect(fail).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("preserves plain Supabase reservation fields instead of reporting unknown", async () => {
    const postgresError = {
      message: "DOCUMENT_IDEMPOTENCY_CONFLICT",
      code: "23505",
      details: "Existing invoice differs by actor or locale",
      hint: "Reuse the completed canonical invoice",
    };

    let thrown: unknown;
    try {
      await issueDocumentWithGuard({
        reserve: async () => { throw postgresError; },
        render: vi.fn(),
        store: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(describeDocumentIssueFailure(thrown)).toEqual({
      stage: "reservation",
      message: "DOCUMENT_IDEMPOTENCY_CONFLICT",
      code: "23505",
      details: "Existing invoice differs by actor or locale",
      hint: "Reuse the completed canonical invoice",
    });
  });

  it("does not let a failed recovery RPC hide the original render failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(issueDocumentWithGuard({
        reserve: async () => reservation(),
        render: async () => { throw new Error("Chromium executable is unavailable"); },
        store: vi.fn(),
        complete: vi.fn(),
        fail: async () => { throw { message: "fail_document_issue unavailable", code: "PGRST202" }; },
      })).rejects.toMatchObject({
        stage: "render",
        message: expect.stringContaining("Chromium executable is unavailable"),
      });
      expect(consoleError).toHaveBeenCalledWith(
        "document_issue_failure_record_failed",
        expect.objectContaining({ stage: "issuance-rpc", code: "PGRST202" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
