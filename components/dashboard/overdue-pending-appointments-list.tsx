"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { overdueMinutes } from "@/lib/appointments/overdue-pending";

export type OverduePendingAppointmentItem = {
  id: string;
  patientId: string;
  doctorId: string;
  patientName: string;
  doctorName: string;
  scheduledAt: string;
  durationMinutes: number;
};

type OperationalRole = "admin" | "receptionist" | "manager" | "assistant";

export function OverduePendingAppointmentsList({
  appointments,
  currentUserId,
  currentUserRole,
}: {
  appointments: OverduePendingAppointmentItem[];
  currentUserId: string;
  currentUserRole: OperationalRole;
}) {
  const t = useTranslations("dashboard");
  const appointmentT = useTranslations("appointments");
  const { formatDate, formatTime } = useClinicSettings();
  const [removed, setRemoved] = useState<string[]>([]);
  const visible = appointments.filter((appointment) => !removed.includes(appointment.id));

  if (visible.length === 0) return null;

  return (
    <Card data-overdue-pending-section>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
            <CalendarClock className="size-5" aria-hidden />
          </div>
          <div className="space-y-1">
            <CardTitle>{t("overduePendingAppointments")}</CardTitle>
            <CardDescription>{t("overduePendingAppointmentsDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {visible.map((appointment) => {
          const minutes = overdueMinutes(
            {
              scheduled_at: appointment.scheduledAt,
              duration_minutes: appointment.durationMinutes,
            },
          );
          return (
            <div key={appointment.id} className="grid gap-3 px-6 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{appointment.patientName}</p>
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                    {appointmentT("overduePending")}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {appointment.doctorName} · {formatDate(appointment.scheduledAt)} · {formatTime(appointment.scheduledAt)}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("overdueByMinutes", { count: minutes })}
                </p>
              </div>
              <AppointmentActions
                appointmentId={appointment.id}
                currentStatus="pending"
                patientId={appointment.patientId}
                doctorId={appointment.doctorId}
                scheduledAt={appointment.scheduledAt}
                durationMinutes={appointment.durationMinutes}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
                overduePending
                onActionComplete={() => setRemoved((current) => [...current, appointment.id])}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
