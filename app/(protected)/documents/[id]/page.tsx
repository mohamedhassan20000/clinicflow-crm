import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { getClinicDocumentDetail } from "@/actions/documents-module";
import { DocumentDetailActions } from "@/components/documents/module/document-detail-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const tm = await getTranslations("documents.module");
  return { title: tm("title") };
}

function statusVariant(status: "not_issued" | "issued" | "cancelled") {
  if (status === "issued") return "default" as const;
  if (status === "cancelled") return "destructive" as const;
  return "secondary" as const;
}

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("documents.module.detail");
  const [{ id }, locale, typeLabels] = await Promise.all([
    params,
    getLocale() as Promise<Locale>,
    getDocumentTypeLabels(),
  ]);

  const result = await getClinicDocumentDetail(id);
  if (!result.data) notFound();
  const document = result.data;

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  });

  const statusLabel = {
    not_issued: t("statusNotIssued"),
    issued: t("statusIssued"),
    cancelled: t("statusCancelled"),
  }[document.status];

  const eventLabel = (event: string) => {
    if (event === "issued") return t("eventIssued");
    if (event === "reprinted") return t("eventReprinted");
    if (event === "printed") return t("eventPrinted");
    if (event === "voided") return t("eventVoided");
    if (event === "cancelled") return t("eventCancelled");
    return t("eventUpdated");
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/documents">
              <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
              {t("back")}
            </Link>
          </Button>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight tabular-nums">
              {document.documentNumber}
            </h1>
            <Badge variant={statusVariant(document.status)}>{statusLabel}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {typeLabels[document.docType]}
          </p>
        </div>
        <DocumentDetailActions
          documentId={document.id}
          renderedHref={document.renderedHref}
          verificationToken={document.verificationToken}
          status={document.status}
        />
      </div>

      <section className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("type")} value={typeLabels[document.docType]} />
        <Field label={t("subject")} value={document.subjectName ?? "—"} />
        <Field label={t("issuedBy")} value={document.issuedByName ?? "—"} />
        <Field
          label={t("issuedAt")}
          value={dateFormatter.format(new Date(document.issuedAt))}
        />
        <Field label={t("printCount")} value={String(document.printCount)} />
        <Field label={t("pageCount")} value={String(document.pageCount)} />
      </section>

      <section className="rounded-xl border bg-card p-5 print:hidden">
        <h2 className="font-semibold">{t("history")}</h2>
        <ol className="mt-4 space-y-3">
          {document.events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap justify-between gap-2 border-s py-1 ps-4 text-sm"
            >
              <span>
                {eventLabel(event.event)}
                <span className="ms-2 text-muted-foreground">
                  {event.actorName || t("systemActor")}
                </span>
              </span>
              <time className="text-muted-foreground">
                {dateFormatter.format(new Date(event.occurredAt))}
              </time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}
