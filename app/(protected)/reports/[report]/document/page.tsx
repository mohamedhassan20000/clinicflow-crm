import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages, Pencil } from "lucide-react";
import {
  getIssuedAnalyticalDocument,
  previewAnalyticalReportDocument,
  type IssuedAnalyticalDocument,
} from "@/actions/documents";
import { AnalyticalDocumentActions } from "@/components/documents/analytical-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { DocumentPreviewFilters } from "@/components/documents/module/document-preview-filters";
import { AnalyticalReportDocument } from "@/components/documents/templates/analytical-reports";
import { Button } from "@/components/ui/button";
import { getAnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import { formatDocDate } from "@/lib/documents/format";
import type {
  AnalyticalDocumentParams,
  P74AnalyticalDocumentCode,
} from "@/lib/documents/resolvers/analytical-report";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import type { Locale } from "@/lib/i18n/config";
import {
  cleanFilter,
  parseFollowupOutcome,
  resolveReportsRange,
  type ReportsSearchParams,
} from "@/lib/reports/data";
import { getLocale, getTranslations } from "next-intl/server";

const REPORT_DOCUMENTS = {
  "follow-ups": "FOLLOW_UP_PAGE_REPORT",
  cancellations: "CANCELLATION_REPORT",
  "no-shows": "NO_SHOW_REPORT",
  sales: "SALES_REPORT",
  "follow-up-analytics": "FOLLOW_UP_ANALYTICS_REPORT",
  doctors: "DOCTOR_PERFORMANCE_REPORT",
  receptionists: "RECEPTIONIST_PERFORMANCE_REPORT",
} as const satisfies Record<string, P74AnalyticalDocumentCode>;

type ReportDocumentSlug = keyof typeof REPORT_DOCUMENTS;
type AnalyticalDocumentSearchParams = ReportsSearchParams & {
  locale?: string;
  documentId?: string;
  origin?: string;
  draftId?: string;
  q?: string;
  name?: string;
  file?: string;
  nat?: string;
  phone?: string;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("analyticalDocument") };
}

function isReportDocumentSlug(value: string): value is ReportDocumentSlug {
  return Object.hasOwn(REPORT_DOCUMENTS, value);
}

function backHref(slug: ReportDocumentSlug, origin?: string): string {
  if (slug === "follow-ups" && origin === "followups") return "/followups";
  return slug === "sales" || slug === "follow-up-analytics"
    ? "/reports"
    : `/reports/${slug}`;
}

function documentHref(slug: ReportDocumentSlug): string {
  return `/reports/${slug}/document`;
}

function previewHref(
  slug: ReportDocumentSlug,
  params: AnalyticalDocumentParams,
  locale: Locale,
  origin?: string,
  draftId?: string,
): string {
  const query = new URLSearchParams({
    preset: "custom",
    from: params.from,
    to: params.to,
    locale,
  });
  if (params.doctorId) query.set("doctor", params.doctorId);
  if (params.departmentId) query.set("department", params.departmentId);
  if (params.receptionistId) query.set("receptionist", params.receptionistId);
  if (params.outcome) query.set("outcome", params.outcome);
  if (params.patientQuery) query.set("q", params.patientQuery);
  if (params.patientName) query.set("name", params.patientName);
  if (params.patientFileNumber) query.set("file", params.patientFileNumber);
  if (params.patientNationalId) query.set("nat", params.patientNationalId);
  if (params.patientPhone) query.set("phone", params.patientPhone);
  if (origin) query.set("origin", origin);
  if (draftId) query.set("draftId", draftId);
  return `${documentHref(slug)}?${query.toString()}`;
}

export default async function AnalyticalDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<AnalyticalDocumentSearchParams>;
}) {
  const [{ report }, sp, defaultLocale, t] = await Promise.all([
    params,
    searchParams,
    getLocale() as Promise<Locale>,
    getTranslations("documentPlatform.ui"),
  ]);
  if (!isReportDocumentSlug(report)) notFound();
  const documentType = REPORT_DOCUMENTS[report];

  if (sp.documentId) {
    const issuedResult = await getIssuedAnalyticalDocument(sp.documentId, documentType);
    if (!issuedResult.data) notFound();
    const document = issuedResult.data;
    const [copy, qrDataUrl] = await Promise.all([
      getAnalyticalReportCopy(document.locale, documentType),
      document.snapshot.settings.qrEnabled
        ? generateDocumentVerificationQrDataUrl(document.verificationToken)
        : Promise.resolve(null),
    ]);
    const issuedParams: AnalyticalDocumentParams = {
      documentType,
      from: document.snapshot.range.from,
      to: document.snapshot.range.to,
      doctorId: document.snapshot.filters.doctorId,
      departmentId: document.snapshot.filters.departmentId,
      receptionistId: document.snapshot.filters.receptionistId,
      outcome: document.snapshot.filters.outcome,
      patientQuery: document.snapshot.filters.patientQuery,
      patientName: document.snapshot.filters.patientName,
      patientFileNumber: document.snapshot.filters.patientFileNumber,
      patientNationalId: document.snapshot.filters.patientNationalId,
      patientPhone: document.snapshot.filters.patientPhone,
    };
    return (
      <div className="flex flex-col gap-6">
        <DocumentToolbar
          title={t("issuedDocument", { name: copy.title })}
          backLabel={t("backToReport")}
          backHref={backHref(report)}
          actions={(
            <AnalyticalDocumentActions
              locale={document.locale}
              params={issuedParams}
              idempotencyKey={randomUUID()}
              documentId={document.id}
              labels={actionLabels(t)}
            />
          )}
        />
        <AnalyticalReportDocument
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

  const range = resolveReportsRange(sp);
  const fromModule = sp.origin === "documents";
  const previewOrigin = fromModule || sp.origin === "followups" ? sp.origin : undefined;
  const locale: Locale = sp.locale === "ar" || sp.locale === "en"
    ? sp.locale
    : defaultLocale;
  const previewParams: AnalyticalDocumentParams = {
    documentType,
    from: range.from,
    to: range.to,
    doctorId: cleanFilter(sp.doctor),
    departmentId: cleanFilter(sp.department),
    receptionistId: cleanFilter(sp.receptionist),
    outcome: parseFollowupOutcome(sp.outcome),
    patientQuery: cleanFilter(sp.q),
    patientName: cleanFilter(sp.name),
    patientFileNumber: cleanFilter(sp.file),
    patientNationalId: cleanFilter(sp.nat),
    patientPhone: cleanFilter(sp.phone),
  };
  const [previewResult, copy] = await Promise.all([
    previewAnalyticalReportDocument(previewParams),
    getAnalyticalReportCopy(locale, documentType),
  ]);
  if (!previewResult.data) {
    throw new Error("Analytical document preview could not be resolved");
  }

  return (
    <div className="flex flex-col gap-6">
      <DocumentToolbar
        title={t("draftDocument", { name: copy.title })}
        backLabel={fromModule ? t("backToDocuments") : t("backToReport")}
        backHref={fromModule ? "/documents" : backHref(report, previewOrigin)}
        editHref={fromModule ? `/documents/new/setup/${documentType}` : null}
        editLabel={t("edit")}
        localeLinks={(
          <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
            <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
            <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}>
              <Link href={previewHref(report, previewParams, "en", previewOrigin, sp.draftId)}>{t("english")}</Link>
            </Button>
            <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}>
              <Link href={previewHref(report, previewParams, "ar", previewOrigin, sp.draftId)}>{t("arabic")}</Link>
            </Button>
          </div>
        )}
        actions={(
          <AnalyticalDocumentActions
            locale={locale}
            params={previewParams}
            idempotencyKey={sp.draftId ?? randomUUID()}
            draftId={sp.draftId}
            labels={actionLabels(t)}
          />
        )}
      />
      <DocumentPreviewFilters
        code={documentType}
        locale={locale}
        fromModule={fromModule}
        extraParams={report === "follow-ups" ? {
          ...(previewOrigin ? { origin: previewOrigin } : {}),
          ...(previewParams.departmentId ? { department: previewParams.departmentId } : {}),
          ...(previewParams.outcome ? { outcome: previewParams.outcome } : {}),
          ...(previewParams.patientQuery ? { q: previewParams.patientQuery } : {}),
          ...(previewParams.patientName ? { name: previewParams.patientName } : {}),
          ...(previewParams.patientFileNumber ? { file: previewParams.patientFileNumber } : {}),
          ...(previewParams.patientNationalId ? { nat: previewParams.patientNationalId } : {}),
          ...(previewParams.patientPhone ? { phone: previewParams.patientPhone } : {}),
        } : undefined}
        draftId={sp.draftId}
        initial={{
          preset: range.preset,
          from: previewParams.from,
          to: previewParams.to,
          doctor: previewParams.doctorId ?? undefined,
          department: previewParams.departmentId ?? undefined,
          receptionist: previewParams.receptionistId ?? undefined,
        }}
      />
      <AnalyticalReportDocument
        locale={locale}
        lifecycle="preview"
        snapshot={previewResult.data}
        copy={copy}
      />
    </div>
  );
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
  backHref: href,
  editHref = null,
  editLabel,
  localeLinks,
  actions,
}: {
  title: string;
  backLabel: string;
  backHref: string;
  editHref?: string | null;
  editLabel?: string;
  localeLinks?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={href}>
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {backLabel}
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {localeLinks}
        {editHref && (
          <Button asChild variant="outline" size="sm">
            <Link href={editHref}>
              <Pencil data-icon="inline-start" />
              {editLabel}
            </Link>
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}

function DocumentHistory({
  document,
  t,
}: {
  document: IssuedAnalyticalDocument;
  t: UiTranslator;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 print:hidden" aria-labelledby="analytical-document-history-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="analytical-document-history-title" className="font-semibold">{t("history")}</h2>
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
  return t("events.updated");
}
