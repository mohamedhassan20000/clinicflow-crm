import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { WeekCalendar } from "@/components/appointments/week-calendar";

export const metadata: Metadata = { title: "Appointments" };

interface PageProps {
  searchParams: Promise<{ week?: string }>;
}

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Parse "YYYY-MM-DD" as local-midnight (not UTC) so week navigation
// is stable regardless of server timezone.
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

export default async function AppointmentsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const { week } = await searchParams;

  const weekStart = getMonday(week ? parseLocalDate(week) : new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const supabase = await createClient();

  const { data: appointments } = await supabase
    .from("appointments")
    .select("*, patients(full_name), profiles!doctor_id(full_name)")
    .eq("clinic_id", user.clinicId)
    .gte("scheduled_at", weekStart.toISOString())
    .lt("scheduled_at", weekEnd.toISOString())
    .order("scheduled_at");

  const total = appointments?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
        <p className="text-sm text-muted-foreground">
          {total} appointment{total !== 1 ? "s" : ""} this week.
        </p>
      </div>

      <WeekCalendar
        appointments={(appointments ?? []) as Parameters<typeof WeekCalendar>[0]["appointments"]}
        weekStart={weekStart}
        canEdit={user.role !== "manager"}
      />
    </div>
  );
}
