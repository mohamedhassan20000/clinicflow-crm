import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { PrintHeader } from "@/components/shared/print-header";
import { PatientReportHeader } from "@/components/patients/patient-report-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import { ReportDateFilter } from "@/components/patients/report-date-filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FollowupsList,
  type FollowupItem,
} from "@/components/patients/followups-list";

export const metadata: Metadata = { title: "Follow-up Report" };

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; returnTo?: string }>;
}

export default async function FollowupsReportPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const { from, to, returnTo } = await searchParams;
  const patientPath = `/patients/${id}`;
  const patientHref = resolveReturnTo(returnTo, patientPath, [patientPath]);
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
      <PatientReportHeader
        patientHref={patientHref}
        patientName={patient.full_name}
        fileNumber={patient.file_number}
        phone={patient.phone}
        title="Follow-up Report"
        countLabel={`${rows.length} follow-up${rows.length !== 1 ? "s" : ""}${from || to ? " (filtered)" : ""}`}
      />

      <ReportDateFilter from={from} to={to} />

      {/* Screen view */}
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card print:hidden">
        <FollowupsList followups={rows} />
      </div>

      {/* Print table — same black-border style as revenue */}
      <div className="hidden print:block">
        {rows.length === 0 ? (
          <p className="text-sm">No follow-up notes.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date Recorded</TableHead>
                <TableHead>Session Date</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Recorded By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    {new Date(f.recorded_at).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell>
                    {f.appointment?.scheduled_at
                      ? new Date(f.appointment.scheduled_at).toLocaleDateString("en-GB", { dateStyle: "medium" })
                      : "—"}
                  </TableCell>
                  <TableCell>{f.appointment?.departments?.name ?? "—"}</TableCell>
                  <TableCell>
                    {f.outcome === "all_fine"
                      ? "Everything fine"
                      : f.outcome === "has_problem"
                      ? "Reported problem"
                      : "No response"}
                  </TableCell>
                  <TableCell>{f.notes ?? "—"}</TableCell>
                  <TableCell>{f.recorded_by?.full_name ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
