import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { createClient } from "@/lib/supabase/server";
import { formatDoctorName } from "@/lib/format-doctor";

export async function GET() {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const { data: appointments, error } = await supabase
    .from("appointments")
    .select(
      "scheduled_at, duration_minutes, status, notes, patients(full_name, phone, date_of_birth), profiles!doctor_id(full_name), departments(name), insurance_providers(name)",
    )
    .eq("clinic_id", user.clinicId)
    .order("scheduled_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // KVKK-compliant: exclude email, blood_type, medical notes
  const rows: string[] = [
    "Date,Time,Patient name,Patient phone,Patient DOB,Doctor,Department,Insurance,Duration (min),Status,Notes",
  ];

  for (const a of appointments ?? []) {
    const dt = new Date(a.scheduled_at);
    const date = dt.toLocaleDateString("en-GB", { timeZone: DEFAULT_TIME_ZONE });
    const time = dt.toLocaleTimeString("en-GB", {
      timeZone: DEFAULT_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const patient = a.patients as { full_name: string; phone: string; date_of_birth: string } | null;
    const doctor = a.profiles as { full_name: string } | null;
    const dept = a.departments as { name: string } | null;
    const insurance = a.insurance_providers as { name: string } | null;

    const cell = (v: string | null | undefined) =>
      v ? `"${v.replace(/"/g, '""')}"` : "";

    rows.push(
      [
        date,
        time,
        cell(patient?.full_name),
        cell(patient?.phone),
        cell(patient?.date_of_birth),
        cell(doctor?.full_name ? formatDoctorName(doctor.full_name) : null),
        cell(dept?.name),
        cell(insurance?.name),
        a.duration_minutes,
        a.status,
        cell(a.notes),
      ].join(","),
    );
  }

  const csv = rows.join("\n");
  const filename = `appointments_${new Date().toISOString().split("T")[0]}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
