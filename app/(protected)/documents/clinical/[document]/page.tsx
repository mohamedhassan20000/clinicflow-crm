import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages, Pencil } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { getIssuedClinicalDocument, previewClinicalDocument, type IssuedClinicalDocument } from "@/actions/clinical-documents";
import { ClinicalDocumentActions } from "@/components/documents/clinical-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { ClinicalDocument } from "@/components/documents/templates/clinical-documents";
import { Button } from "@/components/ui/button";
import { getClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import { formatDocDate } from "@/lib/documents/format";
import type { ClinicalDocumentParams, P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import type { Locale } from "@/lib/i18n/config";

const DOCUMENTS = { prescription: "PRESCRIPTION", "lab-request": "LAB_REQUEST",
  "sick-leave": "SICK_LEAVE_CERTIFICATE" } as const satisfies Record<string, P76ClinicalDocumentCode>;
type Slug = keyof typeof DOCUMENTS;
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui"); return { title: t("clinicalDocument") };
}
function isSlug(value: string): value is Slug { return Object.hasOwn(DOCUMENTS, value); }
function href(slug: Slug) { return `/documents/clinical/${slug}`; }
function previewHref(slug: Slug, recordId: string, locale: Locale, draftId?: string) {
  const query = new URLSearchParams({ recordId, locale, origin: "documents" });
  if (draftId) query.set("draftId", draftId);
  return `${href(slug)}?${query}`;
}

export default async function ClinicalDocumentPage({ params, searchParams }: {
  params: Promise<{ document: string }>;
  searchParams: Promise<{ locale?: string; recordId?: string; documentId?: string; draftId?: string }>;
}) {
  const [{ document: slugValue }, sp, defaultLocale, t] = await Promise.all([
    params, searchParams, getLocale() as Promise<Locale>, getTranslations("documentPlatform.ui"),
  ]);
  if (!isSlug(slugValue)) notFound();
  const documentType = DOCUMENTS[slugValue];
  if (sp.documentId) {
    const result = await getIssuedClinicalDocument(sp.documentId, documentType);
    if (!result.data) notFound();
    const issued = result.data; const copy = getClinicalDocumentCopy(issued.locale, documentType);
    const qr = await generateDocumentVerificationQrDataUrl(issued.verificationToken);
    const actionParams = { documentType, recordId: issued.snapshot.sourceRecordId };
    return <div className="flex flex-col gap-6"><Toolbar title={t("issuedDocument", { name: copy.title })}
      backLabel={t("backToDocuments")} backHref="/documents"
      actions={<ClinicalDocumentActions locale={issued.locale} params={actionParams}
        documentId={issued.id} labels={actionLabels(t)} />} />
      <ClinicalDocument locale={issued.locale} lifecycle={documentPresentationLifecycle(issued.status)} snapshot={issued.snapshot} copy={copy}
        documentNumber={issued.documentNumber} qrDataUrl={qr} /><History document={issued} t={t} /></div>;
  }
  if (!sp.recordId) notFound();
  const locale = sp.locale === "ar" || sp.locale === "en" ? sp.locale : defaultLocale;
  const actionParams: ClinicalDocumentParams = { documentType, recordId: sp.recordId };
  const preview = await previewClinicalDocument(actionParams);
  if (!preview.data) notFound();
  const copy = getClinicalDocumentCopy(locale, documentType);
  return <div className="flex flex-col gap-6"><Toolbar title={t("draftDocument", { name: copy.title })}
    backLabel={t("backToDocuments")} backHref="/documents"
    editHref={`/documents/new/clinical/${slugValue}${sp.draftId ? `?draftId=${encodeURIComponent(sp.draftId)}` /* i18n-allow: URL query syntax, not user-facing copy */ : ""}`} editLabel={t("edit")}
    localeLinks={<div className="flex items-center gap-1 rounded-lg border bg-background p-1">
      <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
      <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}><Link href={previewHref(slugValue, sp.recordId, "en", sp.draftId)}>{t("english")}</Link></Button>
      <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}><Link href={previewHref(slugValue, sp.recordId, "ar", sp.draftId)}>{t("arabic")}</Link></Button>
    </div>} actions={<ClinicalDocumentActions locale={locale} params={actionParams}
      draftId={sp.draftId} labels={actionLabels(t)} />} />
    <ClinicalDocument locale={locale} lifecycle="preview" snapshot={preview.data} copy={copy} /></div>;
}

type Translator = Awaited<ReturnType<typeof getTranslations<"documentPlatform.ui">>>;
function actionLabels(t: Translator) { return { issue: t("issue"), issuing: t("issuing"),
  printDraft: t("printDraft"), reprint: t("reprintCanonicalPdf"), preparing: t("preparingPdf"),
  issued: t("issuedSuccessfully"), issueFailed: t("issueFailed"), reprintFailed: t("reprintFailed"),
  controlled: t("controlledMedicineBlocked") }; }
function Toolbar({ title, backLabel, backHref = "/documents", editHref = null, editLabel, localeLinks, actions }: {
  title: string; backLabel: string; backHref?: string; editHref?: string | null; editLabel?: string;
  localeLinks?: React.ReactNode; actions: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3 print:hidden"><div>
    <Button asChild variant="ghost" size="sm"><Link href={backHref}><ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />{backLabel}</Link></Button>
    <h1 className="mt-2 text-xl font-semibold">{title}</h1></div><div className="flex flex-wrap items-start gap-2">{localeLinks}
    {editHref && <Button asChild variant="outline" size="sm"><Link href={editHref}><Pencil data-icon="inline-start" />{editLabel}</Link></Button>}
    {actions}</div></div>;
}
function History({ document, t }: { document: IssuedClinicalDocument; t: Translator }) {
  return <section className="rounded-xl border bg-card p-5 print:hidden"><div className="flex flex-wrap items-baseline justify-between gap-2">
    <h2 className="font-semibold">{t("history")}</h2><p className="text-sm text-muted-foreground">{t("printCount", { count: document.printCount })}</p></div>
    <ol className="mt-4 space-y-3">{document.events.map((event) => <li key={event.id} className="flex flex-wrap justify-between gap-2 border-s py-1 ps-4 text-sm">
      <span>{event.event === "issued" ? t("events.issued") : event.event === "reprinted" ? t("events.reprinted") : t("events.updated")}
        <span className="ms-2 text-muted-foreground">{event.actorName || t("systemActor")}</span></span>
      <time className="text-muted-foreground">{formatDocDate(event.occurredAt, { locale: document.locale,
        timeZone: document.snapshot.format.timeZone }, { dateStyle: "medium", timeStyle: "short" })}</time></li>)}</ol></section>;
}
