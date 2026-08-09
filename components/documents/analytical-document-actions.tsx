"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileCheck2, Printer } from "lucide-react";
import { toast } from "sonner";
import {
  issueAnalyticalReportDocument,
  reprintAnalyticalReportDocument,
} from "@/actions/documents";
import { Button } from "@/components/ui/button";
import { issuedDocumentDetailHref } from "@/lib/documents/module";
import type { AnalyticalDocumentParams } from "@/lib/documents/resolvers/analytical-report";

export function AnalyticalDocumentActions({
  locale,
  params,
  idempotencyKey,
  documentId,
  draftId,
  labels,
}: {
  locale: "ar" | "en";
  params: AnalyticalDocumentParams;
  idempotencyKey: string;
  documentId?: string;
  draftId?: string;
  labels: {
    issue: string;
    issuing: string;
    printDraft: string;
    reprint: string;
    preparing: string;
    issued: string;
    issueFailed: string;
    reprintFailed: string;
  };
}) {
  const router = useRouter();
  const [isIssuing, startIssue] = useTransition();
  const [isReprinting, startReprint] = useTransition();

  function issue() {
    startIssue(async () => {
      const result = await issueAnalyticalReportDocument({
        ...params,
        locale,
        idempotencyKey,
        draftId,
      });
      if (!result.data) {
        toast.error(labels.issueFailed);
        return;
      }
      toast.success(labels.issued);
      router.replace(issuedDocumentDetailHref(result.data.documentId));
    });
  }

  function reprint() {
    if (!documentId) return;
    startReprint(async () => {
      const result = await reprintAnalyticalReportDocument(
        documentId,
        params.documentType,
      );
      if (!result.data) {
        toast.error(labels.reprintFailed);
        return;
      }
      const anchor = window.document.createElement("a");
      anchor.href = result.data.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {documentId ? (
        <Button onClick={reprint} disabled={isReprinting}>
          <Download data-icon="inline-start" />
          {isReprinting ? labels.preparing : labels.reprint}
        </Button>
      ) : (
        <>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer data-icon="inline-start" />
            {labels.printDraft}
          </Button>
          <Button onClick={issue} disabled={isIssuing}>
            <FileCheck2 data-icon="inline-start" />
            {isIssuing ? labels.issuing : labels.issue}
          </Button>
        </>
      )}
    </div>
  );
}
