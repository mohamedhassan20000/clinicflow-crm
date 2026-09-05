import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { MedicalNoteAttachmentItem } from "@/actions/medical-note-attachments";
import { resolveRollingYearRange } from "@/lib/date-range";

/**
 * P7-11 — shared Patient File data layer.
 *
 * This is the single owner of the unified appointment-history assembly and the
 * in-app billing computation reused by the Patient File page, the full
 * appointment-history page, the deposits page, and (later) the P7-12 history /
 * financial document resolvers. It introduces **no new financial schema**:
 * "invoice/billing" is derived from the existing appointment payment columns +
 * `outstanding_settlements` + `patient_deposits`, exactly as the pre-redesign
 * monolith computed it (doc 16 §8 data-honesty note).
 *
 * The query helpers take an already-authenticated Supabase client so every read
 * flows through the caller's RLS scope — a scoped clinical role (doctor /
 * assistant) only ever sees its own patients/encounters, and financial columns
 * are never selected for those roles.
 */

type DbClient = SupabaseClient<Database>;

/** Exactly five appointments are shown on the main Patient File preview. */
export const PATIENT_FILE_APPOINTMENT_PREVIEW_LIMIT = 5;

/** Document type codes that are clinical (safe to surface to scoped clinical roles). */
export const CLINICAL_DOCUMENT_TYPE_CODES = [
  "PRESCRIPTION",
  "LAB_REQUEST",
  "SICK_LEAVE_CERTIFICATE",
] as const;

export type ClinicalDocumentTypeCode =
  (typeof CLINICAL_DOCUMENT_TYPE_CODES)[number];

export function isClinicalDocumentType(code: string): boolean {
  return (CLINICAL_DOCUMENT_TYPE_CODES as readonly string[]).includes(code);
}

/**
 * P7-12 print targets for the Patient File history/financial surfaces. The
 * engine slices (catalog entry + resolver + template + reprint RPC) are now
 * implemented in P7-12 (`lib/documents/resolvers/patient-history.ts`), and the
 * history / packages / deposits pages deep-link to their preview surfaces via
 * the "Generate document" action. Browser print remains available as a fallback.
 */
export const PATIENT_HISTORY_DOCUMENT_TYPES = {
  appointmentHistory: "APPOINTMENT_HISTORY_REPORT",
  packageHistory: "PACKAGE_HISTORY_REPORT",
  depositStatement: "DEPOSIT_STATEMENT",
  patientFinancialSummary: "PATIENT_FINANCIAL_SUMMARY",
} as const;

export type PatientHistoryDocumentType =
  (typeof PATIENT_HISTORY_DOCUMENT_TYPES)[keyof typeof PATIENT_HISTORY_DOCUMENT_TYPES];

// ---------------------------------------------------------------------------
// Date-range presets (pure, unit-tested)
// ---------------------------------------------------------------------------

export type HistoryPreset = "all" | "last_week" | "last_month" | "last_year" | "custom";

export const HISTORY_PRESETS: HistoryPreset[] = [
  "all",
  "last_week",
  "last_month",
  "last_year",
  "custom",
];

export type ResolvedHistoryRange = {
  preset: HistoryPreset;
  /** yyyy-mm-dd (inclusive) or null when unbounded. */
  from: string | null;
  /** yyyy-mm-dd (inclusive) or null when unbounded. */
  to: string | null;
};

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves the appointment-history date filter. Rolling presets (last week /
 * month / year) are computed from `now`; `custom` honours the supplied
 * from/to; anything else (or a bare/invalid value) falls back to `all`.
 */
export function resolveHistoryRange(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): ResolvedHistoryRange {
  const now = input.now ?? new Date();
  const raw = (input.preset ?? "").trim();

  if (raw === "custom") {
    const from = normalizeDateInput(input.from);
    const to = normalizeDateInput(input.to);
    if (from || to) return { preset: "custom", from, to };
    return { preset: "all", from: null, to: null };
  }

  const to = toDateInput(now);

  if (raw === "last_week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { preset: "last_week", from: toDateInput(start), to };
  }
  if (raw === "last_month") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { preset: "last_month", from: toDateInput(start), to };
  }
  if (raw === "last_year") {
    const range = resolveRollingYearRange(now);
    return { preset: "last_year", from: range.from, to: range.to };
  }

  return { preset: "all", from: null, to: null };
}

function normalizeDateInput(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Builds the query string that carries the patient + active date range into a
 * P7-12 patient-history document preview surface. Used by the history / packages
 * / deposits pages' "Generate document" entry points.
 */
export function buildDocumentQuery(
  patientId: string,
  range: ResolvedHistoryRange,
): string {
  const query = new URLSearchParams({ patientId });
  if (range.preset !== "all") {
    query.set("preset", range.preset);
    if (range.from) query.set("from", range.from);
    if (range.to) query.set("to", range.to);
  }
  return query.toString();
}

// ---------------------------------------------------------------------------
// Billing computation (pure, unit-tested) — no new schema, mirrors the monolith
// ---------------------------------------------------------------------------

export type BillingTotals = {
  billed: number;
  collected: number;
  outstanding: number;
};

export type PatientDepositState = {
  totalDeposited: number;
  totalSpent: number;
  accountBalance: number;
};

type CompletedAppointmentAmounts = {
  status: string;
  total_amount?: number | null;
  paid_amount?: number | null;
  insurance_amount?: number | null;
  secondary_amount?: number | null;
  deposit_amount?: number | null;
  outstanding_amount?: number | null;
};

export function computeBillingTotals(
  appointments: CompletedAppointmentAmounts[],
): BillingTotals {
  return appointments
    .filter((a) => a.status === "completed")
    .reduce<BillingTotals>(
      (acc, a) => {
        acc.billed += a.total_amount ?? 0;
        acc.collected +=
          (a.paid_amount ?? 0) +
          (a.insurance_amount ?? 0) +
          (a.secondary_amount ?? 0) +
          (a.deposit_amount ?? 0);
        acc.outstanding += a.outstanding_amount ?? 0;
        return acc;
      },
      { billed: 0, collected: 0, outstanding: 0 },
    );
}

export function computeDepositState(
  deposits: { amount?: number | null }[],
  spentRows: { deposit_amount?: number | null }[],
): PatientDepositState {
  const totalDeposited = deposits.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const totalSpent = spentRows.reduce(
    (s, r) => s + Number(r.deposit_amount ?? 0),
    0,
  );
  const accountBalance = Math.max(
    0,
    Number((totalDeposited - totalSpent).toFixed(2)),
  );
  return { totalDeposited, totalSpent, accountBalance };
}

// ---------------------------------------------------------------------------
// Unified appointment-history assembly (pure, unit-tested)
// ---------------------------------------------------------------------------

export type UnifiedFollowup = {
  id: string;
  outcome: string;
  notes: string | null;
  recorded_at: string;
  recorded_by_name: string | null;
};

export type UnifiedMedicalNote = {
  id: string;
  patient_id: string;
  doctor_id: string;
  created_by: string | null;
  note: string;
  created_at: string;
  profiles: { full_name: string | null } | null;
  attachments: MedicalNoteAttachmentItem[];
};

export type UnifiedRelatedDocument = {
  id: string;
  docType: string;
  documentNumber: string;
  status: string;
  issuedAt: string | null;
  verificationToken: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UnifiedAppointmentEntry<A = any> = {
  appointment: A;
  followups: UnifiedFollowup[];
  notes: UnifiedMedicalNote[];
  documents: UnifiedRelatedDocument[];
};

export function assembleAppointmentHistory<A extends { id: string }>(args: {
  appointments: A[];
  followupsByAppointment: Map<string, UnifiedFollowup[]>;
  notesByAppointment: Map<string, UnifiedMedicalNote[]>;
  documentsByAppointment: Map<string, UnifiedRelatedDocument[]>;
}): UnifiedAppointmentEntry<A>[] {
  return args.appointments.map((appointment) => ({
    appointment,
    followups: args.followupsByAppointment.get(appointment.id) ?? [],
    notes: args.notesByAppointment.get(appointment.id) ?? [],
    documents: args.documentsByAppointment.get(appointment.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Query orchestration (server; RLS-scoped through the passed client)
// ---------------------------------------------------------------------------

const APPOINTMENT_SELECT_SCOPED =
  "id, doctor_id, scheduled_at, status, cancellation_reason, cancelled_at, package_id, package_session_number, profiles!doctor_id(full_name), departments(name, color), patient_packages(name, total_sessions, used_sessions)";

const APPOINTMENT_SELECT_FINANCIAL =
  "id, doctor_id, scheduled_at, status, payment_method, paid_at, total_amount, paid_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, secondary_amount, deposit_amount, outstanding_amount, secondary_payment_method, payment_note, cancellation_reason, cancelled_at, package_id, package_session_number, profiles!doctor_id(full_name), departments(name, color), insurance_providers(name), patient_packages(name, total_sessions, used_sessions, price_per_session), appointment_services(id, name, price, quantity)";

export type LoadAppointmentHistoryArgs = {
  clinicId: string;
  patientId: string;
  isScopedClinical: boolean;
  /** yyyy-mm-dd inclusive lower bound. */
  from?: string | null;
  /** yyyy-mm-dd inclusive upper bound. */
  to?: string | null;
  limit?: number;
  /** Load note attachments only for roles that already have attachment access. */
  includeNoteAttachments?: boolean;
};

export type LoadAppointmentHistoryResult = {
  entries: UnifiedAppointmentEntry[];
  /** Total appointments in range (may exceed `entries.length` when `limit` set). */
  totalCount: number;
  settlementsByAppointment: Map<
    string,
    {
      id: string;
      settled_at: string;
      amount: number;
      payment_method: string;
      note: string | null;
    }[]
  >;
};

/**
 * Loads the unified appointment history for a patient: appointments (with the
 * role-appropriate column set) joined to their follow-ups, appointment-linked
 * medical notes, and related issued documents. Financial joins/settlements are
 * skipped entirely for scoped clinical roles, and related documents are
 * filtered to clinical types for those roles so no financial document leaks.
 */
export async function loadAppointmentHistory(
  supabase: DbClient,
  args: LoadAppointmentHistoryArgs,
): Promise<LoadAppointmentHistoryResult> {
  const {
    clinicId,
    patientId,
    isScopedClinical,
    from,
    to,
    limit,
    includeNoteAttachments = false,
  } = args;

  let query = supabase
    .from("appointments")
    .select(
      isScopedClinical ? APPOINTMENT_SELECT_SCOPED : APPOINTMENT_SELECT_FINANCIAL,
      { count: "exact" },
    )
    .eq("patient_id", patientId)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .order("scheduled_at", { ascending: false });

  if (from) query = query.gte("scheduled_at", `${from}T00:00:00.000Z`);
  if (to) query = query.lte("scheduled_at", `${to}T23:59:59.999Z`);
  if (limit) query = query.limit(limit);

  const appointmentsResult = await query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appointments = (appointmentsResult.data ?? []) as any[];
  const totalCount = appointmentsResult.count ?? appointments.length;
  const appointmentIds = appointments.map((a) => a.id as string);

  const followupsByAppointment = new Map<string, UnifiedFollowup[]>();
  const notesByAppointment = new Map<string, UnifiedMedicalNote[]>();
  const documentsByAppointment = new Map<string, UnifiedRelatedDocument[]>();
  const settlementsByAppointment: LoadAppointmentHistoryResult["settlementsByAppointment"] =
    new Map();

  if (appointmentIds.length > 0) {
    const [followupsResult, notesResult, documentsResult] = await Promise.all([
      supabase
        .from("follow_ups")
        .select(
          "id, appointment_id, outcome, notes, recorded_at, recorded_by:profiles!recorded_by(full_name)",
        )
        .eq("patient_id", patientId)
        .eq("clinic_id", clinicId)
        .in("appointment_id", appointmentIds)
        .order("recorded_at", { ascending: false }),
      supabase
        .from("medical_notes")
        .select(
          "id, patient_id, appointment_id, doctor_id, note, created_at, created_by, profiles!doctor_id(full_name)",
        )
        .eq("patient_id", patientId)
        .in("appointment_id", appointmentIds)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("documents")
        .select(
          "id, appointment_id, doc_type, document_number, status, issued_at, verification_token",
        )
        .eq("patient_id", patientId)
        .eq("clinic_id", clinicId)
        .in("appointment_id", appointmentIds)
        .not("issued_at", "is", null)
        .order("issued_at", { ascending: false }),
    ]);

    for (const row of followupsResult.data ?? []) {
      if (!row.appointment_id) continue;
      const list = followupsByAppointment.get(row.appointment_id) ?? [];
      const recordedBy = row.recorded_by as { full_name: string | null } | null;
      list.push({
        id: row.id,
        outcome: row.outcome,
        notes: row.notes,
        recorded_at: row.recorded_at,
        recorded_by_name: recordedBy?.full_name ?? null,
      });
      followupsByAppointment.set(row.appointment_id, list);
    }

    const noteRows = notesResult.data ?? [];
    const attachmentsByNote = new Map<string, MedicalNoteAttachmentItem[]>();

    if (includeNoteAttachments && noteRows.length > 0) {
      const { data: attachmentRows } = await supabase
        .from("medical_note_attachments")
        .select(
          "id, note_id, file_name, mime_type, size_bytes, created_at, uploaded_by, uploaded_by_profile:profiles!medical_note_attachments_uploaded_by_fkey(full_name)",
        )
        .eq("clinic_id", clinicId)
        .eq("patient_id", patientId)
        .in(
          "note_id",
          noteRows.map((note) => note.id),
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      for (const row of attachmentRows ?? []) {
        const list = attachmentsByNote.get(row.note_id) ?? [];
        const uploadedBy = row.uploaded_by_profile as {
          full_name: string | null;
        } | null;
        list.push({
          id: row.id,
          fileName: row.file_name,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          createdAt: row.created_at,
          uploadedById: row.uploaded_by,
          uploadedByName: uploadedBy?.full_name ?? null,
        });
        attachmentsByNote.set(row.note_id, list);
      }
    }

    for (const row of noteRows) {
      if (!row.appointment_id) continue;
      const list = notesByAppointment.get(row.appointment_id) ?? [];
      const doctor = row.profiles as { full_name: string | null } | null;
      list.push({
        id: row.id,
        patient_id: row.patient_id,
        doctor_id: row.doctor_id,
        created_by: row.created_by,
        note: row.note,
        created_at: row.created_at,
        profiles: doctor,
        attachments: attachmentsByNote.get(row.id) ?? [],
      });
      notesByAppointment.set(row.appointment_id, list);
    }

    for (const row of documentsResult.data ?? []) {
      if (!row.appointment_id) continue;
      // Scoped clinical roles never see financial documents (e.g. invoices).
      if (isScopedClinical && !isClinicalDocumentType(row.doc_type)) continue;
      const list = documentsByAppointment.get(row.appointment_id) ?? [];
      list.push({
        id: row.id,
        docType: row.doc_type,
        documentNumber: row.document_number,
        status: row.status,
        issuedAt: row.issued_at,
        verificationToken: row.verification_token,
      });
      documentsByAppointment.set(row.appointment_id, list);
    }

    if (!isScopedClinical) {
      const { data: settlements } = await supabase
        .from("outstanding_settlements")
        .select("id, appointment_id, settled_at, amount, payment_method, note")
        .eq("patient_id", patientId)
        .eq("clinic_id", clinicId)
        .in("appointment_id", appointmentIds)
        .order("settled_at", { ascending: true });

      for (const s of settlements ?? []) {
        if (!s.appointment_id) continue;
        const list = settlementsByAppointment.get(s.appointment_id) ?? [];
        list.push({
          id: s.id,
          settled_at: s.settled_at,
          amount: Number(s.amount ?? 0),
          payment_method: s.payment_method,
          note: s.note,
        });
        settlementsByAppointment.set(s.appointment_id, list);
      }
    }
  }

  const entries = assembleAppointmentHistory({
    appointments,
    followupsByAppointment,
    notesByAppointment,
    documentsByAppointment,
  });

  return { entries, totalCount, settlementsByAppointment };
}

export type PatientDepositTransaction = {
  id: string;
  amount: number;
  created_at: string;
  note: string | null;
  recorded_by_name: string | null;
};

export type LoadDepositsResult = {
  state: PatientDepositState;
  transactions: PatientDepositTransaction[];
};

/**
 * Loads the patient's deposit balance + individual deposit transactions and the
 * total spent-from-deposit across appointments. Deposits have no ledger table —
 * the balance is derived (doc 16 §8). Never called for scoped clinical roles.
 */
export async function loadPatientDeposits(
  supabase: DbClient,
  args: { clinicId: string; patientId: string; from?: string | null; to?: string | null },
): Promise<LoadDepositsResult> {
  const { clinicId, patientId, from, to } = args;

  let depositsQuery = supabase
    .from("patient_deposits")
    .select(
      "id, amount, created_at, note, recorded_by:profiles!patient_deposits_created_by_fkey(full_name)",
    )
    .eq("patient_id", patientId)
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: false });
  if (from) depositsQuery = depositsQuery.gte("created_at", `${from}T00:00:00.000Z`);
  if (to) depositsQuery = depositsQuery.lte("created_at", `${to}T23:59:59.999Z`);

  const [depositsResult, spentResult] = await Promise.all([
    depositsQuery,
    supabase
      .from("appointments")
      .select("deposit_amount")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId)
      .is("deleted_at", null),
  ]);

  const rows = depositsResult.data ?? [];
  const transactions: PatientDepositTransaction[] = rows.map((row) => {
    const recordedBy = row.recorded_by as { full_name: string | null } | null;
    return {
      id: row.id,
      amount: Number(row.amount ?? 0),
      created_at: row.created_at,
      note: row.note,
      recorded_by_name: recordedBy?.full_name ?? null,
    };
  });

  // The account balance is derived from ALL deposits/spend (unfiltered); the
  // filtered `transactions` above are only the statement lines in range.
  const { data: allDeposits } =
    from || to
      ? await supabase
          .from("patient_deposits")
          .select("amount")
          .eq("patient_id", patientId)
          .eq("clinic_id", clinicId)
      : { data: rows.map((r) => ({ amount: r.amount })) };

  const state = computeDepositState(
    allDeposits ?? [],
    spentResult.data ?? [],
  );

  return { state, transactions };
}
