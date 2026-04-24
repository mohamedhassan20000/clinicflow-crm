import Link from "next/link";
import {
  CalendarDays,
  CalendarPlus,
  UserPlus,
  Clock,
  CheckCircle2,
  AlertCircle,
  Hourglass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import type { Tables } from "@/types/database";

type Appointment = Tables<"appointments"> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
};

interface ReceptionistDashboardProps {
  fullName: string;
  todayCount: number;
  pendingCount: number;
  confirmedCount: number;
  todayAppointments: Appointment[];
  pendingAppointments: Appointment[];
  nextTwoHoursAppointments: Appointment[];
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function ReceptionistDashboard({
  fullName,
  todayCount,
  pendingCount,
  confirmedCount,
  todayAppointments,
  pendingAppointments,
  nextTwoHoursAppointments,
}: ReceptionistDashboardProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, {fullName}.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link href="/patients/new">
              <UserPlus className="h-4 w-4" />
              New patient
            </Link>
          </Button>
          <Button asChild size="sm" className="gap-2">
            <Link href="/appointments/new">
              <CalendarPlus className="h-4 w-4" />
              Book appointment
            </Link>
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard
          title="Today's appointments"
          value={todayCount}
          icon={CalendarDays}
          variant="primary"
        />
        <KpiCard
          title="Pending confirmation"
          value={pendingCount}
          icon={Hourglass}
          variant={pendingCount > 0 ? "warning" : "default"}
        />
        <KpiCard
          title="Confirmed today"
          value={confirmedCount}
          icon={CheckCircle2}
          variant="success"
        />
      </div>

      {/* Next 2 hours alert */}
      {nextTwoHoursAppointments.length > 0 && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-semibold text-primary">
              Next 2 hours — {nextTwoHoursAppointments.length} appointment
              {nextTwoHoursAppointments.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-1">
            {nextTwoHoursAppointments.map((appt) => (
              <div key={appt.id} className="flex items-center gap-3 text-sm">
                <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-primary/80">
                  {formatTime(appt.scheduled_at)}
                </span>
                <span className="font-medium">{appt.patients?.full_name}</span>
                <span className="text-muted-foreground text-xs">
                  → Dr. {appt.profiles?.full_name}
                </span>
                <div className="ml-auto">
                  <StatusBadge status={appt.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Today's full schedule */}
        <div className="rounded-xl border border-border/50 bg-card">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-sm">Today&apos;s schedule</h2>
            </div>
            <Link
              href="/appointments"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Full calendar →
            </Link>
          </div>
          <div className="divide-y divide-border/50 max-h-[380px] overflow-y-auto">
            {todayAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No appointments today</p>
              </div>
            ) : (
              todayAppointments.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-14 shrink-0 text-right">
                    <span className="text-xs font-mono font-medium tabular-nums">
                      {formatTime(appt.scheduled_at)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Dr. {appt.profiles?.full_name ?? "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={appt.status} />
                    <AppointmentActions
                      appointmentId={appt.id}
                      currentStatus={appt.status}
                      hasInsurance={Boolean(appt.insurance_provider_id)}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Pending confirmation list */}
        <div className="rounded-xl border border-border/50 bg-card">
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-4">
            <AlertCircle className="h-4 w-4 text-amber-500" />
            <h2 className="font-semibold text-sm">Needs confirmation</h2>
            {pendingCount > 0 && (
              <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/10 px-1.5 text-[10px] font-semibold text-amber-700">
                {pendingCount}
              </span>
            )}
          </div>
          <div className="divide-y divide-border/50 max-h-[380px] overflow-y-auto">
            {pendingAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">All caught up!</p>
              </div>
            ) : (
              pendingAppointments.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatTime(appt.scheduled_at)} · Dr.{" "}
                      {appt.profiles?.full_name ?? "—"}
                    </p>
                  </div>
                  <AppointmentActions
                    appointmentId={appt.id}
                    currentStatus={appt.status}
                    hasInsurance={Boolean(appt.insurance_provider_id)}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
