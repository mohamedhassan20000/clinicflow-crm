"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { reprintGenericDocument } from "@/actions/generic-documents";
import { Button } from "@/components/ui/button";

export function GenericDocumentActions({
  documentId, labels,
}: {
  documentId: string;
  labels: { reprint: string; preparing: string; reprintFailed: string };
}) {
  const router = useRouter();
  const [isReprinting, startReprint] = useTransition();

  function reprint() {
    startReprint(async () => {
      const result = await reprintGenericDocument(documentId);
      if (!result.data) {
        toast.error(labels.reprintFailed);
        return;
      }
      const anchor = window.document.createElement("a");
      anchor.href = result.data.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      anchor.click(); router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <Button onClick={reprint} disabled={isReprinting}>
        <Download data-icon="inline-start" />{isReprinting ? labels.preparing : labels.reprint}
      </Button>
    </div>
  );
}
