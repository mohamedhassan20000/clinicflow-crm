import type { DocumentLifecycle } from "@/components/documents/engine/types";

export type PersistedDocumentStatus = "issued" | "void" | "cancelled";

/**
 * Invalidated issued records keep their immutable identity and content, but
 * always render with the shared cancelled presentation.
 */
export function documentPresentationLifecycle(
  status: PersistedDocumentStatus,
): Exclude<DocumentLifecycle, "preview"> {
  return status === "issued" ? "issued" : "cancelled";
}
