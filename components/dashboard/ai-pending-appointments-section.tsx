import Link from "next/link";
import { Bot, CalendarClock, UserRoundCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AI_INTAKE_ID_PARAM,
  AI_INTAKE_REVIEW_ANCHOR,
  AI_INTAKE_REVIEW_PARAM,
} from "@/lib/navigation/ai-review-targets";

/**
 * Compact operational shortcuts for the three intake-review roles.
 *
 * P10 — these two cards counted correctly and then landed nowhere useful.
 *
 * The intake card linked to `/patients#ai-intakes`, and a fragment on a
 * cross-route App Router navigation is unreliable: the review table is the last
 * thing on a streamed server page, so the element frequently does not exist at
 * the moment the router would scroll to it and the staff member arrives at the
 * top of a long patient list with no idea why. It now carries a query parameter
 * as well, which the page reads on the client after the table has rendered, and
 * scrolls and focuses deterministically.
 *
 * The appointments card linked to `/appointments?status=pending`, which filters
 * the calendar but leaves it on *this* week — and an AI booking is at least 24
 * hours out and routinely in a later one, so the card frequently opened an
 * empty calendar. It now reads the actual pending AI appointments and links to
 * the day each one is on, with the appointment identified so the calendar opens
 * its details directly.
 */
const PREVIEW_LIMIT = 3;

export async function AiPendingAppointmentsSection({ clinicId }: { clinicId: string }) {
  const t = await getTranslations("protected");
  const supabase = await createClient();
  const now = new Date().toISOString();
  const [{ count: intakeCount }, appointmentResult, provisionalResult] = await Promise.all([
    supabase
      .from("ai_patient_intakes")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("review_status", "pending_review"),
    // The rows, not just the count: a deep link to one appointment needs its id
    // and the day it is on, and both are one query away.
    supabase
      .from("appointments")
      .select("id, scheduled_at, patients(full_name)", { count: "exact" })
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .not("ai_patient_conversation_id", "is", null)
      .is("deleted_at", null)
      .gt("expires_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(PREVIEW_LIMIT),
    // New and third-party patients do not have a `patients` row yet by
    // design. Their authoritative booking entity is the provisional request,
    // so excluding this table made a real commit operationally invisible.
    supabase
      .from("ai_appointment_requests")
      .select(
        "id, scheduled_at, intake:ai_patient_intakes!ai_appointment_requests_intake_clinic_fkey(id, full_name)",
        { count: "exact" },
      )
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .gt("expires_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(PREVIEW_LIMIT),
  ]);

  const appointmentCount =
    (appointmentResult.count ?? 0) + (provisionalResult.count ?? 0);
  const pendingAppointments = [
    ...((appointmentResult.data ?? []) as Array<{
      id: string;
      scheduled_at: string;
      patients: { full_name: string } | null;
    }>).map((appointment) => ({
      id: appointment.id,
      scheduledAt: appointment.scheduled_at,
      patientName: appointment.patients?.full_name ?? null,
      provisional: false as const,
    })),
    ...((provisionalResult.data ?? []) as Array<{
      id: string;
      scheduled_at: string;
      intake: { id: string; full_name: string } | null;
    }>).map((request) => ({
      id: request.id,
      scheduledAt: request.scheduled_at,
      patientName: request.intake?.full_name ?? null,
      intakeId: request.intake?.id ?? null,
      provisional: true as const,
    })),
  ]
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .slice(0, PREVIEW_LIMIT);

  return (
    <section className="grid gap-4 print:hidden md:grid-cols-2" aria-label={t("aiReviewQueues")}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <UserRoundCheck className="size-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">{t("aiPatientIntakesAwaitingReview")}</CardTitle>
            </div>
            <Badge variant="secondary">{intakeCount ?? 0}</Badge>
          </div>
          <CardDescription>{t("aiIntakeDashboardShortcutDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/patients?${AI_INTAKE_REVIEW_PARAM}=1#${AI_INTAKE_REVIEW_ANCHOR}`}
              data-testid="ai-intake-review-link"
            >
              {t("review")}
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-primary" aria-hidden="true" />
              <CalendarClock className="size-4 text-primary" aria-hidden="true" />
              <CardTitle className="text-base">{t("aiAppointmentsAwaitingConfirmation")}</CardTitle>
            </div>
            <Badge variant="secondary">{appointmentCount}</Badge>
          </div>
          <CardDescription>{t("aiAppointmentDashboardShortcutDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {pendingAppointments.length > 0 ? (
            <ul className="space-y-1">
              {pendingAppointments.map((appointment) => (
                <li key={appointment.id}>
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start px-2 py-1.5 text-start"
                  >
                    <Link
                      href={appointment.provisional && appointment.intakeId
                        ? `/patients?${AI_INTAKE_REVIEW_PARAM}=1&${AI_INTAKE_ID_PARAM}=${appointment.intakeId}#${AI_INTAKE_REVIEW_ANCHOR}`
                        : appointment.provisional
                          ? `/patients?${AI_INTAKE_REVIEW_PARAM}=1#${AI_INTAKE_REVIEW_ANCHOR}`
                        : appointmentDeepLink(appointment.id, appointment.scheduledAt)}
                      data-testid={appointment.provisional
                        ? "ai-provisional-booking-deep-link"
                        : "ai-appointment-deep-link"}
                    >
                      <span className="truncate text-sm">
                        {appointment.patientName ?? t("unknown")}
                      </span>
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href="/appointments?status=pending&ai=1" data-testid="ai-appointments-manage-link">
              {t("manage")}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * A link that opens one appointment's details in the calendar.
 *
 * The day view is used deliberately rather than the week: the appointment's own
 * date pins the range, so the target is on screen whichever week it falls in,
 * which was the whole failure of the previous `?status=pending` link.
 *
 * The date is taken from the ISO instant's date part. That is UTC rather than
 * clinic-local, which can be a day out for an appointment within a few hours of
 * midnight — so the calendar's own deep-link handler falls back to searching
 * the adjacent day rather than relying on this being exact. Formatting the
 * clinic-local date here would need the clinic's timezone in a component that
 * otherwise needs no clinic settings at all.
 */
function appointmentDeepLink(appointmentId: string, scheduledAt: string): string {
  const day = scheduledAt.slice(0, 10);
  const params = new URLSearchParams({
    view: "day",
    date: day,
    status: "pending",
    appointment: appointmentId,
  });
  return `/appointments?${params.toString()}`;
}
