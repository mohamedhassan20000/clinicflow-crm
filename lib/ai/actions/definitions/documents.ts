import "server-only";

import { z } from "zod";
import {
  ActionBusinessRuleError,
  ActionTransientError,
} from "@/lib/ai/actions/errors";
import {
  registerActionDefinition,
  type ActionDefinition,
  type ActionPreviewChange,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import {
  AI_DOCUMENTS_FEATURE,
  documentPreviewInputSchema,
  prepareDocumentIssue,
} from "@/lib/ai/documents/capability";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  documentIssueFamily,
  issueDocumentCore,
  reprintDocumentCore,
  type DocumentIssueCoreData,
  type DocumentReprintCoreData,
} from "@/lib/documents/mutations";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";
import type { AuthedUser, UserRole } from "@/lib/rbac";

/**
 * Phase 6 — the two document *writes*.
 *
 * Reads (`describe_documents`, `preview_document`, and listing through the
 * `documents` resource) are tools; §11 classes a document preview as `read`.
 * Issuing is a **sensitive** write and reprinting is a normal one, so both run
 * the standard preview → server-minted single-use token → confirm → re-authorize
 * pipeline with a receipt for every attempt, allowed or denied.
 *
 * Neither definition contains document logic. Authorization per type, snapshot
 * resolution, numbering, idempotency, and the append-only reprint RPC all live
 * in `lib/documents/mutations.ts`, which is the same code the UI runs.
 */

/**
 * Every staff role: the catalog's own `pageRoles` plus the report-visibility
 * gate decide which document types each role may actually reach, and they are
 * re-applied inside the core on both phases. Declaring a narrower role list here
 * would be an AI-local restriction the app does not have.
 */
const DOCUMENT_ACTION_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];

/**
 * The rendered document's own language, exactly as the UI's locale switch sets
 * it. P6-09: when the model does not state one it is **derived from the
 * conversation's own locale** rather than defaulting to English — an Arabic
 * conversation must not silently produce an English legal document — and the
 * resolved value is always shown on the confirmation card and written into the
 * canonical input the confirm token is bound to.
 */
const issueInputSchema = documentPreviewInputSchema.extend({
  locale: z.enum(["ar", "en"]).optional(),
});
type IssueInput = z.infer<typeof issueInputSchema>;

/**
 * P6-03 — issuing a clinical document transitions its source record
 * `draft → finalized`, which §11 lists as its own sensitive write. Gating that
 * on `ai.documents` alone let a tier that deliberately withholds
 * `ai.write_records` mutate a clinical record anyway, so the composite requires
 * both. `requiredFeatures` is static per action, so the second gate is applied
 * here, conditionally on the family, and re-applied on both phases.
 */
const AI_WRITE_RECORDS_FEATURE = "ai.write_records" as const;

async function assertClinicalIssuanceFeature(
  user: AuthedUser,
  code: RegisteredDocumentTypeCode,
): Promise<void> {
  if (documentIssueFamily(code) !== "clinical") return;
  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_WRITE_RECORDS_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
}

const reprintInputSchema = z
  .object({ document_id: z.string().uuid() })
  .strict();
type ReprintInput = z.infer<typeof reprintInputSchema>;

/**
 * The preview must fail loudly rather than silently issuing a different
 * document: a still-incomplete or invalid slot set is a business-rule refusal,
 * which the executor reports as `business_rule_violation` and the assistant
 * turns back into a question through `preview_document`.
 */
type IssueOutcome = Awaited<ReturnType<typeof prepareDocumentIssue>>;
type ReadyIssue = Extract<IssueOutcome, { status: "ready" }>;

function requireReadyIssue(outcome: IssueOutcome): ReadyIssue {
  if (outcome.status === "ready") return outcome;
  if (outcome.status === "missing_information") {
    throw new ActionBusinessRuleError(
      `documents.missing_information:${outcome.missing.map((slot) => slot.key).join(",")}${
        outcome.unknown_keys.length > 0
          ? `;unknown:${outcome.unknown_keys.join(",")}`
          : ""
      }`,
    );
  }
  if (outcome.status === "invalid_input") {
    throw new ActionBusinessRuleError(
      `documents.invalid_input:${outcome.questions.map((question) => question.key).join(",")}`,
    );
  }
  if (outcome.status === "transient_failure") {
    throw new ActionTransientError("documents.preview_failed");
  }
  if (outcome.status === "content_too_long") {
    // P6-01: refusing beats truncating. The remainder would otherwise be issued
    // on a permanently numbered, externally verifiable document unseen.
    throw new ActionBusinessRuleError(
      `documents.authored_body_too_long:${outcome.actual_chars}/${outcome.max_chars}`,
    );
  }
  if (outcome.status === "record_not_issuable") {
    throw new ActionBusinessRuleError(
      `documents.record_not_issuable:${outcome.record_status}`,
    );
  }
  // P6-12 — what remains is `not_supported` and `unauthorized_scope`: an
  // out-of-catalog type, a type this caller may not issue, a subject that does
  // not exist, and a subject outside this caller's scope. §11 puts all four on
  // the `unauthorized_scope` row, and reporting them through one reason is what
  // keeps them indistinguishable — an out-of-catalog type is invisible rather
  // than confirmed to exist, and a patient id cannot be probed for existence.
  //
  // Routed through `AiToolAuthorizationError` rather than
  // `ActionBusinessRuleError` so the receipt records
  // `denialReason: "unauthorized_scope"` instead of a `business_rule_refused`
  // row, which §12's ledger needs to answer *why* an attempt was refused. Both
  // `previewRegisteredAction` and `executeRegisteredAction` map it.
  throw new AiToolAuthorizationError("unauthorized_scope");
}

function issueChanges(outcome: ReadyIssue): ActionPreviewChange[] {
  return [
    {
      label: "document",
      before: "not issued",
      // P6-09: `summary.title` is the *localized* catalog label, never the raw
      // `documents.catalog.*` key the card used to render verbatim.
      after: `${outcome.document_type} — ${outcome.summary.title}`,
      identifiesRecord: true,
    },
    // P6-09: the output language is a property of the document itself, so it is
    // stated on the card whether the model chose it or the server derived it.
    { label: "language", before: null, after: outcome.locale },
    // P6-03: the undisclosed half of a clinical issuance. Shown before the
    // confirm control, with the record named, because finalization is
    // irreversible through this path.
    ...(outcome.clinical_record
      ? [
          {
            label: `${outcome.clinical_record.table} ${outcome.clinical_record.record_id}`,
            before: outcome.clinical_record.status,
            after: "finalized",
            identifiesRecord: true as const,
          },
        ]
      : []),
    ...outcome.summary.highlights.map((highlight) => ({
      label: highlight.label,
      before: null,
      after: highlight.value,
    })),
    // P6-01: every authored block, verbatim and in order. Nothing that will
    // appear on the PDF is summarised away or silently dropped.
    ...(outcome.summary.body ?? []).map((entry) => ({
      label: entry.label,
      before: null,
      after: entry.text,
    })),
    ...outcome.auto_filled.map((entry) => ({
      label: `auto-filled ${entry.key}`,
      before: null,
      after: entry.source,
    })),
    ...(outcome.unknown_keys.length > 0
      ? [
          {
            label: "ignored input keys",
            before: null,
            after: outcome.unknown_keys.join(", "),
          },
        ]
      : []),
  ];
}

const ISSUE_BASE_SUMMARY =
  "Issuing allocates a permanent document number, stores the canonical PDF, and makes the document verifiable. It cannot be un-issued, only cancelled.";

function issueSummary(outcome: ReadyIssue): string {
  const parts = [ISSUE_BASE_SUMMARY];
  if ((outcome.summary.body ?? []).length > 0) {
    parts.push(
      "The title and body shown below were composed by the Assistant, not taken from clinic records. They will appear verbatim on a document carrying this clinic's name, logo, licence number and tax id, with a permanent document number and an externally verifiable code. Read the full text before confirming.",
    );
  }
  if (outcome.clinical_record?.will_finalize) {
    parts.push(
      `Confirming also finalizes ${outcome.clinical_record.table} ${outcome.clinical_record.record_id}. A finalized clinical record cannot return to draft; it can only be voided afterwards.`,
    );
  }
  return parts.join(" ");
}

/**
 * P6-07 — the exact invocation the confirm token is minted over.
 *
 * `params` is what `prepareDocumentIssue` actually validated, so a reporting
 * period the server resolved from `this_month` and an entity taken from
 * conversation context are pinned into the input rather than re-derived at
 * execute. A confirm crossing a month boundary inside the token's TTL now
 * issues the previewed period instead of a different one.
 */
function canonicalIssueInput(input: IssueInput, outcome: ReadyIssue): IssueInput {
  return {
    document_type: outcome.document_type,
    params: outcome.params,
    locale: outcome.locale,
    ...(input.period_preset ? { period_preset: input.period_preset } : {}),
    ...(input.period_from ? { period_from: input.period_from } : {}),
    ...(input.period_to ? { period_to: input.period_to } : {}),
  };
}

const issueAction: ActionDefinition<IssueInput> = {
  id: "documents.issue",
  roles: DOCUMENT_ACTION_ROLES,
  requiredFeatures: [AI_DOCUMENTS_FEATURE],
  risk: "sensitive",
  pageSlug: "documents",
  inputSchema: issueInputSchema,
  labels: { en: "Issue a document", ar: "إصدار مستند" },
  description: {
    en: "Issue one ClinicFlow document of a registered type after its snapshot has been resolved. Returns the document number and a link.",
    ar: "إصدار مستند واحد من نوع مسجل بعد تجهيز بياناته، مع رقم المستند ورابطه.",
  },
  inputDescription: {
    en: "The document type plus the exact params preview_document reported as ready. Omit locale to render the document in the conversation's own language.",
    ar: "نوع المستند مع المدخلات التي أكدت أداة المعاينة جاهزيتها. اترك اللغة فارغة لإصدار المستند بلغة المحادثة.",
  },
  async preview(user, input, context) {
    // P6-07 — the same server-derived conversation defaults `preview_document`
    // already applies, so a request that tool reported `ready` does not become
    // `missing_information` here for an id the model was never asked for.
    const outcome = requireReadyIssue(
      await prepareDocumentIssue(user, input, {
        patientId: context.activePatientId,
        appointmentId: context.activeAppointmentId,
        locale: input.locale ?? context.locale,
        now: context.now,
      }),
    );
    await assertClinicalIssuanceFeature(user, outcome.document_type);
    return {
      title: `Issue ${outcome.document_type}`,
      summary: issueSummary(outcome),
      changes: issueChanges(outcome),
      canonicalInput: canonicalIssueInput(input, outcome),
      audit: {
        targetTable: "documents",
        targetRecordIds: outcome.clinical_record
          ? [outcome.clinical_record.record_id]
          : [],
        before: {
          doc_type: outcome.document_type,
          status: "not_issued",
          ...(outcome.clinical_record
            ? { clinical_record_status: outcome.clinical_record.status }
            : {}),
        },
        after: {
          doc_type: outcome.document_type,
          status: "issued",
          ...(outcome.clinical_record ? { clinical_record_status: "finalized" } : {}),
        },
      },
    };
  },
  async execute(user, input, context) {
    // Re-prepare rather than trusting the previewed params: authorization,
    // slot completeness, and snapshot resolution are all re-run after the
    // confirmation token was claimed.
    const outcome = requireReadyIssue(
      await prepareDocumentIssue(user, input, {
        patientId: context.activePatientId,
        appointmentId: context.activeAppointmentId,
        locale: input.locale ?? context.locale,
        now: context.now,
      }),
    );
    await assertClinicalIssuanceFeature(user, outcome.document_type);
    const result = await issueDocumentCore(
      user,
      {
        documentType: outcome.document_type,
        params: outcome.params,
        locale: outcome.locale,
        // §8.4 — derived from the single-use confirm token, so a retry of the
        // same confirmed action reuses the same document and number.
        idempotencyKey: context.idempotencyKey,
      },
      "execute",
    );
    if (!result.ok) throw new ActionBusinessRuleError(`documents.${result.code}`);
    const issued = result.data as DocumentIssueCoreData;
    return {
      summary: `Document ${issued.documentNumber} issued.`,
      data: {
        document_id: issued.documentId,
        document_number: issued.documentNumber,
        document_type: outcome.document_type,
        reused: issued.reused,
        href: issued.detailHref,
        pdf_href: issued.pdfHref,
      },
      audit: result.audit,
    };
  },
};

const reprintAction: ActionDefinition<ReprintInput> = {
  id: "documents.reprint",
  roles: DOCUMENT_ACTION_ROLES,
  requiredFeatures: [AI_DOCUMENTS_FEATURE],
  risk: "normal",
  pageSlug: "documents",
  inputSchema: reprintInputSchema,
  labels: { en: "Reprint a document", ar: "إعادة طباعة مستند" },
  description: {
    en: "Re-serve an already-issued document's stored PDF, recording the reprint on its history.",
    ar: "إعادة تقديم ملف PDF المخزن لمستند صادر مع تسجيل إعادة الطباعة في سجله.",
  },
  inputDescription: {
    en: "The id of an issued document the user is authorized to see.",
    ar: "معرّف مستند صادر يملك المستخدم صلاحية الاطلاع عليه.",
  },
  async preview(user, input) {
    const result = await reprintDocumentCore(user, input.document_id, "preview");
    if (!result.ok) throw new ActionBusinessRuleError(`documents.${result.code}`);
    const document = result.data as DocumentReprintCoreData;
    return {
      title: `Reprint ${document.documentNumber}`,
      summary: "Reprinting re-serves the stored PDF and records a reprint event.",
      changes: [
        {
          label: "document",
          before: `${document.documentType} ${document.documentNumber}`,
          after: `${document.documentType} ${document.documentNumber}`,
          identifiesRecord: true,
        },
        {
          label: "print_count",
          before: document.printCount,
          after: document.printCount + 1,
        },
      ],
      audit: result.audit,
    };
  },
  async execute(user, input) {
    const result = await reprintDocumentCore(user, input.document_id, "execute");
    if (!result.ok) throw new ActionBusinessRuleError(`documents.${result.code}`);
    const document = result.data as DocumentReprintCoreData;
    return {
      summary: `Document ${document.documentNumber} is ready to print again.`,
      data: {
        document_id: document.documentId,
        document_number: document.documentNumber,
        print_count: document.printCount,
        pdf_href: document.pdfHref,
      },
      audit: result.audit,
    };
  },
};

export const DOCUMENT_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] = [
  registerActionDefinition(issueAction),
  registerActionDefinition(reprintAction),
];
