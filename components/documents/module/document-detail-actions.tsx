"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Download, ExternalLink, Eye, Loader2, Printer } from "lucide-react";
import {
  cancelClinicDocument,
  reprintClinicDocumentFromModule,
} from "@/actions/documents-module";
import { Button } from "@/components/ui/button";

type Props = {
  documentId: string;
  renderedHref: string | null;
  verificationToken: string;
  status: "not_issued" | "issued" | "cancelled";
};

export function DocumentDetailActions({
  documentId,
  renderedHref,
  verificationToken,
  status,
}: Props) {
  const t = useTranslations("documents.module.detail");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function downloadPdf() {
    startTransition(async () => {
      const result = await reprintClinicDocumentFromModule(documentId);
      if (result.data) {
        window.open(result.data.url, "_blank", "noopener,noreferrer");
      } else {
        const message = (() => {
          switch (result.failureStage) {
            case "storedPdfLookup":
              return t("reprintFailedStoredPdf");
            case "signedUrlCreation":
              return t("reprintFailedSignedUrl");
            case "registryResolution":
              return t("reprintFailedRegistry");
            case "inputValidation":
            case "documentLookup":
              return t("reprintFailedDocumentLookup");
            case "actionDispatch":
              return t("reprintFailedAction");
            default:
              return t("reprintFailed");
          }
        })();
        toast.error(message);
      }
    });
  }

  function cancelDocument() {
    if (!window.confirm(t("cancelConfirm"))) return;
    startTransition(async () => {
      const result = await cancelClinicDocument(documentId);
      if (!result.data) {
        toast.error(t("cancelFailed"));
        return;
      }
      toast.success(t("cancelled"));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {renderedHref && (
        <Button asChild variant="outline">
          <Link href={renderedHref}>
            <Eye className="size-4" data-icon="inline-start" />
            {t("viewRendered")}
          </Link>
        </Button>
      )}
      <Button variant="outline" onClick={downloadPdf} disabled={pending}>
        {pending ? (
          <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
        ) : (
          <Download className="size-4" data-icon="inline-start" />
        )}
        {pending ? t("preparing") : t("downloadPdf")}
      </Button>
      <Button asChild variant="outline">
        <Link href={`/verify/${verificationToken}`} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-4 rtl:-scale-x-100" data-icon="inline-start" />
          {t("openVerification")}
        </Link>
      </Button>
      <Button variant="ghost" onClick={() => window.print()}>
        <Printer className="size-4" data-icon="inline-start" />
        {t("print")}
      </Button>
      {status === "issued" && (
        <Button variant="destructive" onClick={cancelDocument} disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
          ) : (
            <Ban className="size-4" data-icon="inline-start" />
          )}
          {t("cancelDocument")}
        </Button>
      )}
    </div>
  );
}
