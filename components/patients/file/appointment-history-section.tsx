import Link from "next/link";
import { CalendarClock, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AppointmentHistoryCard,
  type AppointmentHistoryCardData,
} from "@/components/patients/file/appointment-history-card";
import type { SettlementEntry } from "@/components/patients/appointment-payment-row";

/** Minimal translator shape (next-intl `getTranslations` result). */
type Translator = (key: string, values?: Record<string, string | number>) => string;

interface Props {
  t: Translator;
  entries: AppointmentHistoryCardData[];
  settlementsByAppointment: Map<string, SettlementEntry[]>;
  isScopedClinical: boolean;
  docTypeLabels: Record<string, string>;
  totalCount: number;
  patientId: string;
  currentUserId: string;
  canManageAllAttachments: boolean;
  canMutateNotes: boolean;
  canViewNoteAttachments: boolean;
  canUploadNoteAttachments: boolean;
  canAuthorNotes: boolean;
  /** When set, a "View full history" button links here (main-page mode). */
  viewAllHref?: string;
  /** Contextual clinical action buttons (client), rendered in the header. */
  actions?: React.ReactNode;
}

/**
 * P7-11 — the unified appointment-history section. On the main Patient File it
 * shows the latest {@link entries} (capped at 5 by the caller) plus a "View
 * full history" link; on the full-history page the same section renders the
 * filtered set without the link. Synchronous server component — the parent page
 * owns translation resolution and passes `t` down.
 */
export function AppointmentHistorySection({
  t,
  entries,
  settlementsByAppointment,
  isScopedClinical,
  docTypeLabels,
  totalCount,
  patientId,
  currentUserId,
  canManageAllAttachments,
  canMutateNotes,
  canViewNoteAttachments,
  canUploadNoteAttachments,
  canAuthorNotes,
  viewAllHref,
  actions,
}: Props) {
  return (
    <section className="space-y-3" aria-labelledby="appointment-history-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="appointment-history-heading"
            className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <CalendarClock className="h-4 w-4" />
            {t("appointmentHistory")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("appointmentRecordCount", { count: totalCount })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {viewAllHref && (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
              <Link href={viewAllHref}>
                <History className="h-3.5 w-3.5" />
                {t("viewFullHistory")}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {entries.length > 0 ? (
        <div className="space-y-3">
          {entries.map((entry) => (
            <AppointmentHistoryCard
              key={entry.appointment.id}
              entry={entry}
              settlements={settlementsByAppointment.get(entry.appointment.id) ?? []}
              isScopedClinical={isScopedClinical}
              docTypeLabels={docTypeLabels}
              patientId={patientId}
              currentUserId={currentUserId}
              canManageAllAttachments={canManageAllAttachments}
              canMutateNotes={canMutateNotes}
              canViewNoteAttachments={canViewNoteAttachments}
              canUploadNoteAttachments={canUploadNoteAttachments}
              canAuthorNotes={canAuthorNotes}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground">
          {t("noAppointmentsYet")}
        </div>
      )}
    </section>
  );
}
