import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { InvoiceAuthoringForm } from "@/components/documents/module/invoice-authoring-form";
import { Button } from "@/components/ui/button";
import { canRoleAccessDocumentType } from "@/lib/documents/module";
import { loadInvoiceAuthoringOptions } from "@/lib/documents/manual-authoring";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import type { Locale } from "@/lib/i18n/config";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getClinicDocumentDraft } from "@/actions/document-drafts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.invoice");
  return { title: t("title") };
}

export default async function NewInvoicePage({ searchParams }: {
  searchParams: Promise<{ draftId?: string }>;
}) {
  const sp = await searchParams;
  const [user, locale, t, typeLabels] = await Promise.all([
    requireUser(),
    getLocale() as Promise<Locale>,
    getTranslations("documents.module.invoice"),
    getDocumentTypeLabels(),
  ]);
  if (!canRoleAccessDocumentType(user.role, "INVOICE")) notFound();
  const supabase = await createClient();
  const [options, clinicResult] = await Promise.all([
    loadInvoiceAuthoringOptions(user),
    supabase.from("clinics").select("currency, timezone").eq("id", user.clinicId).single(),
  ]);
  if (clinicResult.error || !clinicResult.data) throw new Error(clinicResult.error?.message ?? "Clinic not found");
  const draftResult = sp.draftId ? await getClinicDocumentDraft(sp.draftId) : null;
  const draft = draftResult?.data;
  if (sp.draftId && (!draft || draft.documentType !== "INVOICE")) notFound();

  return <div className="flex flex-col gap-6"><div>
    <Button asChild variant="ghost" size="sm"><Link href="/documents/new">
      <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />{t("back")}
    </Link></Button>
    <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("prepare", { name: typeLabels.INVOICE })}</h1>
    <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
  </div><InvoiceAuthoringForm options={options} locale={draft?.locale ?? locale}
    currency={clinicResult.data.currency} timeZone={clinicResult.data.timezone}
    draftId={draft?.id}
    initialAppointmentId={typeof draft?.params.appointmentId === "string" ? draft.params.appointmentId : undefined}
    labels={{ patient: t("patient"), appointment: t("appointment"), selectPatient: t("selectPatient"),
      selectAppointment: t("selectAppointment"), services: t("services"), service: t("service"),
      unitPrice: t("unitPrice"), quantity: t("quantity"), lineTotal: t("lineTotal"),
      total: t("total"), empty: t("empty"), saveDraft: t("saveDraft") }} /></div>;
}
