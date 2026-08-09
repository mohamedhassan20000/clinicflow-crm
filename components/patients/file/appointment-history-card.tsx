"use client";

import Link from "next/link";
import { FileText, FlaskConical, MessageSquare, PhoneCall } from "lucide-react";
import { StatusBadge } from "@/components/appointments/status-badge";
import {
  AppointmentPaymentRow,
  type AppointmentPaymentRowData,
  type SettlementEntry,
} from "@/components/patients/appointment-payment-row";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import type {
  UnifiedFollowup,
  UnifiedMedicalNote,
  UnifiedRelatedDocument,
} from "@/lib/patients/file-data";

const FOLLOWUP_TONE: Record<string, string> = {
  all_fine:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  has_problem:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  no_response: "border-border bg-muted/40 text-muted-foreground",
};

const FOLLOWUP_LABEL: Record<string, string> = {
  all_fine: "followupEverythingFine",
  has_problem: "followupReportedProblem",
  no_response: "followupNoResponse",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppointmentHistoryCardAppointment = any;

export interface AppointmentHistoryCardData {
  appointment: AppointmentHistoryCardAppointment;
  followups: UnifiedFollowup[];
  notes: UnifiedMedicalNote[];
  documents: UnifiedRelatedDocument[];
}

interface Props {
  entry: AppointmentHistoryCardData;
  settlements: SettlementEntry[];
  isScopedClinical: boolean;
  docTypeLabels: Record<string, string>;
  patientId: string;
  currentUserId: string;
  canManageAllAttachments: boolean;
  canMutateNotes: boolean;
  canViewNoteAttachments: boolean;
  canUploadNoteAttachments: boolean;
  canAuthorNotes: boolean;
}

/**
 * P7-11 — one unified appointment card combining appointment details + status,
 * follow-up, invoice/billing, the appointment's medical note, and related
 * clinical documents. Billing detail is rendered only for non-scoped roles by
 * reusing the existing {@link AppointmentPaymentRow}; scoped clinical roles get
 * a lightweight header and never receive financial data.
 */
export function AppointmentHistoryCard({
  entry,
  settlements,
  isScopedClinical,
  docTypeLabels,
  patientId,
  currentUserId,
  canManageAllAttachments,
  canMutateNotes,
  canViewNoteAttachments,
  canUploadNoteAttachments,
  canAuthorNotes,
}: Props) {
  const t = useTranslations("patients");
  const { formatDate, formatDateTime, formatTime } = useClinicSettings();
  const { appointment, followups, notes, documents } = entry;
  const dept = appointment.departments as { name: string; color: string } | null;
  const deptColor = dept?.color ?? "#64748b";

  const hasExtras =
    followups.length > 0 ||
    notes.length > 0 ||
    documents.length > 0 ||
    canAuthorNotes;

  return (
    <article className="overflow-hidden rounded-xl border border-border/50 bg-card">
      {isScopedClinical ? (
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-sm font-medium tabular-nums">
              {formatDate(appointment.scheduled_at, {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
              <span className="ms-1 font-normal text-muted-foreground">
                {formatTime(appointment.scheduled_at)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{formatDoctorName(appointment.profiles?.full_name)}</span>
              {dept?.name && (
                <span
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${deptColor} 14%, transparent)`,
                    color: deptColor,
                  }}
                >
                  {dept.name}
                </span>
              )}
            </div>
          </div>
          <StatusBadge
            status={appointment.status as Parameters<typeof StatusBadge>[0]["status"]}
          />
        </div>
      ) : (
        <AppointmentPaymentRow
          a={appointment as AppointmentPaymentRowData}
          settlements={settlements}
        />
      )}

      {hasExtras && (
        <div className="space-y-3 border-t border-border/40 bg-muted/10 px-5 py-4">
          {followups.length > 0 && (
            <Sub icon={PhoneCall} label={t("followUpNotes")}>
              <ul className="space-y-2">
                {followups.map((f) => (
                  <li key={f.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                          FOLLOWUP_TONE[f.outcome] ?? FOLLOWUP_TONE.no_response
                        }`}
                      >
                        {t(FOLLOWUP_LABEL[f.outcome] ?? "followupNoResponse")}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatDateTime(f.recorded_at, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                    </div>
                    {f.notes && (
                      <p className="text-sm text-foreground">
                        &ldquo;{f.notes}&rdquo;
                      </p>
                    )}
                    {f.recorded_by_name && (
                      <p className="text-[10px] text-muted-foreground">
                        {t("recordedBy")}
                        {f.recorded_by_name}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Sub>
          )}

          {(notes.length > 0 || canAuthorNotes) && (
            <Sub icon={MessageSquare} label={t("medicalNotes")}>
              <div className="space-y-3">
                {canAuthorNotes && (
                  <div className="rounded-lg border border-border/40 bg-card p-3 print:hidden">
                    <NoteComposer
                      patientId={patientId}
                      appointmentId={appointment.id}
                    />
                  </div>
                )}
                {notes.length > 0 && (
                  <MedicalNotesList
                    notes={notes}
                    patientId={patientId}
                    currentUserId={currentUserId}
                    canManageAllAttachments={canManageAllAttachments}
                    canMutateNotes={canMutateNotes}
                    canViewAttachments={canViewNoteAttachments}
                    canUploadAttachments={canUploadNoteAttachments}
                  />
                )}
              </div>
            </Sub>
          )}

          {documents.length > 0 && (
            <Sub icon={FlaskConical} label={t("relatedDocuments")}>
              <ul className="space-y-1.5">
                {documents.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/documents/${d.id}`}
                      className="flex items-center gap-2 rounded-lg border border-border/40 bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {docTypeLabels[d.docType] ?? d.docType}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {d.documentNumber}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Sub>
          )}
        </div>
      )}
    </article>
  );
}

function Sub({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </h4>
      {children}
    </div>
  );
}
