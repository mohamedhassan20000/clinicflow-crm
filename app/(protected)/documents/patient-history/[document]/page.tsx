import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages, Pencil } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  getIssuedPatientHistoryDocument,
  previewPatientHistoryDocument,
  type IssuedPatientHistoryDocument,
} from "@/actions/documents";
import { PatientHistoryDocumentActions } from "@/components/documents/patient-history-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { PatientHistoryDocument } from "@/components/documents/templates/patient-history-documents";
import { Button } from "@/components/ui/button";
import { formatDocDate } from "@/lib/documents/format";
import { getPatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import type {
  P712PatientHistoryDocumentCode,
  PatientHistoryDocumentParams,
} from "@/lib/documents/resolvers/patient-history";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import type { Locale } from "@/lib/i18n/config";

const DOCUMENTS = {
  "appointment-history": "APPOINTMENT_HISTORY_REPORT",
  "package-history": "PACKAGE_HISTORY_REPORT",
  "deposit-statement": "DEPOSIT_STATEMENT",
  "financial-summary": "PATIENT_FINANCIAL_SUMMARY",
} as const satisfies Record<string, P712PatientHistoryDocumentCode>;
type DocumentSlug = keyof typeof DOCUMENTS;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("patientHistoryDocument") };
}

function isSlug(value: string): value is DocumentSlug {
  return Object.hasOwn(DOCUMENTS, value);
}
function baseHref(slug: DocumentSlug) {
  return `/documents/patient-history/${slug}`;
}
function backHref(params: PatientHistoryDocumentParams) {
  return `/patients/${params.patientId}`;
}
function previewHref(slug: DocumentSlug, params: PatientHistoryDocumentParams, locale: Locale, origin?: string, draftId?: string) {
  const query = new URLSearchParams({ locale, patientId: params.patientId });
  if (origin === "documents") query.set("origin", "documents");
  if (draftId) query.set("draftId", draftId);
  if (params.preset) query.set("preset", params.preset);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  return `${baseHref(slug)}?${query}`;
}

export default async function PatientHistoryDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ document: string }>;
  searchParams: Promise<{
    locale?: string;
    documentId?: string;
    patientId?: string;
    preset?: string;
    from?: string;
    to?: string;
    origin?: string;
    draftId?: string;
  }>;
}) {
  const [{ document: slugValue }, sp, defaultLocale, t] = await Promise.all([
    params,
    searchParams,
    getLocale() as Promise<Locale>,
    getTranslations("documentPlatform.ui"),
  ]);
  if (!isSlug(slugValue)) notFound();
  const documentType = DOCUMENTS[slugValue];

  if (sp.documentId) {
    const result = await getIssuedPatientHistoryDocument(sp.documentId, documentType);
    if (!result.data) notFound();
    const issued = result.data;
    const copy = getPatientHistoryCopy(issued.locale, documentType);
    const qrDataUrl = issued.snapshot.settings.qrEnabled
      ? await generateDocumentVerificationQrDataUrl(issued.verificationToken)
      : null;
    const issuedParams: PatientHistoryDocumentParams = {
      documentType,
      // Snapshot identity is the source of truth for reprint; the patient id is
      // not disclosed in the snapshot, so navigation falls back to the module.
      patientId: "00000000-0000-0000-0000-000000000000",
      preset: issued.snapshot.range.preset as PatientHistoryDocumentParams["preset"],
      from: issued.snapshot.range.from,
      to: issued.snapshot.range.to,
    };
    return (
      <div className="flex flex-col gap-6">
        <Toolbar
          title={t("issuedDocument", { name: copy.title })}
          backHref="/documents"
          backLabel={t("backToSource")}
          actions={
            <PatientHistoryDocumentActions
              locale={issued.locale}
              params={issuedParams}
              idempotencyKey={randomUUID()}
              documentId={issued.id}
              labels={actionLabels(t)}
            />
          }
        />
        <PatientHistoryDocument
          locale={issued.locale}
          lifecycle={documentPresentationLifecycle(issued.status)}
          snapshot={issued.snapshot}
          copy={copy}
          documentNumber={issued.documentNumber}
          qrDataUrl={qrDataUrl}
        />
        <History document={issued} t={t} />
      </div>
    );
  }

  if (!sp.patientId) notFound();
  const locale = sp.locale === "ar" || sp.locale === "en" ? sp.locale : defaultLocale;
  const previewParams: PatientHistoryDocumentParams = {
    documentType,
    patientId: sp.patientId,
    preset: (sp.preset as PatientHistoryDocumentParams["preset"]) ?? null,
    from: sp.from ?? null,
    to: sp.to ?? null,
  };
  const preview = await previewPatientHistoryDocument(previewParams);
  if (!preview.data) notFound();
  const copy = getPatientHistoryCopy(locale, documentType);
  return (
    <div className="flex flex-col gap-6">
      <Toolbar
        title={t("draftDocument", { name: copy.title })}
        backHref={sp.origin === "documents" ? "/documents" : backHref(previewParams)}
        backLabel={sp.origin === "documents" ? t("backToDocuments") : t("backToSource")}
        editHref={sp.origin === "documents" ? `/documents/new/patient-history/${slugValue}${sp.draftId ? `?draftId=${encodeURIComponent(sp.draftId)}` /* i18n-allow: URL query syntax, not user-facing copy */ : ""}` : undefined}
        editLabel={t("edit")}
        localeLinks={
          <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
            <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
            <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}>
              <Link href={previewHref(slugValue, previewParams, "en", sp.origin, sp.draftId)}>{t("english")}</Link>
            </Button>
            <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}>
              <Link href={previewHref(slugValue, previewParams, "ar", sp.origin, sp.draftId)}>{t("arabic")}</Link>
            </Button>
          </div>
        }
        actions={
          <PatientHistoryDocumentActions
            locale={locale}
            params={previewParams}
            idempotencyKey={sp.draftId ?? randomUUID()}
            draftId={sp.draftId}
            labels={actionLabels(t)}
          />
        }
      />
      <PatientHistoryDocument
        locale={locale}
        lifecycle="preview"
        snapshot={preview.data}
        copy={copy}
      />
    </div>
  );
}

type Translator = Awaited<ReturnType<typeof getTranslations<"documentPlatform.ui">>>;
function actionLabels(t: Translator) {
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
function Toolbar({
  title,
  backHref: href,
  backLabel,
  editHref,
  editLabel,
  localeLinks,
  actions,
}: {
  title: string;
  backHref: string;
  backLabel: string;
  editHref?: string;
  editLabel?: string;
  localeLinks?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={href}>
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {backLabel}
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {localeLinks}
        {editHref && <Button asChild variant="outline" size="sm"><Link href={editHref}>
          <Pencil data-icon="inline-start" />{editLabel}
        </Link></Button>}
        {actions}
      </div>
    </div>
  );
}
function History({ document, t }: { document: IssuedPatientHistoryDocument; t: Translator }) {
  return (
    <section className="rounded-xl border bg-card p-5 print:hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("history")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("printCount", { count: document.printCount })}
        </p>
      </div>
      <ol className="mt-4 space-y-3">
        {document.events.map((event) => (
          <li
            key={event.id}
            className="flex flex-wrap justify-between gap-2 border-s py-1 ps-4 text-sm"
          >
            <span>
              {eventLabel(event.event, t)}
              <span className="ms-2 text-muted-foreground">
                {event.actorName || t("systemActor")}
              </span>
            </span>
            <time className="text-muted-foreground">
              {formatDocDate(
                event.occurredAt,
                { locale: document.locale, timeZone: document.snapshot.format.timeZone },
                { dateStyle: "medium", timeStyle: "short" },
              )}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}
function eventLabel(event: string, t: Translator) {
  if (event === "issued") return t("events.issued");
  if (event === "reprinted") return t("events.reprinted");
  if (event === "printed") return t("events.printed");
  if (event === "voided") return t("events.voided");
  if (event === "cancelled") return t("events.cancelled");
  return t("events.updated");
}
