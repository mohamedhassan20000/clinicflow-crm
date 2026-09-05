import "server-only";

import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AI_DOCUMENTS_FEATURE } from "@/lib/ai/documents/capability";
import { assertDocumentTypeAccess } from "@/lib/documents/mutations";
import { getAccessibleDocumentTypeCodes } from "@/lib/documents/module";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";
import type { ResourceId } from "@/lib/ai/resources/types";
import type { PermissionUserRole } from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";
import { roleMountsActionTools } from "@/lib/ai/tools/registry";

/**
 * Phase 6 — §7.5's bulk-read escape hatch.
 *
 * When a `query_resource` page is truncated, streaming the remaining rows
 * through the model is the wrong answer on three counts: it multiplies PHI
 * egress to the inference provider, it costs tokens linearly in the row count,
 * and the user ends up with a chat transcript instead of a document. So the
 * truthful "Showing 50 of 412" notice now carries a *route out*: the document
 * type that covers this resource, which the assistant can offer instead.
 *
 * The suggestion is advisory metadata. It is emitted only when the caller could
 * genuinely issue that type — plan feature, catalog role, and report visibility
 * all check out — so it can never advertise a capability that would then be
 * denied. It grants nothing on its own: issuing still runs the full
 * `documents.issue` preview → confirm → re-authorize pipeline.
 */

const EXPORT_TYPE_BY_RESOURCE: Partial<
  Record<ResourceId, RegisteredDocumentTypeCode>
> = {
  patients: "PATIENT_LIST_REPORT",
  profiles: "SYSTEM_MEMBERS_REPORT",
  follow_ups: "FOLLOW_UP_PAGE_REPORT",
  appointments: "APPOINTMENT_HISTORY_REPORT",
  patient_packages: "PACKAGE_HISTORY_REPORT",
};

export type ResourceExportSuggestion = {
  document_type: RegisteredDocumentTypeCode;
  action_id: "documents.issue";
  guidance: string;
};

export async function resourceExportSuggestion(
  user: AuthedUser,
  resourceId: string,
): Promise<ResourceExportSuggestion | null> {
  const documentType = EXPORT_TYPE_BY_RESOURCE[resourceId as ResourceId];
  if (!documentType) return null;
  // The guidance names `documents.issue`, which is only invocable through the
  // `execute_action` mount. Checking catalog role, plan feature and report
  // visibility proved the caller may *issue* the type but not that they can
  // reach the action at all — final review B-2's second-order defect. Asserted
  // here so the promise above ("can never advertise a capability that would
  // then be denied") holds structurally rather than incidentally.
  if (!roleMountsActionTools(user.role)) return null;
  if (
    !getAccessibleDocumentTypeCodes(user.role as PermissionUserRole).includes(
      documentType,
    )
  ) {
    return null;
  }
  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_DOCUMENTS_FEATURE)) return null;
  const access = await assertDocumentTypeAccess(user, documentType);
  if (!access.ok) return null;

  return {
    document_type: documentType,
    action_id: "documents.issue",
    guidance: `More rows exist than one page can show. Do not page through them one call at a time — offer the user a ${documentType} document instead, prepared with preview_document and issued with the documents.issue action.`,
  };
}
