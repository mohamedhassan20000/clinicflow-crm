import type { ReactNode } from "react";
import type { DocumentRenderContextBoundaryProps } from "@/components/documents/engine/types";

/**
 * React's static HTML renderer cannot execute a Next.js Client Component
 * reference. Document primitives currently receive their render values as
 * explicit, immutable props, so the PDF path only needs a server-safe boundary
 * around the exact same document tree. Browser previews continue to use the
 * client context provider and retain the public context-hook contract.
 */
export function StaticDocumentRenderBoundary({
  children,
}: DocumentRenderContextBoundaryProps): ReactNode {
  return children;
}
