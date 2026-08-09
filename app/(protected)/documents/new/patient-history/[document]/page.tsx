import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { PatientHistorySetupForm } from "@/components/documents/module/patient-history-setup-form";
import { Button } from "@/components/ui/button";
import { canRoleAccessDocumentType } from "@/lib/documents/module";
import { loadPatientDocumentOptions } from "@/lib/documents/manual-authoring";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import type { P712PatientHistoryDocumentCode } from "@/lib/documents/resolvers/patient-history";
import type { Locale } from "@/lib/i18n/config";
import { requireUser } from "@/lib/rbac";
import { getClinicDocumentDraft } from "@/actions/document-drafts";

const DOCUMENTS = {
  "appointment-history": "APPOINTMENT_HISTORY_REPORT",
  "package-history": "PACKAGE_HISTORY_REPORT",
  "deposit-statement": "DEPOSIT_STATEMENT",
  "financial-summary": "PATIENT_FINANCIAL_SUMMARY",
} as const satisfies Record<string, P712PatientHistoryDocumentCode>;
type DocumentSlug = keyof typeof DOCUMENTS;
function isSlug(value: string): value is DocumentSlug { return Object.hasOwn(DOCUMENTS, value); }

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.patientHistory");
  return { title: t("title") };
}

export default async function NewPatientHistoryDocumentPage({ params, searchParams }: {
  params: Promise<{ document: string }>;
  searchParams: Promise<{ draftId?: string }>;
}) {
  const [{ document }, sp, user, locale, t, typeLabels] = await Promise.all([
    params, searchParams, requireUser(), getLocale() as Promise<Locale>,
    getTranslations("documents.module.patientHistory"), getDocumentTypeLabels(),
  ]);
  if (!isSlug(document)) notFound();
  const documentType = DOCUMENTS[document];
  if (!canRoleAccessDocumentType(user.role, documentType)) notFound();
  const patients = await loadPatientDocumentOptions(user);
  const draftResult = sp.draftId ? await getClinicDocumentDraft(sp.draftId) : null;
  const draft = draftResult?.data;
  if (sp.draftId && (!draft || draft.documentType !== documentType)) notFound();

  return <div className="flex flex-col gap-6"><div>
    <Button asChild variant="ghost" size="sm"><Link href="/documents/new">
      <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />{t("back")}
    </Link></Button>
    <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("prepare", { name: typeLabels[documentType] })}</h1>
    <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
  </div><PatientHistorySetupForm patients={patients} locale={draft?.locale ?? locale}
    documentType={documentType}
    draftId={draft?.id}
    initial={draft ? {
      patientId: typeof draft.params.patientId === "string" ? draft.params.patientId : undefined,
      preset: typeof draft.params.preset === "string" ? draft.params.preset : undefined,
      from: typeof draft.params.from === "string" ? draft.params.from : undefined,
      to: typeof draft.params.to === "string" ? draft.params.to : undefined,
    } : undefined}
    labels={{ patient: t("patient"), selectPatient: t("selectPatient"), period: t("period"),
      allTime: t("allTime"), lastWeek: t("lastWeek"), lastMonth: t("lastMonth"),
      lastYear: t("lastYear"), custom: t("custom"), from: t("from"), to: t("to"),
      saveDraft: t("saveDraft"), empty: t("empty") }} /></div>;
}
