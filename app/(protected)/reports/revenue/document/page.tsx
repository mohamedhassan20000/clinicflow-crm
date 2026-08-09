import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Languages } from "lucide-react";
import {
  getIssuedRevenueDocument,
  previewRevenueReportDocument,
} from "@/actions/documents";
import { RevenueDocumentActions } from "@/components/documents/revenue-document-actions";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import { DocumentPreviewFilters } from "@/components/documents/module/document-preview-filters";
import { RevenueReportDocument } from "@/components/documents/templates/revenue-report";
import { Button } from "@/components/ui/button";
import { formatDocDate } from "@/lib/documents/format";
import { getRevenueReportCopy } from "@/lib/documents/revenue-copy";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";
import { cleanFilter, resolveReportsRange, type ReportsSearchParams } from "@/lib/reports/data";
import type { Locale } from "@/lib/i18n/config";
import { getTranslations } from "next-intl/server";

type RevenueDocumentSearchParams = ReportsSearchParams & {
  locale?: string;
  documentId?: string;
  origin?: string;
  draftId?: string;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.ui");
  return { title: t("revenueDocument") };
}

function previewHref(
  params: Awaited<ReturnType<typeof resolvePageParams>>,
  locale: Locale,
): string {
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    locale,
  });
  if (params.doctorId) query.set("doctor", params.doctorId);
  if (params.departmentId) query.set("department", params.departmentId);
  if (params.sp.origin === "documents") query.set("origin", "documents");
  if (params.sp.draftId) query.set("draftId", params.sp.draftId);
  return `/reports/revenue/document?${query.toString()}`;
}

async function resolvePageParams(searchParams: Promise<RevenueDocumentSearchParams>) {
  const sp = await searchParams;
  const range = resolveReportsRange(sp);
  return {
    sp,
    from: range.from,
    to: range.to,
    doctorId: cleanFilter(sp.doctor),
    departmentId: cleanFilter(sp.department),
  };
}

export default async function RevenueDocumentPage({
  searchParams,
}: {
  searchParams: Promise<RevenueDocumentSearchParams>;
}) {
  const resolved = await resolvePageParams(searchParams);
  const [t, issuedResult] = await Promise.all([
    getTranslations("documentPlatform.ui"),
    resolved.sp.documentId
      ? getIssuedRevenueDocument(resolved.sp.documentId)
      : Promise.resolve(null),
  ]);

  if (resolved.sp.documentId) {
    if (!issuedResult?.data) notFound();
    const document = issuedResult.data;
    const [copy, qrDataUrl] = await Promise.all([
      getRevenueReportCopy(document.locale),
      document.snapshot.settings.qrEnabled
        ? generateDocumentVerificationQrDataUrl(document.verificationToken)
        : Promise.resolve(null),
    ]);
    return (
      <div className="flex flex-col gap-6">
        <DocumentToolbar
          title={t("issuedRevenueDocument")}
          backLabel={t("backToRevenue")}
          actions={(
            <RevenueDocumentActions
              locale={document.locale}
              params={{
                from: document.snapshot.range.from,
                to: document.snapshot.range.to,
                doctorId: document.snapshot.filters.doctorId,
                departmentId: document.snapshot.filters.departmentId,
              }}
              idempotencyKey={randomUUID()}
              documentId={document.id}
              labels={actionLabels(t)}
            />
          )}
        />
        <RevenueReportDocument
          locale={document.locale}
          lifecycle={documentPresentationLifecycle(document.status)}
          snapshot={document.snapshot}
          copy={copy}
          documentNumber={document.documentNumber}
          qrDataUrl={qrDataUrl}
          pageCount={document.pageCount}
        />
        <DocumentHistory document={document} t={t} />
      </div>
    );
  }

  const locale: Locale = resolved.sp.locale === "ar" ? "ar" : "en";
  const params = {
    from: resolved.from,
    to: resolved.to,
    doctorId: resolved.doctorId,
    departmentId: resolved.departmentId,
  };
  const [previewResult, copy] = await Promise.all([
    previewRevenueReportDocument(params),
    getRevenueReportCopy(locale),
  ]);
  if (!previewResult.data) throw new Error("Revenue document preview could not be resolved");

  return (
    <div className="flex flex-col gap-6">
      <DocumentToolbar
        title={t("draftRevenueDocument")}
        backLabel={t("backToRevenue")}
        localeLinks={(
          <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
            <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
            <Button asChild size="sm" variant={locale === "en" ? "secondary" : "ghost"}>
              <Link href={previewHref(resolved, "en")}>{t("english")}</Link>
            </Button>
            <Button asChild size="sm" variant={locale === "ar" ? "secondary" : "ghost"}>
              <Link href={previewHref(resolved, "ar")}>{t("arabic")}</Link>
            </Button>
          </div>
        )}
        actions={(
          <RevenueDocumentActions
            locale={locale}
            params={params}
            idempotencyKey={resolved.sp.draftId ?? randomUUID()}
            draftId={resolved.sp.draftId}
            labels={actionLabels(t)}
          />
        )}
      />
      <DocumentPreviewFilters
        code="REVENUE_REPORT"
        locale={locale}
        fromModule={resolved.sp.origin === "documents"}
        draftId={resolved.sp.draftId}
        initial={{
          preset: "custom",
          from: resolved.from,
          to: resolved.to,
          doctor: resolved.doctorId ?? undefined,
          department: resolved.departmentId ?? undefined,
        }}
      />
      <RevenueReportDocument
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
  localeLinks,
  actions,
}: {
  title: string;
  backLabel: string;
  localeLinks?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/reports/revenue">
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {backLabel}
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {localeLinks}
        {actions}
      </div>
    </div>
  );
}

function DocumentHistory({
  document,
  t,
}: {
  document: NonNullable<Awaited<ReturnType<typeof getIssuedRevenueDocument>>["data"]>;
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
  return t("events.updated");
}
