import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { clinicLocaleFromRow, formatClinicDate } from "@/lib/datetime";
import { getServerMoneyFormatter } from "@/lib/currency/server";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PrintHeader } from "@/components/shared/print-header";
import { PatientReportHeader } from "@/components/patients/patient-report-header";
import { HistoryDateFilter } from "@/components/patients/file/history-date-filter";
import { PatientDepositsSection } from "@/components/patients/file/patient-deposits-section";
import { buildDocumentQuery, loadPatientDeposits, resolveHistoryRange } from "@/lib/patients/file-data";
import { resolveReturnTo } from "@/lib/navigation/return-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("patients");
  return { title: t("deposits") };
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
    returnTo?: string;
  }>;
}

export default async function PatientDepositsPage({
  params,
  searchParams,
}: PageProps) {
  const t = await getTranslations("patients");
  const { id } = await params;
  const { preset, from, to, returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientHref = resolveReturnTo(returnTo, patientPath, [patientPath]);

  const user = await requireUser();
  // Deposits are financial — scoped clinical roles (doctor/assistant) never see them.
  if (user.role === "doctor" || user.role === "assistant") notFound();
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select("id, full_name, file_number, phone, is_deleted")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  const range = resolveHistoryRange({ preset, from, to });
  const [{ state, transactions }, { data: clinic }] = await Promise.all([
    loadPatientDeposits(supabase, {
      clinicId: user.clinicId,
      patientId: id,
      from: range.from,
      to: range.to,
    }),
    supabase
      .from("clinics")
      .select("name, address, phone, logo_url, timezone, locale, digits, time_format")
      .eq("id", user.clinicId)
      .single(),
  ]);

  const clinicLocale = clinicLocaleFromRow(clinic);
  const fmtMoney = await getServerMoneyFormatter(user.id, clinicLocale);
  const generatedAt = formatClinicDate(new Date(), clinicLocale, {
    dateStyle: "long",
    timeStyle: "short",
  });
  const canManage =
    (user.role === "admin" || user.role === "receptionist") && !patient.is_deleted;
  const filtered = range.preset !== "all";

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName={t("deposits")}
        generatedAt={generatedAt}
      />
      <PatientReportHeader
        patientHref={patientHref}
        patientName={patient.full_name}
        fileNumber={patient.file_number}
        phone={patient.phone}
        title={t("deposits")}
        countLabel={`${t("depositTransactionCount", { count: transactions.length })}${
          filtered ? ` · ${t("filtered")}` : ""
        }`}
        documentHref={`/documents/patient-history/deposit-statement?${buildDocumentQuery(id, range)}`}
        showPrint={false}
      />

      <HistoryDateFilter preset={range.preset} from={range.from} to={range.to} />

      <PatientDepositsSection
        t={t}
        patientId={id}
        patientName={patient.full_name}
        accountBalance={state.accountBalance}
        transactions={transactions}
        formatMoney={fmtMoney}
        clinicLocale={clinicLocale}
        canManage={canManage}
        viewAllHref={patientPath}
        showViewAll={false}
      />
    </div>
  );
}
