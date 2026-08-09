import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { clinicLocaleFromRow, formatClinicDate } from "@/lib/datetime";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PrintHeader } from "@/components/shared/print-header";
import { PatientReportHeader } from "@/components/patients/patient-report-header";
import { HistoryDateFilter } from "@/components/patients/file/history-date-filter";
import { AppointmentHistorySection } from "@/components/patients/file/appointment-history-section";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import {
  buildDocumentQuery,
  loadAppointmentHistory,
  resolveHistoryRange,
} from "@/lib/patients/file-data";
import { resolveReturnTo } from "@/lib/navigation/return-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("patients");
  return { title: t("appointmentHistory") };
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

export default async function PatientHistoryPage({
  params,
  searchParams,
}: PageProps) {
  const t = await getTranslations("patients");
  const { id } = await params;
  const { preset, from, to, returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientHref = resolveReturnTo(returnTo, patientPath, [patientPath]);

  const user = await requireUser();
  const isScopedClinical = user.role === "doctor" || user.role === "assistant";
  const canMutateNotes = user.role === "admin" || user.role === "doctor";
  const canViewNoteAttachments =
    canMutateNotes || user.role === "receptionist";
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select(
      "id, full_name, file_number, phone, is_deleted, assigned_doctor_id, department_id",
    )
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  if (user.role === "doctor") {
    const canAccess =
      patient.assigned_doctor_id === user.id ||
      (!!user.departmentId && patient.department_id === user.departmentId);
    if (!canAccess) notFound();
  }

  const range = resolveHistoryRange({ preset, from, to });
  const [{ entries, totalCount, settlementsByAppointment }, docTypeLabels, { data: clinic }] =
    await Promise.all([
      loadAppointmentHistory(supabase, {
        clinicId: user.clinicId,
        patientId: id,
        isScopedClinical,
        includeNoteAttachments: canViewNoteAttachments,
        from: range.from,
        to: range.to,
      }),
      getDocumentTypeLabels(),
      supabase
        .from("clinics")
        .select("name, address, phone, logo_url, timezone, locale, digits, time_format")
        .eq("id", user.clinicId)
        .single(),
    ]);

  const clinicLocale = clinicLocaleFromRow(clinic);
  const generatedAt = formatClinicDate(new Date(), clinicLocale, {
    dateStyle: "long",
    timeStyle: "short",
  });

  const filtered = range.preset !== "all";
  const countLabel = `${t("appointmentRecordCount", { count: totalCount })}${
    filtered ? ` · ${t("filtered")}` : ""
  }`;
  const documentHref = `/documents/patient-history/appointment-history?${buildDocumentQuery(id, range)}`;

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName={t("appointmentHistory")}
        generatedAt={generatedAt}
      />
      <PatientReportHeader
        patientHref={patientHref}
        patientName={patient.full_name}
        fileNumber={patient.file_number}
        phone={patient.phone}
        title={t("appointmentHistory")}
        countLabel={countLabel}
        documentHref={documentHref}
      />

      <HistoryDateFilter preset={range.preset} from={range.from} to={range.to} />

      <AppointmentHistorySection
        t={t}
        entries={entries}
        settlementsByAppointment={settlementsByAppointment}
        isScopedClinical={isScopedClinical}
        docTypeLabels={docTypeLabels}
        totalCount={totalCount}
        patientId={id}
        currentUserId={user.id}
        canManageAllAttachments={user.role === "admin"}
        canMutateNotes={canMutateNotes}
        canViewNoteAttachments={canViewNoteAttachments}
        canUploadNoteAttachments={canMutateNotes}
        canAuthorNotes={canMutateNotes && !patient.is_deleted}
      />
    </div>
  );
}
