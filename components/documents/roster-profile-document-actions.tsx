"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileCheck2, Paperclip, Printer } from "lucide-react";
import { toast } from "sonner";
import { issueRosterProfileDocument, reprintRosterProfileDocument } from "@/actions/documents";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { issuedDocumentDetailHref } from "@/lib/documents/module";
import type { RosterProfileAttachment, RosterProfileDocumentParams } from "@/lib/documents/resolvers/roster-profile";

export function RosterProfileDocumentActions({
  locale, params, idempotencyKey, documentId, draftId, attachments = [], labels,
}: {
  locale: "ar" | "en";
  params: RosterProfileDocumentParams;
  idempotencyKey: string;
  documentId?: string;
  draftId?: string;
  attachments?: RosterProfileAttachment[];
  labels: {
    issue: string; issuing: string; printDraft: string; reprint: string; preparing: string;
    issued: string; issueFailed: string; reprintFailed: string; includeAttachments: string;
    attachmentLimit: string;
    megabytesShort: string;
  };
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [isIssuing, startIssue] = useTransition();
  const [isReprinting, startReprint] = useTransition();
  const selectedBytes = attachments.filter((item) => selected.includes(item.key))
    .reduce((sum, item) => sum + item.sizeBytes, 0);

  function issue() {
    startIssue(async () => {
      const result = await issueRosterProfileDocument({
        ...params, locale, idempotencyKey, attachmentKeys: selected, draftId,
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
      const result = await reprintRosterProfileDocument(documentId, params.documentType);
      if (!result.data) {
        toast.error(labels.reprintFailed);
        return;
      }
      const anchor = window.document.createElement("a");
      anchor.href = result.data.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      anchor.click(); router.refresh();
    });
  }

  return <div className="flex flex-col items-end gap-2 print:hidden">
    {!documentId && attachments.length > 0 && (
      <details className="w-full max-w-md rounded-lg border bg-card p-3 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          <Paperclip className="size-4" aria-hidden />
          {labels.includeAttachments}
          <span className="ms-auto text-xs text-muted-foreground">{selected.length} · {(selectedBytes / 1048576).toFixed(1)} {labels.megabytesShort}</span>
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{labels.attachmentLimit}</p>
        <div className="mt-3 grid gap-2">
          {attachments.map((attachment) => {
            const checked = selected.includes(attachment.key);
            return <label key={attachment.key} className="flex cursor-pointer items-start gap-2 rounded-md border p-2">
              <Checkbox checked={checked} onCheckedChange={(value) => setSelected((current) =>
                value ? [...current, attachment.key] : current.filter((key) => key !== attachment.key))} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{attachment.label || attachment.fileName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {attachment.fileName} · {(attachment.sizeBytes / 1048576).toFixed(1)} {labels.megabytesShort}
                </span>
              </span>
            </label>;
          })}
        </div>
      </details>
    )}
    <div className="flex flex-wrap items-center gap-2">
      {documentId ? (
        <Button onClick={reprint} disabled={isReprinting}>
          <Download data-icon="inline-start" />{isReprinting ? labels.preparing : labels.reprint}
        </Button>
      ) : <>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer data-icon="inline-start" />{labels.printDraft}
        </Button>
        <Button onClick={issue} disabled={isIssuing || selected.length > 10 || selectedBytes > 25 * 1048576}>
          <FileCheck2 data-icon="inline-start" />{isIssuing ? labels.issuing : labels.issue}
        </Button>
      </>}
    </div>
  </div>;
}
