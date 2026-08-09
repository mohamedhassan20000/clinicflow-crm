import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getIssuedGenericDocument, type IssuedGenericDocument } from "@/actions/generic-documents";
import { GenericDocumentActions } from "@/components/documents/generic-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { GenericDocument } from "@/components/documents/templates/generic-document";
import { Button } from "@/components/ui/button";
import { formatDocDate } from "@/lib/documents/format";
import { getGenericDocumentCopy } from "@/lib/documents/generic-copy";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("genericDocument") };
}

export default async function GenericDocumentPage({ searchParams }: {
  searchParams: Promise<{ documentId?: string }>;
}) {
  const [sp, t] = await Promise.all([searchParams, getTranslations("documentPlatform.ui")]);
  // No documentId means the flow was reached directly — start authoring instead
  // of a source page (never route to an unrelated screen).
  if (!sp.documentId) redirect("/documents/new/scratch");

  const result = await getIssuedGenericDocument(sp.documentId);
  if (!result.data) notFound();
  const issued = result.data;
  const copy = getGenericDocumentCopy(issued.locale);
  const qrDataUrl = issued.snapshot.settings.qrEnabled
    ? await generateDocumentVerificationQrDataUrl(issued.verificationToken) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/documents">
              <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
              {t("backToDocuments")}
            </Link>
          </Button>
          <h1 className="mt-2 text-xl font-semibold">
            {t("issuedDocument", { name: issued.snapshot.title })}
          </h1>
        </div>
        <GenericDocumentActions documentId={issued.id} labels={{
          reprint: t("reprintCanonicalPdf"), preparing: t("preparingPdf"), reprintFailed: t("reprintFailed"),
        }} />
      </div>
      <GenericDocument locale={issued.locale} lifecycle={documentPresentationLifecycle(issued.status)} snapshot={issued.snapshot}
        copy={copy} documentNumber={issued.documentNumber} qrDataUrl={qrDataUrl} />
      <History document={issued} t={t} />
    </div>
  );
}

type Translator = Awaited<ReturnType<typeof getTranslations<"documentPlatform.ui">>>;

function History({ document, t }: { document: IssuedGenericDocument; t: Translator }) {
  return (
    <section className="rounded-xl border bg-card p-5 print:hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("history")}</h2>
        <p className="text-sm text-muted-foreground">{t("printCount", { count: document.printCount })}</p>
      </div>
      <ol className="mt-4 space-y-3">
        {document.events.map((event) => (
          <li key={event.id} className="flex flex-wrap justify-between gap-2 border-s py-1 ps-4 text-sm">
            <span>
              {event.event === "issued" ? t("events.issued")
                : event.event === "reprinted" ? t("events.reprinted") : t("events.updated")}
              <span className="ms-2 text-muted-foreground">{event.actorName || t("systemActor")}</span>
            </span>
            <time className="text-muted-foreground">
              {formatDocDate(event.occurredAt, {
                locale: document.locale, timeZone: document.snapshot.format.timeZone,
              }, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}
