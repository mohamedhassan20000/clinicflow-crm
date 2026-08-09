"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  reprintAnalyticalReportDocument,
  reprintInvoiceDocument,
  reprintPatientHistoryDocument,
  reprintRevenueReportDocument,
  reprintRosterProfileDocument,
  type DocumentActionErrorCode,
  type DocumentReprintFailureStage,
} from "@/actions/documents";
import { reprintClinicalDocument } from "@/actions/clinical-documents";
import { reprintGenericDocument } from "@/actions/generic-documents";
import {
  isRegisteredDocumentType,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import {
  DOCUMENT_STATUS_VALUES,
  documentDraftHrefs,
  getAccessibleDocumentTypeCodes,
  renderedDocumentHref,
  type DocumentModuleStatus,
} from "@/lib/documents/module";
import type { P74AnalyticalDocumentCode } from "@/lib/documents/resolvers/analytical-report";
import type { P75RosterProfileDocumentCode } from "@/lib/documents/resolvers/roster-profile";
import type { P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import {
  P712_PATIENT_HISTORY_DOCUMENT_CODES,
  type P712PatientHistoryDocumentCode,
} from "@/lib/documents/resolvers/patient-history";
import { requireMutationUser, requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

const ANALYTICAL_CODES = new Set<RegisteredDocumentTypeCode>([
  "FOLLOW_UP_PAGE_REPORT",
  "CANCELLATION_REPORT",
  "NO_SHOW_REPORT",
  "SALES_REPORT",
  "FOLLOW_UP_ANALYTICS_REPORT",
  "DOCTOR_PERFORMANCE_REPORT",
  "RECEPTIONIST_PERFORMANCE_REPORT",
]);
const ROSTER_PROFILE_CODES = new Set<RegisteredDocumentTypeCode>([
  "PATIENT_LIST_REPORT",
  "PATIENT_FILE",
  "SYSTEM_MEMBERS_REPORT",
  "STAFF_FILE",
]);
const CLINICAL_CODES = new Set<RegisteredDocumentTypeCode>([
  "PRESCRIPTION",
  "LAB_REQUEST",
  "SICK_LEAVE_CERTIFICATE",
]);

export type DocumentModuleErrorCode =
  | "invalidInput"
  | "listFailed"
  | "documentNotFound"
  | "cancelFailed"
  | "reprintFailed"
  | "forbidden";

export type DocumentModuleRow = {
  id: string;
  docType: RegisteredDocumentTypeCode;
  documentNumber: string | null;
  status: DocumentModuleStatus;
  locale: "ar" | "en";
  subjectName: string | null;
  issuedByName: string | null;
  issuedAt: string;
  printCount: number;
  isDraft: boolean;
  viewHref: string;
  editHref: string | null;
};

export type DocumentModuleListResult = {
  rows: DocumentModuleRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type DocumentModuleDetail = DocumentModuleRow & {
  pageCount: number;
  verificationToken: string;
  renderedHref: string | null;
  events: {
    id: string;
    event: string;
    occurredAt: string;
    actorName: string | null;
  }[];
};

export type DocumentFilterOptions = {
  types: RegisteredDocumentTypeCode[];
  patients: { id: string; name: string }[];
  staff: { id: string; name: string }[];
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type DatabaseErrorFields = {
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
};

/** Preserve the diagnostic fields carried by Supabase's plain PostgrestError. */
function databaseErrorFields(error: unknown): DatabaseErrorFields {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const field = (key: string) =>
      typeof value[key] === "string" ? (value[key] as string) : null;
    return {
      message:
        field("message") ??
        (error instanceof Error ? error.message : String(error)),
      code: field("code"),
      details: field("details"),
      hint: field("hint"),
    };
  }
  return {
    message: error == null ? "unknown" : String(error),
    code: null,
    details: null,
    hint: null,
  };
}

const listInputSchema = z.object({
  type: z.string().optional().nullable(),
  status: z.enum(DOCUMENT_STATUS_VALUES).optional().nullable(),
  dateFrom: isoDate.optional().nullable(),
  dateTo: isoDate.optional().nullable(),
  patientId: uuid.optional().nullable(),
  employeeId: uuid.optional().nullable(),
  creatorId: uuid.optional().nullable(),
  documentNumber: z.string().trim().max(64).optional().nullable(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type DocumentModuleListInput = z.input<typeof listInputSchema>;

function normalizeStatus(value: string): DocumentModuleStatus | null {
  if (value === "void") return "cancelled";
  return (DOCUMENT_STATUS_VALUES as readonly string[]).includes(value)
    ? (value as DocumentModuleStatus)
    : null;
}

/**
 * Batch-resolve subject and creator display names for a page of rows without a
 * per-row query or a snapshot parse. Names never widen access — the underlying
 * rows already passed the clinic + subject-scope RLS on `documents`.
 */
async function resolveRowLabels(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: {
    patient_id: string | null;
    staff_id: string | null;
    doctor_id: string | null;
    appointment_id: string | null;
    issued_by: string;
  }[],
) {
  const patientIds = new Set<string>();
  const profileIds = new Set<string>();
  const appointmentIds = new Set<string>();
  for (const row of rows) {
    if (row.patient_id) patientIds.add(row.patient_id);
    if (row.doctor_id) profileIds.add(row.doctor_id);
    if (row.staff_id) profileIds.add(row.staff_id);
    if (row.issued_by) profileIds.add(row.issued_by);
    if (row.appointment_id && !row.patient_id) appointmentIds.add(row.appointment_id);
  }

  const [patients, appointments] = await Promise.all([
    patientIds.size > 0
      ? supabase.from("patients").select("id, full_name").in("id", Array.from(patientIds))
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    appointmentIds.size > 0
      ? supabase
        .from("appointments")
        .select("id, patient_id, patients(full_name)")
        .in("id", Array.from(appointmentIds))
      : Promise.resolve({
        data: [] as { id: string; patient_id: string | null; patients: { full_name: string } | null }[],
      }),
  ]);
  for (const appointment of appointments.data ?? []) {
    if (appointment.patient_id) profileIds.add(appointment.patient_id);
  }
  const profiles = profileIds.size > 0
    ? await supabase.from("profiles").select("id, full_name").in("id", Array.from(profileIds))
    : { data: [] as { id: string; full_name: string }[] };

  const patientNames = new Map((patients.data ?? []).map((row) => [row.id, row.full_name]));
  const profileNames = new Map((profiles.data ?? []).map((row) => [row.id, row.full_name]));
  const appointmentPatient = new Map(
    (appointments.data ?? []).map((row) => [
      row.id,
      row.patients?.full_name
        ?? (row.patient_id ? patientNames.get(row.patient_id) ?? null : null),
    ]),
  );

  return { patientNames, profileNames, appointmentPatient };
}

function subjectNameFor(
  row: {
    patient_id: string | null;
    staff_id: string | null;
    doctor_id: string | null;
    appointment_id: string | null;
  },
  labels: Awaited<ReturnType<typeof resolveRowLabels>>,
): string | null {
  if (row.patient_id) return labels.patientNames.get(row.patient_id) ?? null;
  if (row.doctor_id) return labels.profileNames.get(row.doctor_id) ?? null;
  if (row.staff_id) return labels.profileNames.get(row.staff_id) ?? null;
  if (row.appointment_id) return labels.appointmentPatient.get(row.appointment_id) ?? null;
  return null;
}

const ROW_COLUMNS =
  "id, doc_type, document_number, status, locale, patient_id, staff_id, doctor_id, appointment_id, issued_at, issued_by, print_count";

const DRAFT_ROW_COLUMNS =
  "id, doc_type, status, locale, params, patient_id, staff_id, doctor_id, appointment_id, created_by, updated_at";

export async function listClinicDocuments(
  input: DocumentModuleListInput = {},
): Promise<
  | { data: DocumentModuleListResult; errorCode?: never }
  | { data?: never; errorCode: DocumentModuleErrorCode }
> {
  const user = await requireUser();
  const parsed = listInputSchema.safeParse(input);
  if (!parsed.success) return { errorCode: "invalidInput" };
  const filters = parsed.data;

  const accessible = getAccessibleDocumentTypeCodes(user.role);
  if (accessible.length === 0) {
    return { data: { rows: [], total: 0, page: 1, pageSize: filters.pageSize ?? 20 } };
  }

  let typeFilter: RegisteredDocumentTypeCode[] = accessible;
  if (filters.type) {
    if (!isRegisteredDocumentType(filters.type) || !accessible.includes(filters.type)) {
      // A type the caller may not see yields an empty, non-leaking result.
      return { data: { rows: [], total: 0, page: 1, pageSize: filters.pageSize ?? 20 } };
    }
    typeFilter = [filters.type];
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    const supabase = await createClient();
    const includeIssued = filters.status !== "not_issued";
    const includeDrafts = !filters.status || filters.status === "not_issued";

    let issuedQuery = supabase
      .from("documents")
      .select(ROW_COLUMNS)
      .eq("clinic_id", user.clinicId)
      .not("issued_at", "is", null)
      .in("doc_type", typeFilter)
      .in("status", filters.status === "cancelled"
        ? ["cancelled", "void"]
        : filters.status === "issued"
          ? ["issued"]
          : ["issued", "cancelled", "void"]);
    if (filters.dateFrom) issuedQuery = issuedQuery.gte("issued_at", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) issuedQuery = issuedQuery.lte("issued_at", `${filters.dateTo}T23:59:59.999Z`);
    if (filters.patientId) issuedQuery = issuedQuery.eq("patient_id", filters.patientId);
    if (filters.employeeId) issuedQuery = issuedQuery.or(`doctor_id.eq.${filters.employeeId},staff_id.eq.${filters.employeeId}`);
    if (filters.creatorId) issuedQuery = issuedQuery.eq("issued_by", filters.creatorId);
    if (filters.documentNumber) issuedQuery = issuedQuery.ilike("document_number", `%${filters.documentNumber}%`);

    let draftQuery = supabase
      .from("document_drafts")
      .select(DRAFT_ROW_COLUMNS)
      .eq("clinic_id", user.clinicId)
      .eq("status", "not_issued")
      .in("doc_type", typeFilter);
    if (filters.dateFrom) draftQuery = draftQuery.gte("updated_at", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) draftQuery = draftQuery.lte("updated_at", `${filters.dateTo}T23:59:59.999Z`);
    if (filters.patientId) draftQuery = draftQuery.eq("patient_id", filters.patientId);
    if (filters.employeeId) draftQuery = draftQuery.or(`doctor_id.eq.${filters.employeeId},staff_id.eq.${filters.employeeId}`);
    if (filters.creatorId) draftQuery = draftQuery.eq("created_by", filters.creatorId);

    const loadDraftRows = async () => {
      if (!includeDrafts || filters.documentNumber) return [];
      try {
        const result = await draftQuery.order("updated_at", { ascending: false }).limit(1000);
        if (result.error) {
          console.error("document_module_draft_list_failed", {
            clinicId: user.clinicId,
            message: result.error.message,
          });
          return [];
        }
        return result.data ?? [];
      } catch (error) {
        console.error("document_module_draft_list_failed", {
          clinicId: user.clinicId,
          message: error instanceof Error ? error.message : "unknown",
        });
        return [];
      }
    };

    const [issuedResult, draftRows] = await Promise.all([
      includeIssued
        ? issuedQuery.order("issued_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      loadDraftRows(),
    ]);
    if (issuedResult.error) throw issuedResult.error;

    const issuedRows = issuedResult.data ?? [];
    const labelRows = [
      ...issuedRows,
      ...draftRows.map((row) => ({
        ...row,
        issued_by: row.created_by,
      })),
    ];
    const labels = await resolveRowLabels(supabase, labelRows);
    const normalizedRows: DocumentModuleRow[] = [
      ...issuedRows
        .filter((row) => isRegisteredDocumentType(row.doc_type))
        .map((row) => ({
          id: row.id,
          docType: row.doc_type as RegisteredDocumentTypeCode,
          documentNumber: row.document_number,
          status: normalizeStatus(row.status) ?? "issued",
          locale: row.locale === "ar" ? "ar" as const : "en" as const,
          subjectName: subjectNameFor(row, labels),
          issuedByName: labels.profileNames.get(row.issued_by) ?? null,
          issuedAt: row.issued_at as string,
          printCount: row.print_count,
          isDraft: false,
          viewHref: `/documents/${row.id}`,
          editHref: null,
        })),
      ...draftRows
        .filter((row) => isRegisteredDocumentType(row.doc_type))
        .map((row) => {
          const docType = row.doc_type as RegisteredDocumentTypeCode;
          const params = row.params as Record<string, unknown>;
          const hrefs = documentDraftHrefs(
            docType,
            row.id,
            params,
            row.locale === "ar" ? "ar" : "en",
          );
          return {
            id: row.id,
            docType,
            documentNumber: null,
            status: "not_issued" as const,
            locale: row.locale === "ar" ? "ar" as const : "en" as const,
            subjectName: subjectNameFor(row, labels),
            issuedByName: labels.profileNames.get(row.created_by) ?? null,
            issuedAt: row.updated_at,
            printCount: 0,
            isDraft: true,
            viewHref: hrefs.previewHref,
            editHref: hrefs.editHref,
          };
        }),
    ].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    const pageRows = normalizedRows.slice(from, to + 1);
    return {
      data: {
        rows: pageRows,
        total: normalizedRows.length,
        page,
        pageSize,
      },
    };
  } catch (error) {
    console.error("document_module_list_failed", {
      clinicId: user.clinicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "listFailed" };
  }
}

export async function getDocumentFilterOptions(): Promise<
  { data: DocumentFilterOptions; errorCode?: never }
  | { data?: never; errorCode: DocumentModuleErrorCode }
> {
  const user = await requireUser();
  try {
    const supabase = await createClient();
    const [patients, staff] = await Promise.all([
      supabase
        .from("patients")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null)
        .order("full_name")
        .limit(500),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("full_name")
        .limit(500),
    ]);
    if (patients.error) throw patients.error;
    if (staff.error) throw staff.error;
    return {
      data: {
        types: getAccessibleDocumentTypeCodes(user.role),
        patients: (patients.data ?? []).map((row) => ({ id: row.id, name: row.full_name })),
        staff: (staff.data ?? []).map((row) => ({ id: row.id, name: row.full_name })),
      },
    };
  } catch (error) {
    console.error("document_module_filter_options_failed", {
      clinicId: user.clinicId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "listFailed" };
  }
}

export async function getClinicDocumentDetail(
  documentId: string,
): Promise<
  { data: DocumentModuleDetail; errorCode?: never }
  | { data?: never; errorCode: DocumentModuleErrorCode }
> {
  const user = await requireUser();
  const parsedId = uuid.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "documentNotFound" };

  try {
    const supabase = await createClient();
    const { data: document, error } = await supabase
      .from("documents")
      .select(
        `${ROW_COLUMNS}, verification_token, page_count`,
      )
      .eq("clinic_id", user.clinicId)
      .eq("id", parsedId.data)
      .maybeSingle();
    if (error) throw error;
    if (
      !document
      || !document.issued_at
      || !document.page_count
      || !isRegisteredDocumentType(document.doc_type)
      || normalizeStatus(document.status) === null
    ) {
      return { errorCode: "documentNotFound" };
    }
    const docType = document.doc_type as RegisteredDocumentTypeCode;
    // Role-aware visibility: never surface a type this role cannot see, even if
    // an RLS subject-scope let the row through.
    if (!getAccessibleDocumentTypeCodes(user.role).includes(docType)) {
      return { errorCode: "documentNotFound" };
    }

    const { data: eventRows, error: eventsError } = await supabase
      .from("document_events")
      .select("id, event, actor_id, occurred_at")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: true });
    if (eventsError) throw eventsError;

    const labels = await resolveRowLabels(supabase, [document]);
    const eventActorIds = Array.from(
      new Set((eventRows ?? []).flatMap((event) => (event.actor_id ? [event.actor_id] : []))),
    ).filter((id) => !labels.profileNames.has(id));
    if (eventActorIds.length > 0) {
      const { data: eventActors } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", eventActorIds);
      for (const actor of eventActors ?? []) labels.profileNames.set(actor.id, actor.full_name);
    }

    return {
      data: {
        id: document.id,
        docType,
        documentNumber: document.document_number,
        status: normalizeStatus(document.status) ?? "issued",
        locale: document.locale === "ar" ? "ar" : "en",
        subjectName: subjectNameFor(document, labels),
        issuedByName: labels.profileNames.get(document.issued_by) ?? null,
        issuedAt: document.issued_at,
        printCount: document.print_count,
        isDraft: false,
        viewHref: `/documents/${document.id}`,
        editHref: null,
        pageCount: document.page_count,
        verificationToken: document.verification_token,
        renderedHref: renderedDocumentHref(docType, document.id),
        events: (eventRows ?? []).map((event) => ({
          id: event.id,
          event: event.event,
          occurredAt: event.occurred_at,
          actorName: event.actor_id ? labels.profileNames.get(event.actor_id) ?? null : null,
        })),
      },
    };
  } catch (error) {
    console.error("document_module_detail_failed", {
      clinicId: user.clinicId,
      documentId,
      ...databaseErrorFields(error),
    });
    return { errorCode: "documentNotFound" };
  }
}

export async function cancelClinicDocument(documentId: string): Promise<
  | { data: { documentId: string; status: "cancelled" }; errorCode?: never }
  | { data?: never; errorCode: DocumentModuleErrorCode }
> {
  const parsedId = uuid.safeParse(documentId);
  if (!parsedId.success) return { errorCode: "invalidInput" };
  const user = await requireMutationUser();

  try {
    const detail = await getClinicDocumentDetail(parsedId.data);
    if (!detail.data) return { errorCode: "documentNotFound" };
    if (detail.data.status === "cancelled") {
      return { data: { documentId: parsedId.data, status: "cancelled" } };
    }
    if (detail.data.status !== "issued") return { errorCode: "cancelFailed" };

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("cancel_issued_document", {
      p_document_id: parsedId.data,
    });
    const row = data?.[0];
    if (error || !row || row.document_status !== "cancelled") {
      throw error ?? new Error("Cancellation did not return a cancelled document");
    }
    revalidatePath("/documents");
    revalidatePath(`/documents/${parsedId.data}`);
    return { data: { documentId: row.document_id, status: "cancelled" } };
  } catch (error) {
    console.error("document_cancel_failed", {
      clinicId: user.clinicId,
      documentId,
      rpc: "cancel_issued_document",
      ...databaseErrorFields(error),
    });
    return { errorCode: "cancelFailed" };
  }
}

type ReprintResult =
  | { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | {
    data?: never;
    errorCode: DocumentActionErrorCode;
    failureStage?: DocumentReprintFailureStage;
  };

export type DocumentModuleReprintFailureStage =
  | DocumentReprintFailureStage
  | "inputValidation"
  | "documentLookup"
  | "registryResolution"
  | "actionDispatch";

/**
 * Reprint dispatch — routes to the archetype's already-built, canonical reprint
 * action (each an append-only RPC that re-serves the stored PDF, bumps
 * `print_count`, and records a `reprinted` event). The module owns no reprint
 * logic of its own.
 */
export async function reprintClinicDocumentFromModule(
  documentId: string,
): Promise<
  { data: { url: string; documentNumber: string; printCount: number }; errorCode?: never }
  | {
    data?: never;
    errorCode: DocumentModuleErrorCode;
    failureStage: DocumentModuleReprintFailureStage;
  }
> {
  const parsedId = uuid.safeParse(documentId);
  if (!parsedId.success) {
    return { errorCode: "invalidInput", failureStage: "inputValidation" };
  }

  // Resolve the type through the access-checked detail read first, so an
  // out-of-scope id never reaches an archetype reprint action.
  const detail = await getClinicDocumentDetail(parsedId.data);
  if (!detail.data) {
    return { errorCode: "documentNotFound", failureStage: "documentLookup" };
  }
  const { docType } = detail.data;

  try {
    let result: ReprintResult;
    if (docType === "REVENUE_REPORT") {
      result = await reprintRevenueReportDocument(parsedId.data);
    } else if (docType === "INVOICE") {
      result = await reprintInvoiceDocument(parsedId.data);
    } else if (ANALYTICAL_CODES.has(docType)) {
      result = await reprintAnalyticalReportDocument(
        parsedId.data,
        docType as P74AnalyticalDocumentCode,
      );
    } else if (ROSTER_PROFILE_CODES.has(docType)) {
      result = await reprintRosterProfileDocument(
        parsedId.data,
        docType as P75RosterProfileDocumentCode,
      );
    } else if (CLINICAL_CODES.has(docType)) {
      const clinical = await reprintClinicalDocument(
        parsedId.data,
        docType as P76ClinicalDocumentCode,
      );
      result = clinical.data
        ? { data: clinical.data }
        : { errorCode: "reprintFailed" };
    } else if (
      P712_PATIENT_HISTORY_DOCUMENT_CODES.includes(
        docType as P712PatientHistoryDocumentCode,
      )
    ) {
      result = await reprintPatientHistoryDocument(
        parsedId.data,
        docType as P712PatientHistoryDocumentCode,
      );
    } else if (docType === "GENERIC_DOCUMENT") {
      result = await reprintGenericDocument(parsedId.data);
    } else {
      console.error("document_module_reprint_failed", {
        documentId,
        documentType: docType,
        stage: "registryResolution",
      });
      return { errorCode: "reprintFailed", failureStage: "registryResolution" };
    }

    if (result.data) return { data: result.data };
    const failureStage = result.failureStage ?? "actionDispatch";
    console.error("document_module_reprint_failed", {
      documentId,
      documentType: docType,
      stage: failureStage,
      sourceErrorCode: result.errorCode,
    });
    return { errorCode: "reprintFailed", failureStage };
  } catch (error) {
    console.error("document_module_reprint_failed", {
      documentId,
      documentType: docType,
      stage: "actionDispatch",
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "reprintFailed", failureStage: "actionDispatch" };
  }
}
