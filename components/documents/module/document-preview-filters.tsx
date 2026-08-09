import {
  DocumentSetupControls,
  type DocumentSetupValues,
} from "@/components/documents/module/document-setup-controls";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";
import {
  documentPreviewSurfaceHref,
  documentSetupFields,
} from "@/lib/documents/module";
import { getDocumentSetupLabels, loadDocumentSetupOptions } from "@/lib/documents/setup";
import { requireUser } from "@/lib/rbac";
import type { Locale } from "@/lib/i18n/config";

/**
 * P7 Phase 4 — the editable filter toolbar shown on a Type A document Preview.
 * It reuses the exact same control + canonical query as the setup popup, so a
 * change re-resolves both the Preview snapshot and the issued-document dataset
 * immediately (no flow restart). Rendered only in the draft/preview lifecycle.
 */
export async function DocumentPreviewFilters({
  code, locale, initial, fromModule, draftId, extraParams,
}: {
  code: RegisteredDocumentTypeCode;
  locale: Locale;
  initial: DocumentSetupValues;
  fromModule?: boolean;
  draftId?: string;
  extraParams?: Record<string, string>;
}) {
  const fields = documentSetupFields(code);
  if (fields.length === 0) return null;
  const user = await requireUser();
  const [options, labels] = await Promise.all([
    loadDocumentSetupOptions(user, fields),
    getDocumentSetupLabels(),
  ]);
  return (
    <DocumentSetupControls
      fields={fields}
      options={options}
      initial={initial}
      targetHref={documentPreviewSurfaceHref(code)}
      locale={locale}
      mode="toolbar"
      labels={labels}
      extraParams={{
        ...(fromModule ? { origin: "documents" } : {}),
        ...extraParams,
      }}
      documentType={draftId ? code : undefined}
      draftId={draftId}
    />
  );
}
