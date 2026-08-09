"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  getDocumentCatalogEntry,
  isRegisteredDocumentType,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import { documentDraftHrefs } from "@/lib/documents/module";
import { requireMutationUser, requireUser } from "@/lib/rbac";
import {
  createClinicScopedAdminClient,
  saveClinicDocumentDraft,
} from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

const uuid = z.string().uuid();
const draftInputSchema = z.object({
  draftId: uuid.optional().nullable(),
  documentType: z.string(),
  locale: z.enum(["ar", "en"]),
  params: z.record(z.string(), z.unknown()),
  patientId: uuid.optional().nullable(),
  staffId: uuid.optional().nullable(),
  doctorId: uuid.optional().nullable(),
  appointmentId: uuid.optional().nullable(),
});

export type SaveDocumentDraftInput = z.input<typeof draftInputSchema>;

export type ClinicDocumentDraft = {
  id: string;
  documentType: RegisteredDocumentTypeCode;
  locale: "ar" | "en";
  params: Record<string, unknown>;
  patientId: string | null;
  staffId: string | null;
  doctorId: string | null;
  appointmentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  previewHref: string;
  editHref: string;
};

function canAccessType(role: string, code: RegisteredDocumentTypeCode) {
  return (getDocumentCatalogEntry(code).pageRoles as readonly string[]).includes(role);
}

async function resolveReferences(
  user: Awaited<ReturnType<typeof requireUser>>,
  code: RegisteredDocumentTypeCode,
  params: Record<string, unknown>,
  supplied: {
    patientId: string | null;
    staffId: string | null;
    doctorId: string | null;
    appointmentId: string | null;
  },
) {
  const refs = { ...supplied };
  const supabase = await createClient();
  const text = (key: string) => typeof params[key] === "string" ? params[key] as string : null;

  if (code === "INVOICE" && text("appointmentId")) {
    const { data } = await supabase
      .from("appointments")
      .select("id, patient_id, doctor_id")
      .eq("id", text("appointmentId")!)
      .eq("clinic_id", user.clinicId)
      .maybeSingle();
    if (data) {
      refs.appointmentId = data.id;
      refs.patientId = data.patient_id;
      refs.doctorId = data.doctor_id;
    }
  }

  const clinicalTable = code === "PRESCRIPTION"
    ? "prescriptions"
    : code === "LAB_REQUEST"
      ? "lab_requests"
      : code === "SICK_LEAVE_CERTIFICATE"
        ? "sick_leaves"
        : null;
  if (clinicalTable && text("recordId")) {
    const { data } = await supabase
      .from(clinicalTable)
      .select("patient_id, responsible_doctor_id, appointment_id")
      .eq("id", text("recordId")!)
      .eq("clinic_id", user.clinicId)
      .maybeSingle();
    if (data) {
      refs.patientId = data.patient_id;
      refs.doctorId = data.responsible_doctor_id;
      refs.appointmentId = data.appointment_id;
    }
  }

  if (!refs.patientId && text("patientId")) refs.patientId = text("patientId");
  if (!refs.staffId && text("staffId")) refs.staffId = text("staffId");
  if (!refs.doctorId && text("doctor")) refs.doctorId = text("doctor");
  if (!refs.doctorId && text("doctorId")) refs.doctorId = text("doctorId");
  if (!refs.staffId && text("receptionist")) refs.staffId = text("receptionist");
  return refs;
}

export async function saveDocumentDraft(input: SaveDocumentDraftInput): Promise<
  | { data: ClinicDocumentDraft; errorCode?: never }
  | { data?: never; errorCode: "invalidInput" | "forbidden" | "saveFailed" }
> {
  const parsed = draftInputSchema.safeParse(input);
  if (!parsed.success || !isRegisteredDocumentType(parsed.data.documentType)) {
    return { errorCode: "invalidInput" };
  }
  const user = await requireMutationUser();
  const documentType = parsed.data.documentType;
  if (!canAccessType(user.role, documentType)) return { errorCode: "forbidden" };

  try {
    if (parsed.data.draftId) {
      const existing = await getClinicDocumentDraft(parsed.data.draftId);
      if (!existing.data || existing.data.documentType !== documentType) {
        return { errorCode: "forbidden" };
      }
    }
    const refs = await resolveReferences(user, documentType, parsed.data.params, {
      patientId: parsed.data.patientId ?? null,
      staffId: parsed.data.staffId ?? null,
      doctorId: parsed.data.doctorId ?? null,
      appointmentId: parsed.data.appointmentId ?? null,
    });
    const result = await saveClinicDocumentDraft({
      draftId: parsed.data.draftId,
      clinicId: user.clinicId,
      actorId: user.id,
      documentType,
      locale: parsed.data.locale,
      params: parsed.data.params as Json,
      ...refs,
    });
    if (result.error || !result.data) throw result.error ?? new Error("Draft was not saved");
    const hrefs = documentDraftHrefs(
      documentType,
      result.data.id,
      parsed.data.params,
      parsed.data.locale,
    );
    revalidatePath("/documents");
    return {
      data: {
        id: result.data.id,
        documentType,
        locale: parsed.data.locale,
        params: parsed.data.params,
        patientId: result.data.patient_id,
        staffId: result.data.staff_id,
        doctorId: result.data.doctor_id,
        appointmentId: result.data.appointment_id,
        createdBy: result.data.created_by,
        createdAt: result.data.created_at,
        updatedAt: result.data.updated_at,
        ...hrefs,
      },
    };
  } catch (error) {
    console.error("document_draft_save_failed", {
      clinicId: user.clinicId,
      documentType,
      draftId: parsed.data.draftId ?? null,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { errorCode: "saveFailed" };
  }
}

export async function getClinicDocumentDraft(draftId: string): Promise<
  | { data: ClinicDocumentDraft; errorCode?: never }
  | { data?: never; errorCode: "notFound" }
> {
  const parsedId = uuid.safeParse(draftId);
  if (!parsedId.success) return { errorCode: "notFound" };
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("document_drafts")
    .select("*")
    .eq("id", parsedId.data)
    .eq("clinic_id", user.clinicId)
    .eq("status", "not_issued")
    .maybeSingle();
  if (error || !data || !isRegisteredDocumentType(data.doc_type)) {
    return { errorCode: "notFound" };
  }
  if (!canAccessType(user.role, data.doc_type)) return { errorCode: "notFound" };
  const params = data.params as Record<string, unknown>;
  return {
    data: {
      id: data.id,
      documentType: data.doc_type,
      locale: data.locale === "ar" ? "ar" : "en",
      params,
      patientId: data.patient_id,
      staffId: data.staff_id,
      doctorId: data.doctor_id,
      appointmentId: data.appointment_id,
      createdBy: data.created_by,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      ...documentDraftHrefs(
        data.doc_type,
        data.id,
        params,
        data.locale === "ar" ? "ar" : "en",
      ),
    },
  };
}

export async function deleteDocumentDraft(draftId: string): Promise<
  { data: { id: string }; errorCode?: never }
  | { data?: never; errorCode: "notFound" | "deleteFailed" }
> {
  const parsedId = uuid.safeParse(draftId);
  if (!parsedId.success) return { errorCode: "notFound" };
  const user = await requireMutationUser();
  const existing = await getClinicDocumentDraft(parsedId.data);
  if (!existing.data) return { errorCode: "notFound" };
  const now = new Date().toISOString();
  const { data, error } = await createClinicScopedAdminClient(user.clinicId)
    .from("document_drafts")
    .update({ status: "deleted", deleted_at: now, resolved_at: now, updated_by: user.id })
    .eq("id", parsedId.data)
    .eq("clinic_id", user.clinicId)
    .eq("status", "not_issued")
    .select("id")
    .maybeSingle();
  if (error) return { errorCode: "deleteFailed" };
  if (!data) return { errorCode: "notFound" };
  revalidatePath("/documents");
  return { data };
}
