import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/patients/print-button";
import { PrintHeader } from "@/components/shared/print-header";
import { ReportDateFilter } from "@/components/patients/report-date-filter";
import {
  FollowupsList,
  type FollowupItem,
} from "@/components/patients/followups-list";

export const metadata: Metadata = { title: "Follow-up Report" };

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function FollowupsReportPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { from, to } = await searchParams;
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
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

  if (isDoctor) {
    const canAccess =
      patient.assigned_doctor_id === user.id ||
      (!!user.departmentId && patient.department_id === user.departmentId);
    if (!canAccess) notFound();
  }

  let query = supabase
    .from("follow_ups")
    .select(
      "id, recorded_at, outcome, notes, appointment_id, recorded_by:profiles!recorded_by(full_name), appointment:appointments!appointment_id(scheduled_at, departments(name, color), profiles!doctor_id(full_name))",
    )
    .eq("patient_id", id)
    .eq("clinic_id", user.clinicId)
    .order("recorded_at", { ascending: true });

  if (from) query = query.gte("recorded_at", `${from}T00:00:00.000Z`);
  if (to) query = query.lte("recorded_at", `${to}T23:59:59.999Z`);

  const { data: followups } = await query;
  const rows = (followups ?? []) as FollowupItem[];

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, address, phone, logo_url")
    .eq("id", user.clinicId)
    .single();

  const generatedAt = new Date().toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <PrintHeader
        clinicName={clinic?.name ?? ""}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
        logoUrl={clinic?.logo_url ?? null}
        documentName="Follow-up Report"
        generatedAt={generatedAt}
      />
      <div className="flex items-center gap-2 print:hidden text-sm text-muted-foreground">
        <Link
          href={`/patients/${id}`}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to patient
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText
              className="h-5 w-5 text-muted-foreground print:hidden"
              aria-hidden
            />
            <h1 className="text-2xl font-semibold tracking-tight">
              Follow-up Report
            </h1>
          </div>
          <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground text-base">
              {patient.full_name}
            </p>
            {patient.file_number && (
              <p>
                File: <span className="font-mono">{patient.file_number}</span>
              </p>
            )}
            {patient.phone && <p>Phone: {patient.phone}</p>}
            <p>
              {rows.length} follow-up{rows.length !== 1 ? "s" : ""}
              {(from || to) && " (filtered)"}
            </p>
          </div>
        </div>
        <PrintButton />
      </div>

      <ReportDateFilter from={from} to={to} />

      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        <FollowupsList followups={rows} />
      </div>
    </div>
  );
}
