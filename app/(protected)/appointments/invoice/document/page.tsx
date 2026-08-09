import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages, Pencil } from "lucide-react";
import { getTranslations } from "next-intl/server";
import {
  getIssuedInvoiceDocument,
  previewInvoiceDocument,
} from "@/actions/documents";
import { InvoiceDocumentActions } from "@/components/documents/invoice-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { InvoiceDocument } from "@/components/documents/templates/invoice";
import { Button } from "@/components/ui/button";
import { formatDocDate } from "@/lib/documents/format";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import type { Locale } from "@/lib/i18n/config";

type InvoiceDocumentSearchParams = {
  appointmentId?: string;
  locale?: string;
  documentId?: string;
  origin?: string;
  draftId?: string;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("invoiceDocument") };
}

export default async function InvoiceDocumentPage({
  searchParams,
}: {
  searchParams: Promise<InvoiceDocumentSearchParams>;
}) {
  const sp = await searchParams;
  const [t, issuedResult] = await Promise.all([
    getTranslations("documentPlatform.ui"),
    sp.documentId
      ? getIssuedInvoiceDocument(sp.documentId)
      : Promise.resolve(null),
  ]);

  if (sp.documentId) {
    if (!issuedResult?.data) notFound();
    const document = issuedResult.data;
    const [copy, qrDataUrl] = await Promise.all([
      getInvoiceCopy(document.locale),
      document.snapshot.settings.qrEnabled
        ? generateDocumentVerificationQrDataUrl(document.verificationToken)
        : Promise.resolve(null),
    ]);
    return (
      <div className="flex flex-col gap-6">
        <DocumentToolbar
          title={t("issuedInvoiceDocument")}
          backLabel={t("backToDocuments")}
          backHref="/documents"
          actions={(
            <InvoiceDocumentActions
              locale={document.locale}
              appointmentId={document.snapshot.appointmentId}
              documentId={document.id}
              labels={actionLabels(t)}
            />
          )}
        />
        <InvoiceDocument
          locale={document.locale}
          lifecycle={documentPresentationLifecycle(document.status)}
          snapshot={document.snapshot}
          copy={copy}
          documentNumber={document.documentNumber}
          qrDataUrl={qrDataUrl}
        />
        <DocumentHistory document={document} t={t} />
      </div>
    );
  }

  const appointmentId = sp.appointmentId?.trim();
  if (!appointmentId) notFound();

  const locale: Locale = sp.locale === "ar" ? "ar" : "en";
  const [previewResult, copy] = await Promise.all([
    previewInvoiceDocument({ appointmentId }),
    getInvoiceCopy(locale),
  ]);
  if (!previewResult.data) notFound();

  return (
    <div className="flex flex-col gap-6">
      <DocumentToolbar
        title={t("draftInvoiceDocument")}
        backLabel={sp.origin === "documents" ? t("backToDocuments") : t("backToAppointments")}
        backHref={sp.origin === "documents" ? "/documents" : "/appointments"}
        editHref={sp.origin === "documents" ? `/documents/new/invoice${sp.draftId ? `?draftId=${encodeURIComponent(sp.draftId)}` /* i18n-allow: URL query syntax, not user-facing copy */ : ""}` : undefined}
        editLabel={t("edit")}
        localeLinks={(
          <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
            <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
            <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}>
              <Link href={previewHref(appointmentId, "en", sp.origin, sp.draftId)}>{t("english")}</Link>
            </Button>
            <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}>
              <Link href={previewHref(appointmentId, "ar", sp.origin, sp.draftId)}>{t("arabic")}</Link>
            </Button>
          </div>
        )}
        actions={(
          <InvoiceDocumentActions
            locale={locale}
            appointmentId={appointmentId}
            draftId={sp.draftId}
            labels={actionLabels(t)}
          />
        )}
      />
      <InvoiceDocument
        locale={locale}
        lifecycle="preview"
        snapshot={previewResult.data}
        copy={copy}
      />
    </div>
  );
}

function previewHref(appointmentId: string, locale: Locale, origin?: string, draftId?: string): string {
  const query = new URLSearchParams({ appointmentId, locale });
  if (origin === "documents") query.set("origin", "documents");
  if (draftId) query.set("draftId", draftId);
  return `/appointments/invoice/document?${query.toString()}`;
}

type UiTranslator = Awaited<ReturnType<typeof getTranslations<"documentPlatform.ui">>>;

function actionLabels(t: UiTranslator) {
  return {
    issue: t("issue"),
    issuing: t("issuing"),
    printDraft: t("printDraft"),
    reprint: t("reprintCanonicalPdf"),
    preparing: t("preparingPdf"),
    issued: t("issuedSuccessfully"),
    issueFailed: t("issueFailed"),
    reprintFailed: t("reprintFailed"),
  };
}

function DocumentToolbar({
  title,
  backLabel,
  backHref,
  editHref,
  editLabel,
  localeLinks,
  actions,
}: {
  title: string;
  backLabel: string;
  backHref?: string;
  editHref?: string;
  editLabel?: string;
  localeLinks?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref ?? "/appointments"}>
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {backLabel}
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {localeLinks}
        {editHref && <Button asChild variant="outline" size="sm"><Link href={editHref}>
          <Pencil data-icon="inline-start" />{editLabel}
        </Link></Button>}
        {actions}
      </div>
    </div>
  );
}

function DocumentHistory({
  document,
  t,
}: {
  document: NonNullable<Awaited<ReturnType<typeof getIssuedInvoiceDocument>>["data"]>;
  t: UiTranslator;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 print:hidden" aria-labelledby="document-history-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="document-history-title" className="font-semibold">{t("history")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("printCount", { count: document.printCount })}
        </p>
      </div>
      <ol className="mt-4 space-y-3">
        {document.events.map((event) => (
          <li key={event.id} className="flex flex-wrap justify-between gap-2 border-b pb-3 text-sm last:border-0 last:pb-0">
            <span className="font-medium">{eventLabel(event.event, t)}</span>
            <span className="text-muted-foreground">
              {event.actorName || t("systemActor")} · {formatDocDate(event.occurredAt, {
                locale: document.locale,
                timeZone: document.snapshot.format.timeZone,
                currency: document.snapshot.format.currency,
                timeFormat: document.snapshot.format.timeFormat,
              }, { dateStyle: "medium", timeStyle: "short" })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function eventLabel(event: string, t: UiTranslator): string {
  if (event === "issued") return t("events.issued");
  if (event === "reprinted") return t("events.reprinted");
  if (event === "printed") return t("events.printed");
  if (event === "voided") return t("events.voided");
  if (event === "cancelled") return t("events.cancelled");
  if (event === "delivered") return t("events.delivered");
  return t("events.updated");
}
