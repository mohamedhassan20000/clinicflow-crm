/**
 * P6-12 — the typed "this document's subject is not in your data" signal.
 *
 * A document snapshot resolver has two very different ways to fail:
 *
 *  1. **The subject resolved to nothing.** The row does not exist, or it exists
 *     but RLS (or an application-level access gate such as the doctor's
 *     department/assignment check) returned it empty. This is permanent for
 *     this caller and belongs on §11's `unauthorized_scope` row: never retried,
 *     and — critically — reported identically whether the record is absent or
 *     merely invisible, so the Assistant cannot be used to enumerate ids.
 *  2. **The resolution itself failed.** A timeout, a 5xx, a broken connection,
 *     a malformed supporting row. This is §11's `transient_failure` row: worth
 *     one retry, then the UI path.
 *
 * Before this error existed, every resolver signalled (1) by throwing a bare
 * `Error("... not found")`, which `previewDocumentCore` collapsed into
 * `previewFailed` alongside (2) — so a patient the caller cannot see was
 * reported as a temporary outage. The resolvers now throw this typed error for
 * (1) only, and keep plain `Error` for (2). Matching on message text was
 * deliberately avoided: it is not a contract, and it breaks under translation
 * or a reworded database message.
 *
 * The subject *kind* is derived from the requested document type, never from
 * the lookup result, so it carries no information about whether the record
 * exists. No id is attached, for the same reason.
 */
export type DocumentSubjectKind =
  | "patient"
  | "staff"
  | "appointment"
  | "clinical_record";

export class DocumentSubjectNotFoundError extends Error {
  constructor(public readonly subject: DocumentSubjectKind) {
    super(`Document subject not resolvable: ${subject}`);
    this.name = "DocumentSubjectNotFoundError";
  }
}

/**
 * `instanceof` with a `name` fallback: the resolvers and the caller can be
 * loaded through different module instances (test mocks that spread
 * `importOriginal`, or a re-bundled server chunk), and misreading a scope miss
 * as an outage is exactly the defect this file exists to prevent.
 */
export function isDocumentSubjectNotFoundError(
  error: unknown,
): error is DocumentSubjectNotFoundError {
  return (
    error instanceof DocumentSubjectNotFoundError ||
    (error instanceof Error && error.name === "DocumentSubjectNotFoundError")
  );
}

/**
 * PostgREST's "no rows returned" code. `.single()` reports an empty result — an
 * absent row and an RLS-filtered row alike — as an *error* with this code,
 * which is a subject miss, not an infrastructure failure. Any other code is.
 */
const NO_ROWS_RETURNED = "PGRST116";

export function isNoRowsError(
  error: { code?: string | null } | null | undefined,
): boolean {
  return !!error && error.code === NO_ROWS_RETURNED;
}
