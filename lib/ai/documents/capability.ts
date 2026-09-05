import "server-only";

import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  DOCUMENT_CATALOG,
  isRegisteredDocumentType,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import {
  getAccessibleDocumentTypeCodes,
  REGISTERED_DOCUMENT_TYPE_CODES,
} from "@/lib/documents/module";
import {
  assertDocumentTypeAccess,
  authoredBodyLength,
  documentIssueFamily,
  documentParamsSchema,
  previewDocumentCore,
  resolveClinicalRecordIssueState,
  MAX_ASSISTANT_AUTHORED_BODY_CHARS,
  type ClinicalRecordIssueState,
  type DocumentSnapshotSummary,
} from "@/lib/documents/mutations";
import {
  autoFillDocumentSlots,
  documentValidationQuestions,
  evaluateDocumentSlots,
  documentIssueSlots,
  type DocumentAutoFillHint,
  type DocumentSlot,
} from "@/lib/documents/slots";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import type { PermissionUserRole } from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";

/**
 * Phase 6 — the Assistant's front door onto the completed P7 document platform.
 *
 * Nothing here re-implements document logic. `DOCUMENT_CATALOG` already is the
 * capability manifest, `lib/documents/slots.ts` projects it into answerable
 * questions, and `lib/documents/mutations.ts` owns resolution and issuance. This
 * module only composes them behind the two authorization gates the plan permits
 * above app authorization: the `ai.documents` plan feature and the type's own
 * catalog role / report visibility.
 */

export const AI_DOCUMENTS_FEATURE = "ai.documents" as const;

export async function assertDocumentToolAccess(user: AuthedUser): Promise<void> {
  await assertStaffToolAccess(user);
  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_DOCUMENTS_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
}

export type DescribedDocumentType = {
  document_type: RegisteredDocumentTypeCode;
  archetype: string;
  subject: string;
  title_key: string;
  required_slots: { key: string; description: string; resolver?: string }[];
  optional_slots: { key: string; description: string; resolver?: string }[];
  auto_filled_by_server: string[];
};

function projectSlot(slot: DocumentSlot, locale: "en" | "ar") {
  return {
    key: slot.key,
    description: slot.description[locale],
    ...(slot.resolver ? { resolver: slot.resolver } : {}),
  };
}

/**
 * Rank catalog entries against a free-text request. Deliberately a plain
 * substring/token score over server-owned catalog metadata — the model already
 * has the full permitted list, so this is ordering, never filtering-by-guess.
 */
function scoreEntry(code: RegisteredDocumentTypeCode, query: string): number {
  if (!query) return 0;
  const haystack = `${code} ${DOCUMENT_CATALOG[code].archetype} ${DOCUMENT_CATALOG[code].subject} ${DOCUMENT_CATALOG[code].titleKey}`
    .toLowerCase()
    .replaceAll("_", " ");
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.reduce(
    (score, token) => (haystack.includes(token) ? score + 1 : score),
    0,
  );
}

/**
 * §10 `documents.describe`. Returns only the catalog entries this exact user may
 * issue, each with its `filterSchema` projected into required/optional slots. A
 * type the caller may not issue is **absent**, never denied — the same
 * non-leaking shape `listClinicDocuments` already uses.
 */
export async function describeIssuableDocuments(
  user: AuthedUser,
  options: { query?: string | null; locale?: "en" | "ar" } = {},
): Promise<DescribedDocumentType[]> {
  await assertDocumentToolAccess(user);
  const locale = options.locale ?? "en";
  const accessible = new Set(
    getAccessibleDocumentTypeCodes(user.role as PermissionUserRole),
  );
  const query = options.query?.trim() ?? "";
  // P6-10 — one `reports` page read for the whole loop instead of one per
  // report-backed candidate type.
  const reportsPageVisibility = await getPageVisibilityState(user, "reports");

  const described: (DescribedDocumentType | null)[] = await Promise.all(
    REGISTERED_DOCUMENT_TYPE_CODES.filter((code) => accessible.has(code)).map(
      async (code) => {
        // Report-backed types carry a second, per-user visibility gate.
        const access = await assertDocumentTypeAccess(user, code, {
          reportsPageVisibility,
        });
        if (!access.ok) return null;
        const slots = documentIssueSlots(code);
        const entry = DOCUMENT_CATALOG[code];
        return {
          document_type: code,
          archetype: entry.archetype,
          subject: entry.subject,
          title_key: entry.titleKey,
          required_slots: slots
            .filter((slot) => slot.required)
            .map((slot) => projectSlot(slot, locale)),
          optional_slots: slots
            .filter((slot) => !slot.required)
            .map((slot) => projectSlot(slot, locale)),
          auto_filled_by_server: [
            "creator",
            ...slots
              .filter((slot) => slot.autoFill !== null)
              .map((slot) => slot.key),
          ],
        } satisfies DescribedDocumentType;
      },
    ),
  );

  return described
    .filter((entry): entry is DescribedDocumentType => entry !== null)
    .sort(
      (a, b) =>
        scoreEntry(b.document_type, query) - scoreEntry(a.document_type, query),
    );
}

export const documentPreviewInputSchema = z
  .object({
    document_type: z.string().min(1).max(64),
    params: z.record(z.string(), z.unknown()).default({}),
    period_preset: z
      .enum(["today", "this_week", "last_week", "this_month", "last_month", "last_year", "custom"])
      .optional(),
    period_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    period_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export type DocumentPreviewInput = z.infer<typeof documentPreviewInputSchema>;

export type DocumentPreviewOutcome =
  | { status: "not_supported"; document_type: string; valid_document_types: string[] }
  /**
   * §11's "RLS returned nothing / record outside scope" row. Carries only the
   * requested type: an unavailable type, an unknown type, a subject that does
   * not exist and a subject belonging to another scope are one shape, so none
   * of them can be told apart (P6-12).
   */
  | { status: "unauthorized_scope"; document_type: string }
  /**
   * P6-06 — a resolver/render/database failure is not an authorization
   * statement. §11's taxonomy adds `transient_failure` for exactly this, with
   * the tested invariant that a denial is never reported under a reason
   * belonging in another row; reporting it as `unauthorized_scope` told the user
   * their own data was out of scope and suppressed the retry guidance.
   */
  | { status: "transient_failure"; document_type: RegisteredDocumentTypeCode }
  | {
      status: "missing_information";
      document_type: RegisteredDocumentTypeCode;
      missing: { key: string; description: string; resolver?: string }[];
      auto_filled: { key: string; source: string }[];
      /** P6-08 — params keys that were supplied but are not slots of this type. */
      unknown_keys: string[];
    }
  | {
      status: "invalid_input";
      document_type: RegisteredDocumentTypeCode;
      questions: { key: string; question: string }[];
      unknown_keys: string[];
    }
  /**
   * P6-01 — authored body text beyond what a confirmation card can honestly
   * display. Refused rather than truncated: the alternative is a permanently
   * numbered, externally verifiable clinic document carrying text the approver
   * never saw.
   */
  | {
      status: "content_too_long";
      document_type: RegisteredDocumentTypeCode;
      max_chars: number;
      actual_chars: number;
    }
  /**
   * P6-03 — the clinical record backing this document is in a state issuance
   * cannot act on (cancelled/void). Discovered at preview instead of at execute.
   */
  | {
      status: "record_not_issuable";
      document_type: RegisteredDocumentTypeCode;
      record_id: string;
      record_status: string;
    }
  | {
      status: "ready";
      document_type: RegisteredDocumentTypeCode;
      params: Record<string, unknown>;
      auto_filled: { key: string; source: string }[];
      unknown_keys: string[];
      /** The language the issued PDF will be rendered in. */
      locale: "ar" | "en";
      summary: DocumentSnapshotSummary;
      /** P6-03 — present for clinical types; the record issuance will finalize. */
      clinical_record?: {
        table: string;
        record_id: string;
        status: string;
        will_finalize: boolean;
      };
    };

export type DocumentPrepareContext = Omit<
  DocumentAutoFillHint,
  "preset" | "from" | "to"
> & {
  /**
   * P6-09 — the conversation's own language. An Arabic conversation must not
   * silently produce an English legal document, and the chosen language is
   * disclosed on the confirmation card either way.
   */
  locale?: "ar" | "en";
};

/**
 * The document types this exact user may issue, as codes. Shares the
 * permission-filtered path with `describeIssuableDocuments` so the two surfaces
 * can never disagree about what is available (P6-05).
 */
async function accessibleDocumentTypeCodes(
  user: AuthedUser,
): Promise<RegisteredDocumentTypeCode[]> {
  const roleAccessible = getAccessibleDocumentTypeCodes(
    user.role as PermissionUserRole,
  );
  const reportsPageVisibility = await getPageVisibilityState(user, "reports");
  const checked = await Promise.all(
    roleAccessible.map(async (code) =>
      (await assertDocumentTypeAccess(user, code, { reportsPageVisibility })).ok
        ? code
        : null,
    ),
  );
  return checked.filter((code): code is RegisteredDocumentTypeCode => code !== null);
}

/**
 * §10 steps 2–5. Auto-fills what the server can derive, asks **only** for
 * genuinely missing required slots, converts a zod failure into questions rather
 * than a refusal, and otherwise resolves a real snapshot so `documents.issue`
 * can be previewed with confidence.
 *
 * Returns the auto-filled params so the issue action operates on the exact
 * object that was validated here.
 */
export async function prepareDocumentIssue(
  user: AuthedUser,
  input: DocumentPreviewInput,
  hint: DocumentPrepareContext = {},
): Promise<DocumentPreviewOutcome> {
  await assertDocumentToolAccess(user);
  const locale = hint.locale ?? "en";
  if (!isRegisteredDocumentType(input.document_type)) {
    return {
      status: "not_supported",
      document_type: input.document_type,
      // P6-05: the same permission-filtered list `describe_documents` returns.
      // A role-only list named types the very next call would refuse by name,
      // contradicting "unauthorized is invisible, never a 403 that confirms it".
      valid_document_types: await accessibleDocumentTypeCodes(user),
    };
  }
  const code = input.document_type;
  const access = await assertDocumentTypeAccess(user, code);
  if (!access.ok) {
    // Role miss and hidden report are reported identically, so an unauthorized
    // type is invisible rather than a 403 that confirms it exists.
    return { status: "unauthorized_scope", document_type: code };
  }

  const { params, autoFilled } = autoFillDocumentSlots(code, input.params, {
    preset: input.period_preset,
    from: input.period_from,
    to: input.period_to,
    patientId: hint.patientId ?? null,
    appointmentId: hint.appointmentId ?? null,
    now: hint.now,
  });
  const evaluation = evaluateDocumentSlots(code, params);
  // §7.3's house rule: an input the server computed but cannot use is dropped
  // *and reported*, never silently. Without this a mis-cased slot
  // (`patient_id` for `patientId`) came back as "missing patientId" with no
  // signal that the supplied key had been ignored.
  const unknownKeys = evaluation.unknownKeys;
  if (!evaluation.ready) {
    return {
      status: "missing_information",
      document_type: code,
      missing: evaluation.missingRequired.map((slot) => projectSlot(slot, "en")),
      auto_filled: autoFilled,
      unknown_keys: unknownKeys,
    };
  }

  const parsed = documentParamsSchema(code).safeParse(params);
  if (!parsed.success) {
    return {
      status: "invalid_input",
      document_type: code,
      questions: documentValidationQuestions(code, parsed.error.issues),
      unknown_keys: unknownKeys,
    };
  }

  // P6-03 — resolve the clinical record's lifecycle state *before* resolving a
  // snapshot, so a record issuance cannot act on is refused at preview with the
  // state named, rather than discovered as a generic failure at execute.
  let clinicalRecord: ClinicalRecordIssueState | null = null;
  if (documentIssueFamily(code) === "clinical") {
    const recordId = String((params as { recordId?: unknown }).recordId ?? "");
    clinicalRecord = await resolveClinicalRecordIssueState(user, code, recordId);
    if (clinicalRecord && !["draft", "finalized"].includes(clinicalRecord.status)) {
      return {
        status: "record_not_issuable",
        document_type: code,
        record_id: clinicalRecord.recordId,
        record_status: clinicalRecord.status,
      };
    }
  }

  const preview = await previewDocumentCore(user, code, params, { locale });
  if (!preview.ok) {
    if (preview.code === "invalidInput" && preview.validationError) {
      return {
        status: "invalid_input",
        document_type: code,
        questions: documentValidationQuestions(
          code,
          preview.validationError.issues,
        ),
        unknown_keys: unknownKeys,
      };
    }
    // P6-12 — `previewFailed` now means only a genuine transient/infrastructure
    // failure. A subject that resolved to nothing (absent *or* outside this
    // caller's scope) arrives as `documentSubjectNotFound` and joins the
    // unavailable-type and unknown-type cases on the single `unauthorized_scope`
    // outcome below, which carries nothing but the requested type — so
    // "does not exist" and "not yours" stay byte-identical.
    if (preview.code === "previewFailed") {
      return { status: "transient_failure", document_type: code };
    }
    return { status: "unauthorized_scope", document_type: code };
  }

  const bodyChars = authoredBodyLength(preview.data.body);
  if (bodyChars > MAX_ASSISTANT_AUTHORED_BODY_CHARS) {
    return {
      status: "content_too_long",
      document_type: code,
      max_chars: MAX_ASSISTANT_AUTHORED_BODY_CHARS,
      actual_chars: bodyChars,
    };
  }

  return {
    status: "ready",
    document_type: code,
    params,
    auto_filled: autoFilled,
    unknown_keys: unknownKeys,
    locale,
    summary: preview.data,
    ...(clinicalRecord
      ? {
          clinical_record: {
            table: clinicalRecord.table,
            record_id: clinicalRecord.recordId,
            status: clinicalRecord.status,
            will_finalize: clinicalRecord.willFinalize,
          },
        }
      : {}),
  };
}
