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

export type DocumentIssueStage =
  | "invoice-data-resolution"
  | "reservation"
  | "renderer-dispatch"
  | "server-html-render"
  | "chromium-pdf"
  | "render"
  | "pdf-storage"
  | "issuance-rpc"
  | "draft-finalization"
  | "invoice-action";

export type DocumentIssueFailure = {
  stage: DocumentIssueStage;
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
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

function field(value: unknown, key: "message" | "code" | "details" | "hint"): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate == null || String(candidate).trim() === "" ? null : String(candidate);
}

function causeOf(value: unknown): unknown {
  if (value instanceof DocumentIssueError) return value.causeValue;
  if (value instanceof Error && value.cause != null) return value.cause;
  return value;
}

function issueStageOf(value: unknown): DocumentIssueStage | null {
  if (!value || typeof value !== "object" || !("stage" in value)) return null;
  const stage = String((value as { stage: unknown }).stage);
  return [
    "invoice-data-resolution",
    "reservation",
    "renderer-dispatch",
    "server-html-render",
    "chromium-pdf",
    "render",
    "pdf-storage",
    "issuance-rpc",
    "draft-finalization",
    "invoice-action",
  ].includes(stage) ? stage as DocumentIssueStage : null;
}

/** Preserve the structured Supabase/Postgres fields that plain-object throws carry. */
export function describeDocumentIssueFailure(
  value: unknown,
  fallbackStage: DocumentIssueStage = "invoice-action",
): DocumentIssueFailure {
  const cause = causeOf(value);
  const stage = value instanceof DocumentIssueError
    ? value.stage
    : issueStageOf(value) ?? fallbackStage;
  const message = field(cause, "message")
    ?? (cause instanceof Error ? cause.message : null)
    ?? field(value, "message")
    ?? (value instanceof Error ? value.message : null)
    ?? (value == null ? "No error value was provided" : String(value));
  return {
    stage,
    message,
    code: field(cause, "code") ?? field(value, "code"),
    details: field(cause, "details") ?? field(value, "details"),
    hint: field(cause, "hint") ?? field(value, "hint"),
  };
}

export class DocumentIssueError extends Error {
  constructor(
    public readonly stage: DocumentIssueStage,
    public readonly causeValue: unknown,
  ) {
    const failure = describeDocumentIssueFailure(causeValue, stage);
    super(`Document issuance failed during ${stage}: ${failure.message}`, {
      cause: causeValue,
    });
    this.name = "DocumentIssueError";
  }
}

function failureCode(stage: DocumentIssueStage): string {
  return `DOCUMENT_${stage.replaceAll("-", "_").toUpperCase()}_FAILED`;
}

async function recordIssueFailure(
  deps: DocumentIssueDependencies,
  reservation: DocumentIssueReservation,
  stage: DocumentIssueStage,
): Promise<boolean> {
  try {
    return await deps.fail(reservation, failureCode(stage));
  } catch (error) {
    console.error("document_issue_failure_record_failed", {
      documentId: reservation.documentId,
      ...describeDocumentIssueFailure(error, "issuance-rpc"),
    });
    return false;
  }
}

async function cleanupIssueArtifact(
  deps: DocumentIssueDependencies,
  reservation: DocumentIssueReservation,
  storagePath: string | null,
): Promise<void> {
  try {
    await deps.cleanup?.(reservation, storagePath);
  } catch (error) {
    console.error("document_issue_cleanup_failed", {
      documentId: reservation.documentId,
      ...describeDocumentIssueFailure(error, "pdf-storage"),
    });
  }
}

/**
 * P7-0 issuance guard. The database reservation owns idempotency + numbering;
 * this coordinator guarantees a document is finalized only after the canonical
 * PDF is stored. A retry receives the same reservation and number.
 */
export async function issueDocumentWithGuard(
  deps: DocumentIssueDependencies,
): Promise<DocumentIssueResult> {
  let reservation: DocumentIssueReservation;
  try {
    reservation = await deps.reserve();
  } catch (error) {
    throw error instanceof DocumentIssueError
      ? error
      : new DocumentIssueError("reservation", error);
  }
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
    const failure = error instanceof DocumentIssueError
      ? error
      : new DocumentIssueError("render", error);
    await recordIssueFailure(deps, reservation, failure.stage);
    throw failure;
  }

  try {
    storagePath = await deps.store(reservation, artifact);
  } catch (error) {
    await cleanupIssueArtifact(deps, reservation, storagePath);
    await recordIssueFailure(deps, reservation, "pdf-storage");
    throw new DocumentIssueError("pdf-storage", error);
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
    const markedFailed = await recordIssueFailure(deps, reservation, "issuance-rpc");
    if (markedFailed) await cleanupIssueArtifact(deps, reservation, storagePath);
    throw new DocumentIssueError("issuance-rpc", error);
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

export async function finalizeDocumentDraft(input: {
  draftId?: string | null;
  clinicId: string;
  actorId: string;
  documentId: string;
}): Promise<void> {
  if (!input.draftId) return;
  try {
    const resolved = await resolveClinicDocumentDraft({
      draftId: input.draftId,
      clinicId: input.clinicId,
      actorId: input.actorId,
      documentId: input.documentId,
    });
    if (!resolved.error) return;
    console.error("document_draft_resolution_failed", {
      clinicId: input.clinicId,
      draftId: input.draftId,
      documentId: input.documentId,
      ...describeDocumentIssueFailure(resolved.error, "draft-finalization"),
    });
  } catch (error) {
    console.error("document_draft_resolution_failed", {
      clinicId: input.clinicId,
      draftId: input.draftId,
      documentId: input.documentId,
      ...describeDocumentIssueFailure(error, "draft-finalization"),
    });
  }
}

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

  // Issuance is already committed and must never be reported as failed or
  // rolled back because draft housekeeping failed.
  await finalizeDocumentDraft({ ...input, documentId: result.documentId });

  return result;
}
