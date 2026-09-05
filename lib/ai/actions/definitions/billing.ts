import "server-only";

import type { z } from "zod";
import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import {
  domainAudit,
  patientIdentifier,
  requireDomainMutationSuccess,
  scalarChanges,
} from "@/lib/ai/actions/definitions/domain-shared";
import {
  addPatientDepositMutation,
  APPOINTMENT_BILLING_ROLES,
  appointmentCompletionSchema,
  BILLING_UNDO_ROLES,
  billingAppointmentIdSchema,
  completeAppointmentBillingMutation,
  createPackageTemplateMutation,
  createPatientPackageMutation,
  deactivatePatientPackageMutation,
  deletePackageTemplateMutation,
  outstandingSettlementSchema,
  PACKAGE_TEMPLATE_ROLES,
  patientDepositSchema,
  PATIENT_BILLING_ROLES,
  sendInvoiceToPatientMutation,
  setPackageTemplateActiveMutation,
  settleOutstandingMutation,
  undoAppointmentBillingMutation,
  updatePackageTemplateMutation,
  updatePatientPackageMutation,
} from "@/lib/billing/mutations";
import type {
  DomainMutationMode,
  DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import {
  createPatientPackageSchema,
  deactivatePatientPackageSchema,
  updatePatientPackageSchema,
} from "@/lib/validations/patient-package";
import {
  createPackageTemplateSchema,
  templateIdSchema,
  updatePackageTemplateSchema,
} from "@/lib/validations/package-template";

type BillingCore = (
  user: AuthedUser,
  input: unknown,
  mode?: DomainMutationMode,
) => Promise<DomainMutationResult<Record<string, unknown>>>;

function changes(result: ReturnType<typeof requireDomainMutationSuccess>) {
  const before = result.audit.before as Record<string, unknown> | undefined;
  const after = result.audit.after as Record<string, unknown> | undefined;
  const fields = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).filter(
    (field) => !["clinic_id", "created_by", "updated_by"].includes(field),
  );
  return scalarChanges(before, after, fields);
}

function billingAppointmentIdentifier(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Unknown billing appointment";
  }
  const row = value as Record<string, unknown>;
  const patient = patientIdentifier({
    id: row.patient_id,
    full_name: row.patient_name,
    file_number: row.patient_file_number,
  });
  const appointmentId =
    typeof row.id === "string" ? row.id : "unknown appointment id";
  return `${patient}; appointment record ${appointmentId}`;
}

function mutationAction<T>(options: {
  id: string;
  roles: readonly UserRole[];
  feature: "ai.write_records" | "ai.write_administration";
  risk: "normal" | "sensitive" | "destructive";
  pageSlug: "patients" | "appointments" | "settings";
  schema: z.ZodType<T>;
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  previewSummary: string;
  completedSummary: string;
  core: BillingCore;
  identifyRecord?: (
    result: ReturnType<typeof requireDomainMutationSuccess>,
  ) => { label: string; before: string; after: string; identifiesRecord: true };
}): RegisteredActionDefinition {
  const definition: ActionDefinition<T> = {
    id: options.id,
    roles: options.roles,
    requiredFeatures: [options.feature],
    risk: options.risk,
    pageSlug: options.pageSlug,
    inputSchema: options.schema,
    labels: options.labels,
    description: options.description,
    inputDescription: {
      en: "The complete validated mutation input.",
      ar: "بيانات التعديل الكاملة بعد التحقق.",
    },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.labels.en,
        summary: options.previewSummary,
        changes: [
          ...(options.identifyRecord ? [options.identifyRecord(result)] : []),
          ...changes(result).map((change) =>
            options.risk === "destructive" && change.label === "name"
              ? {
                  ...change,
                  before:
                    typeof change.before === "string"
                      ? `Package template ${change.before}`
                      : change.before,
                  after:
                    typeof change.after === "string"
                      ? `Package template ${change.after}`
                      : change.after,
                  identifiesRecord: true as const,
                }
              : change,
          ),
        ],
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: options.completedSummary,
        data: result.data,
        audit: domainAudit(result),
      };
    },
  };
  return registerActionDefinition(definition);
}

const definitions: RegisteredActionDefinition[] = [
  mutationAction({
    id: "billing.add_deposit",
    roles: PATIENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "sensitive",
    pageSlug: "patients",
    schema: patientDepositSchema,
    labels: { en: "Record patient deposit", ar: "تسجيل عربون المريض" },
    description: {
      en: "Record one patient account deposit.",
      ar: "تسجيل عربون واحد في حساب المريض.",
    },
    previewSummary: "Record this exact deposit and payment method.",
    completedSummary: "Patient deposit recorded.",
    core: addPatientDepositMutation as BillingCore,
  }),
  mutationAction({
    id: "billing.settle_outstanding",
    roles: PATIENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "sensitive",
    pageSlug: "patients",
    schema: outstandingSettlementSchema,
    labels: { en: "Settle outstanding balance", ar: "تسوية الرصيد المستحق" },
    description: {
      en: "Record one authorized patient outstanding-balance settlement.",
      ar: "تسجيل تسوية واحدة مصرح بها لرصيد مريض مستحق.",
    },
    previewSummary: "Apply this exact settlement and payment split.",
    completedSummary: "Outstanding balance settled.",
    core: settleOutstandingMutation as BillingCore,
  }),
  mutationAction({
    id: "patient_packages.create",
    roles: PATIENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "normal",
    pageSlug: "patients",
    schema: createPatientPackageSchema,
    labels: { en: "Create patient package", ar: "إنشاء باقة مريض" },
    description: {
      en: "Create a patient package with validated patient, department, and service references.",
      ar: "إنشاء باقة مريض مع التحقق من المريض والقسم والخدمة.",
    },
    previewSummary: "Create this patient package.",
    completedSummary: "Patient package created.",
    core: createPatientPackageMutation as BillingCore,
  }),
  mutationAction({
    id: "patient_packages.update",
    roles: PATIENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "normal",
    pageSlug: "patients",
    schema: updatePatientPackageSchema,
    labels: { en: "Update patient package", ar: "تحديث باقة المريض" },
    description: {
      en: "Update a patient package without reducing total sessions below sessions already used.",
      ar: "تحديث باقة مريض دون خفض الجلسات الإجمالية عن الجلسات المستخدمة.",
    },
    previewSummary: "Apply these package changes.",
    completedSummary: "Patient package updated.",
    core: updatePatientPackageMutation as BillingCore,
  }),
  mutationAction({
    id: "patient_packages.deactivate",
    roles: PATIENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "normal",
    pageSlug: "patients",
    schema: deactivatePatientPackageSchema,
    labels: { en: "Deactivate patient package", ar: "تعطيل باقة المريض" },
    description: {
      en: "Deactivate one patient package.",
      ar: "تعطيل باقة مريض واحدة.",
    },
    previewSummary: "Deactivate this patient package.",
    completedSummary: "Patient package deactivated.",
    core: deactivatePatientPackageMutation as BillingCore,
  }),
  mutationAction({
    id: "package_templates.create",
    roles: PACKAGE_TEMPLATE_ROLES,
    feature: "ai.write_administration",
    risk: "normal",
    pageSlug: "settings",
    schema: createPackageTemplateSchema,
    labels: { en: "Create package template", ar: "إنشاء قالب باقة" },
    description: {
      en: "Create an administrative patient-package template.",
      ar: "إنشاء قالب إداري لباقات المرضى.",
    },
    previewSummary: "Create this package template.",
    completedSummary: "Package template created.",
    core: createPackageTemplateMutation as BillingCore,
  }),
  mutationAction({
    id: "package_templates.update",
    roles: PACKAGE_TEMPLATE_ROLES,
    feature: "ai.write_administration",
    risk: "normal",
    pageSlug: "settings",
    schema: updatePackageTemplateSchema,
    labels: { en: "Update package template", ar: "تحديث قالب الباقة" },
    description: {
      en: "Update one package template.",
      ar: "تحديث قالب باقة واحد.",
    },
    previewSummary: "Apply these package-template changes.",
    completedSummary: "Package template updated.",
    core: updatePackageTemplateMutation as BillingCore,
  }),
  mutationAction({
    id: "package_templates.deactivate",
    roles: PACKAGE_TEMPLATE_ROLES,
    feature: "ai.write_administration",
    risk: "normal",
    pageSlug: "settings",
    schema: templateIdSchema,
    labels: { en: "Deactivate package template", ar: "تعطيل قالب الباقة" },
    description: {
      en: "Deactivate one package template.",
      ar: "تعطيل قالب باقة واحد.",
    },
    previewSummary: "Deactivate this package template.",
    completedSummary: "Package template deactivated.",
    core: ((user, input, mode) =>
      setPackageTemplateActiveMutation(user, input, false, mode)) as BillingCore,
  }),
  mutationAction({
    id: "package_templates.restore",
    roles: PACKAGE_TEMPLATE_ROLES,
    feature: "ai.write_administration",
    risk: "normal",
    pageSlug: "settings",
    schema: templateIdSchema,
    labels: { en: "Restore package template", ar: "استعادة قالب الباقة" },
    description: {
      en: "Restore one inactive package template.",
      ar: "استعادة قالب باقة غير نشط واحد.",
    },
    previewSummary: "Restore this package template.",
    completedSummary: "Package template restored.",
    core: ((user, input, mode) =>
      setPackageTemplateActiveMutation(user, input, true, mode)) as BillingCore,
  }),
  mutationAction({
    id: "package_templates.delete",
    roles: PACKAGE_TEMPLATE_ROLES,
    feature: "ai.write_administration",
    risk: "destructive",
    pageSlug: "settings",
    schema: templateIdSchema,
    labels: { en: "Delete package template", ar: "حذف قالب الباقة" },
    description: {
      en: "Permanently delete one inactive package template.",
      ar: "حذف قالب باقة غير نشط واحد نهائياً.",
    },
    previewSummary: "Permanently delete this exact inactive template.",
    completedSummary: "Package template deleted.",
    core: deletePackageTemplateMutation as BillingCore,
  }),
  mutationAction({
    id: "billing.complete_appointment",
    roles: APPOINTMENT_BILLING_ROLES,
    feature: "ai.write_records",
    risk: "sensitive",
    pageSlug: "appointments",
    schema: appointmentCompletionSchema,
    labels: { en: "Complete appointment billing", ar: "إتمام فوترة الموعد" },
    description: {
      en: "Complete one appointment with an exact invoice and payment allocation.",
      ar: "إتمام موعد واحد بفاتورة وتوزيع دفعات محددين.",
    },
    previewSummary: "Complete this appointment with the exact invoice and payment allocation shown.",
    completedSummary: "Appointment billing completed.",
    core: completeAppointmentBillingMutation as BillingCore,
  }),
  mutationAction({
    id: "billing.undo_appointment_completion",
    roles: BILLING_UNDO_ROLES,
    feature: "ai.write_records",
    risk: "destructive",
    pageSlug: "appointments",
    schema: billingAppointmentIdSchema,
    labels: { en: "Undo invoice completion", ar: "التراجع عن إتمام الفاتورة" },
    description: {
      en: "Undo one eligible recent appointment billing completion.",
      ar: "التراجع عن إتمام فوترة موعد حديث مؤهل واحد.",
    },
    previewSummary: "Remove this invoice allocation and restore the prior appointment status.",
    completedSummary: "Appointment billing completion undone.",
    core: undoAppointmentBillingMutation as BillingCore,
    identifyRecord: (result) => ({
      label: "appointment",
      before: billingAppointmentIdentifier(result.audit.before),
      after: billingAppointmentIdentifier(result.audit.after),
      identifiesRecord: true,
    }),
  }),
  mutationAction({
    id: "billing.send_invoice",
    roles: BILLING_UNDO_ROLES,
    feature: "ai.write_records",
    risk: "sensitive",
    pageSlug: "appointments",
    schema: billingAppointmentIdSchema,
    labels: { en: "Send invoice to patient", ar: "إرسال الفاتورة إلى المريض" },
    description: {
      en: "Send one completed appointment invoice through its available patient channels.",
      ar: "إرسال فاتورة موعد مكتمل واحد عبر قنوات المريض المتاحة.",
    },
    previewSummary: "Send this exact invoice to the named patient and destinations shown.",
    completedSummary: "Invoice sent or already delivered on available channels.",
    core: sendInvoiceToPatientMutation as BillingCore,
  }),
];

export const BILLING_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] =
  definitions;
