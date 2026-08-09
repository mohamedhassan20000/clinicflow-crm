"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileCheck2, Printer } from "lucide-react";
import { toast } from "sonner";
import { issueClinicalDocument, reprintClinicalDocument } from "@/actions/clinical-documents";
import { Button } from "@/components/ui/button";
import { issuedDocumentDetailHref } from "@/lib/documents/module";
import type { ClinicalDocumentParams } from "@/lib/documents/resolvers/clinical-document";

export function ClinicalDocumentActions({ locale, params, documentId, draftId, labels }: {
  locale: "ar" | "en"; params: ClinicalDocumentParams; documentId?: string; draftId?: string;
  labels: { issue: string; issuing: string; printDraft: string; reprint: string; preparing: string;
    issued: string; issueFailed: string; reprintFailed: string; controlled: string };
}) {
  const router = useRouter();
  const [issuing, startIssue] = useTransition();
  const [reprinting, startReprint] = useTransition();
  function issue() { startIssue(async () => {
    const result = await issueClinicalDocument({ ...params, locale, draftId });
    if (!result.data) { toast.error(result.errorCode === "controlledMedicineBlocked" ? labels.controlled : labels.issueFailed); return; }
    toast.success(labels.issued);
    router.replace(issuedDocumentDetailHref(result.data.documentId));
  }); }
  function reprint() { if (!documentId) return; startReprint(async () => {
    const result = await reprintClinicalDocument(documentId, params.documentType);
    if (!result.data) { toast.error(labels.reprintFailed); return; }
    const anchor = window.document.createElement("a"); anchor.href = result.data.url;
    anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.click(); router.refresh();
  }); }
  return <div className="flex flex-wrap items-center gap-2 print:hidden">
    {documentId ? <Button onClick={reprint} disabled={reprinting}><Download data-icon="inline-start" />
      {reprinting ? labels.preparing : labels.reprint}</Button> : <>
      <Button variant="outline" onClick={() => window.print()}><Printer data-icon="inline-start" />{labels.printDraft}</Button>
      <Button onClick={issue} disabled={issuing}><FileCheck2 data-icon="inline-start" />{issuing ? labels.issuing : labels.issue}</Button>
    </>}
  </div>;
}
