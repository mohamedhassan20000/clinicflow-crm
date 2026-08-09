import "server-only";
import {
  completeDocumentIssue,
  failDocumentIssue,
  removeClinicDocumentPdf,
  resolveClinicDocumentDraft,
  reserveDocumentIssue,
  uploadClinicDocumentPdf,
  type ReserveDocumentIssueInput,
} from "@/lib/supabase/admin";
import type { Json } from "@/types/database";
import type { DocumentLifecycle } from "@/components/documents/engine";

export type DocumentIssueReservation = {
  documentId: string;
  documentNumber: string;
  verificationToken: string;
  status: "rendering" | "failed" | "issued";
  reused: boolean;
  documentType: string;
  locale: "ar" | "en";
  params: Json;
  snapshot: Json;
  watermark: string | null;
  presentationLifecycle?: Exclude<DocumentLifecycle, "preview">;
};

export type RenderedDocumentArtifact = {
  pdf: Uint8Array;
  pageCount: number;
};

export type DocumentIssueRenderer = (
  reservation: DocumentIssueReservation,
) => Promise<RenderedDocumentArtifact>;

export type DocumentIssueResult = {
  documentId: string;
  documentNumber: string;
  verificationToken: string;
  reused: boolean;
};

export type DocumentIssueDependencies = {
  reserve: () => Promise<DocumentIssueReservation>;
  render: DocumentIssueRenderer;
  store: (
    reservation: DocumentIssueReservation,
    artifact: RenderedDocumentArtifact,
  ) => Promise<string>;
  complete: (input: {
    reservation: DocumentIssueReservation;
    storagePath: string;
    pageCount: number;
  }) => Promise<DocumentIssueReservation>;
  fail: (
    reservation: DocumentIssueReservation,
    failureCode: string,
  ) => Promise<boolean>;
  cleanup?: (
    reservation: DocumentIssueReservation,
    storagePath: string | null,
  ) => Promise<void>;
};

/** Renders any thrown value (Error / PostgrestError / unknown) to a log line. */
function describeCause(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    // Supabase PostgrestError shape — keep the real message/code/details.
    const parts = ["message", "code", "details", "hint"]
      .map((key) => (row[key] == null ? null : `${key}=${String(row[key])}`))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return value == null ? "unknown" : String(value);
}

export class DocumentIssueError extends Error {
  constructor(
    public readonly stage: "render" | "store" | "complete",
    public readonly causeValue: unknown,
  ) {
    // Carry the underlying failure into `.message` so the generic action-level
    // logs (which print error.message) always record the real cause server-side.
    super(`Document issuance failed during ${stage}: ${describeCause(causeValue)}`, {
      cause: causeValue,
    });
    this.name = "DocumentIssueError";
  }
}

function failureCode(stage: DocumentIssueError["stage"]): string {
  return `DOCUMENT_${stage.toUpperCase()}_FAILED`;
}

/**
 * P7-0 issuance guard. The database reservation owns idempotency + numbering;
 * this coordinator guarantees a document is finalized only after the canonical
 * PDF is stored. A retry receives the same reservation and number.
 */
export async function issueDocumentWithGuard(
  deps: DocumentIssueDependencies,
): Promise<DocumentIssueResult> {
  const reservation = await deps.reserve();
  if (reservation.status === "issued") {
    return {
      documentId: reservation.documentId,
      documentNumber: reservation.documentNumber,
      verificationToken: reservation.verificationToken,
      reused: true,
    };
  }

  let storagePath: string | null = null;
  let artifact: RenderedDocumentArtifact;
  try {
    artifact = await deps.render(reservation);
    if (!Number.isInteger(artifact.pageCount) || artifact.pageCount < 1) {
      throw new Error("Rendered document page count must be positive");
    }
  } catch (error) {
    await deps.fail(reservation, failureCode("render"));
    throw new DocumentIssueError("render", error);
  }

  try {
    storagePath = await deps.store(reservation, artifact);
  } catch (error) {
    await deps.cleanup?.(reservation, storagePath);
    await deps.fail(reservation, failureCode("store"));
    throw new DocumentIssueError("store", error);
  }

  try {
    const completed = await deps.complete({
      reservation,
      storagePath,
      pageCount: artifact.pageCount,
    });
    return {
      documentId: completed.documentId,
      documentNumber: completed.documentNumber,
      verificationToken: completed.verificationToken,
      reused: reservation.reused,
    };
  } catch (error) {
    // Completion may have committed even if its response was lost. Mark the
    // reservation failed first; the RPC returns false for an already-issued
    // row, in which case deleting the canonical artifact would corrupt it.
    const markedFailed = await deps.fail(
      reservation,
      failureCode("complete"),
    );
    if (markedFailed) await deps.cleanup?.(reservation, storagePath);
    throw new DocumentIssueError("complete", error);
  }
}

function reservationFromRow(
  row: Awaited<ReturnType<typeof reserveDocumentIssue>>["data"] extends
    | (infer R)[]
    | null
    ? R
    : never,
): DocumentIssueReservation {
  if (!row) throw new Error("Document reservation is empty");
  if (
    row.issue_status !== "rendering"
    && row.issue_status !== "failed"
    && row.issue_status !== "issued"
  ) {
    throw new Error("Document reservation returned an invalid status");
  }
  if (row.render_locale !== "ar" && row.render_locale !== "en") {
    throw new Error("Document reservation returned an invalid locale");
  }
  return {
    documentId: row.document_id,
    documentNumber: row.document_number,
    verificationToken: row.verification_token,
    status: row.issue_status,
    reused: row.reused,
    documentType: row.document_type,
    locale: row.render_locale,
    params: row.params_snapshot,
    snapshot: row.data_snapshot,
    watermark: row.effective_watermark,
  };
}

export type IssueDocumentFoundationInput = ReserveDocumentIssueInput & {
  draftId?: string | null;
  render: DocumentIssueRenderer;
};

/**
 * Concrete server-only P7-0 path. P7-3 supplies the approved template renderer;
 * the idempotency, storage, retry, and finalization behavior stays here.
 */
export async function issueDocumentFoundation(
  input: IssueDocumentFoundationInput,
): Promise<DocumentIssueResult> {
  const result = await issueDocumentWithGuard({
    reserve: async () => {
      const result = await reserveDocumentIssue(input);
      if (result.error) throw result.error;
      return reservationFromRow(result.data?.[0]);
    },
    render: input.render,
    store: async (reservation, artifact) => {
      const result = await uploadClinicDocumentPdf({
        clinicId: input.clinicId,
        documentType: reservation.documentType,
        documentId: reservation.documentId,
        pdf: artifact.pdf,
      });
      if (result.error) throw result.error;
      return result.storagePath;
    },
    complete: async ({ reservation, storagePath, pageCount }) => {
      const result = await completeDocumentIssue({
        clinicId: input.clinicId,
        actorId: input.actorId,
        documentId: reservation.documentId,
        storagePath,
        pageCount,
      });
      if (result.error) throw result.error;
      const row = result.data?.[0];
      if (!row) throw new Error("Document completion returned no row");
      return {
        ...reservation,
        documentId: row.document_id,
        documentNumber: row.document_number,
        verificationToken: row.verification_token,
        status: "issued",
        reused: row.reused,
      };
    },
    fail: async (reservation, code) => {
      const result = await failDocumentIssue({
        clinicId: input.clinicId,
        actorId: input.actorId,
        documentId: reservation.documentId,
        failureCode: code,
      });
      if (result.error) throw result.error;
      return result.data === true;
    },
    cleanup: async (reservation) => {
      const result = await removeClinicDocumentPdf({
        clinicId: input.clinicId,
        documentType: reservation.documentType,
        documentId: reservation.documentId,
      });
      if (result.error) throw result.error;
    },
  });

  if (input.draftId) {
    const resolved = await resolveClinicDocumentDraft({
      draftId: input.draftId,
      clinicId: input.clinicId,
      actorId: input.actorId,
      documentId: result.documentId,
    });
    if (resolved.error) {
      // Issuance is already committed and must never be reported as failed or
      // rolled back because draft housekeeping failed. The retry-safe issue
      // path will return the same document and attempt resolution again.
      console.error("document_draft_resolution_failed", {
        clinicId: input.clinicId,
        draftId: input.draftId,
        documentId: result.documentId,
        message: resolved.error.message,
      });
    }
  }

  return result;
}
