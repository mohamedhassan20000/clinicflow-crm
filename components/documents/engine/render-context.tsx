"use client";

import { createContext, useContext } from "react";
import type {
  DocumentRenderContextBoundaryProps,
  DocumentRenderContextValue,
} from "@/components/documents/engine/types";

const DocumentRenderContext = createContext<DocumentRenderContextValue | null>(null);

export function DocumentRenderContextProvider({
  value,
  children,
}: DocumentRenderContextBoundaryProps) {
  return (
    <DocumentRenderContext.Provider value={value}>
      {children}
    </DocumentRenderContext.Provider>
  );
}

export function useDocumentRenderContext(): DocumentRenderContextValue {
  const value = useContext(DocumentRenderContext);
  if (!value) {
    throw new Error("Document primitives must render inside DocumentPage");
  }
  return value;
}
