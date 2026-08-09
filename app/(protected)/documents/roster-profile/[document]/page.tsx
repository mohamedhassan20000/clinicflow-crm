import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages, Pencil } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  getIssuedRosterProfileDocument, getRosterProfileAttachmentOptions,
  previewRosterProfileDocument, type IssuedRosterProfileDocument,
} from "@/actions/documents";
import { DocumentPreviewFilters } from "@/components/documents/module/document-preview-filters";
import { documentSetupFields } from "@/lib/documents/module";
import { RosterProfileDocumentActions } from "@/components/documents/roster-profile-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { RosterProfileDocument } from "@/components/documents/templates/roster-profile-documents";
import { Button } from "@/components/ui/button";
import { formatDocDate } from "@/lib/documents/format";
import { getRosterProfileCopy } from "@/lib/documents/roster-profile-copy";
import type { P75RosterProfileDocumentCode, RosterProfileDocumentParams } from "@/lib/documents/resolvers/roster-profile";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import type { Locale } from "@/lib/i18n/config";

const DOCUMENTS = {
  "patient-list": "PATIENT_LIST_REPORT",
  "patient-file": "PATIENT_FILE",
  "system-members": "SYSTEM_MEMBERS_REPORT",
  "staff-file": "STAFF_FILE",
} as const satisfies Record<string, P75RosterProfileDocumentCode>;
type DocumentSlug = keyof typeof DOCUMENTS;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("rosterProfileDocument") };
}

function isSlug(value: string): value is DocumentSlug { return Object.hasOwn(DOCUMENTS, value); }
function baseHref(slug: DocumentSlug) { return `/documents/roster-profile/${slug}`; }
function backHref(slug: DocumentSlug, params: RosterProfileDocumentParams) {
  if (slug === "patient-file" && params.patientId) return `/patients/${params.patientId}`;
  return slug === "patient-list" ? "/patients" : "/settings/staff";
}
function previewHref(slug: DocumentSlug, params: RosterProfileDocumentParams, locale: Locale, fromModule = false, draftId?: string) {
  const query = new URLSearchParams({ locale });
  if (params.patientId) query.set("patientId", params.patientId);
  if (params.staffId) query.set("staffId", params.staffId);
  if (params.departmentId) query.set("department", params.departmentId);
  if (params.doctorId) query.set("doctor", params.doctorId);
  if (params.role) query.set("role", params.role);
  if (params.search) query.set("q", params.search);
  if (fromModule) query.set("origin", "documents");
  if (draftId) query.set("draftId", draftId);
  return `${baseHref(slug)}?${query}`;
}

export default async function RosterProfileDocumentPage({ params, searchParams }: {
  params: Promise<{ document: string }>;
  searchParams: Promise<{ locale?: string; documentId?: string; patientId?: string; staffId?: string;
    department?: string; doctor?: string; role?: RosterProfileDocumentParams["role"]; q?: string; origin?: string; draftId?: string }>;
}) {
  const [{ document: slugValue }, sp, defaultLocale, t] = await Promise.all([
    params, searchParams, getLocale() as Promise<Locale>, getTranslations("documentPlatform.ui"),
  ]);
  if (!isSlug(slugValue)) notFound();
  const documentType = DOCUMENTS[slugValue];

  if (sp.documentId) {
    const result = await getIssuedRosterProfileDocument(sp.documentId, documentType);
    if (!result.data) notFound();
    const issued = result.data;
    const copy = getRosterProfileCopy(issued.locale, documentType);
    const qrDataUrl = issued.snapshot.settings.qrEnabled
      ? await generateDocumentVerificationQrDataUrl(issued.verificationToken) : null;
    const issuedParams: RosterProfileDocumentParams = { documentType, ...issued.snapshot.filters,
      role: issued.snapshot.filters.role as RosterProfileDocumentParams["role"] };
    return <div className="flex flex-col gap-6">
      <Toolbar title={t("issuedDocument", { name: copy.title })} backHref={backHref(slugValue, issuedParams)}
        backLabel={t("backToSource")} actions={<RosterProfileDocumentActions locale={issued.locale}
          params={issuedParams} idempotencyKey={randomUUID()} documentId={issued.id}
          labels={actionLabels(t)} />} />
      <RosterProfileDocument locale={issued.locale} lifecycle={documentPresentationLifecycle(issued.status)} snapshot={issued.snapshot}
        copy={copy} documentNumber={issued.documentNumber} qrDataUrl={qrDataUrl} />
      <History document={issued} t={t} />
    </div>;
  }

  const locale = sp.locale === "ar" || sp.locale === "en" ? sp.locale : defaultLocale;
  const previewParams: RosterProfileDocumentParams = {
    documentType, patientId: sp.patientId || null, staffId: sp.staffId || null,
    departmentId: sp.department || null, doctorId: sp.doctor || null, role: sp.role || null,
    search: sp.q?.trim() || null,
  };
  const [preview, attachmentResult] = await Promise.all([
    previewRosterProfileDocument(previewParams),
    documentType === "PATIENT_FILE" || documentType === "STAFF_FILE"
      ? getRosterProfileAttachmentOptions(previewParams) : Promise.resolve({ data: [] }),
  ]);
  if (!preview.data) notFound();
  const copy = getRosterProfileCopy(locale, documentType);
  const fromModule = sp.origin === "documents";
  const hasSetup = documentSetupFields(documentType).length > 0;
  return <div className="flex flex-col gap-6">
    <Toolbar title={t("draftDocument", { name: copy.title })}
      backHref={fromModule ? "/documents" : backHref(slugValue, previewParams)}
      backLabel={fromModule ? t("backToDocuments") : t("backToSource")}
      editHref={fromModule && hasSetup ? `/documents/new/setup/${documentType}` : null}
      editLabel={t("edit")}
      localeLinks={<div className="flex items-center gap-1 rounded-lg border bg-background p-1">
        <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
        <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}>
          <Link href={previewHref(slugValue, previewParams, "en", fromModule, sp.draftId)}>{t("english")}</Link>
        </Button>
        <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}>
          <Link href={previewHref(slugValue, previewParams, "ar", fromModule, sp.draftId)}>{t("arabic")}</Link>
        </Button>
      </div>}
      actions={<RosterProfileDocumentActions locale={locale} params={previewParams}
        idempotencyKey={sp.draftId ?? randomUUID()}
        draftId={sp.draftId}
        attachments={attachmentResult.data ?? []} labels={actionLabels(t)} />} />
    {hasSetup && (
      <DocumentPreviewFilters code={documentType} locale={locale} fromModule={fromModule}
        draftId={sp.draftId}
        initial={{ doctor: previewParams.doctorId ?? undefined,
          department: previewParams.departmentId ?? undefined, q: previewParams.search ?? undefined }} />
    )}
    <RosterProfileDocument locale={locale} lifecycle="preview" snapshot={preview.data} copy={copy} />
  </div>;
}

type Translator = Awaited<ReturnType<typeof getTranslations<"documentPlatform.ui">>>;
function actionLabels(t: Translator) { return {
  issue: t("issue"), issuing: t("issuing"), printDraft: t("printDraft"),
  reprint: t("reprintCanonicalPdf"), preparing: t("preparingPdf"), issued: t("issuedSuccessfully"),
  issueFailed: t("issueFailed"), reprintFailed: t("reprintFailed"),
  includeAttachments: t("includeAttachments"), attachmentLimit: t("attachmentLimit"),
  megabytesShort: t("megabytesShort"),
}; }
function Toolbar({ title, backHref: href, backLabel, editHref = null, editLabel, localeLinks, actions }: {
  title: string; backHref: string; backLabel: string; editHref?: string | null; editLabel?: string;
  localeLinks?: React.ReactNode; actions: React.ReactNode;
}) { return <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
  <div><Button asChild variant="ghost" size="sm"><Link href={href}>
    <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />{backLabel}
  </Link></Button><h1 className="mt-2 text-xl font-semibold">{title}</h1></div>
  <div className="flex flex-wrap items-start gap-2">{localeLinks}
    {editHref && <Button asChild variant="outline" size="sm"><Link href={editHref}>
      <Pencil data-icon="inline-start" />{editLabel}</Link></Button>}
    {actions}</div>
  </div>; }
function History({ document, t }: { document: IssuedRosterProfileDocument; t: Translator }) {
  return <section className="rounded-xl border bg-card p-5 print:hidden">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-semibold">{t("history")}</h2><p className="text-sm text-muted-foreground">
        {t("printCount", { count: document.printCount })}</p>
    </div>
    <ol className="mt-4 space-y-3">{document.events.map((event) => <li key={event.id}
      className="flex flex-wrap justify-between gap-2 border-s py-1 ps-4 text-sm">
      <span>{eventLabel(event.event, t)}
        <span className="ms-2 text-muted-foreground">{event.actorName || t("systemActor")}</span></span>
      <time className="text-muted-foreground">{formatDocDate(event.occurredAt, {
        locale: document.locale, timeZone: document.snapshot.format.timeZone,
      }, { dateStyle: "medium", timeStyle: "short" })}</time>
    </li>)}</ol>
  </section>;
}
function eventLabel(event: string, t: Translator) {
  if (event === "issued") return t("events.issued");
  if (event === "reprinted") return t("events.reprinted");
  if (event === "printed") return t("events.printed");
  if (event === "voided") return t("events.voided");
  if (event === "cancelled") return t("events.cancelled");
  return t("events.updated");
}
