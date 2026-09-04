import "server-only";

import type { z } from "zod";
import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import {
  domainAudit,
  requireDomainMutationSuccess,
  scalarChanges,
} from "@/lib/ai/actions/definitions/domain-shared";
import {
  CLINICAL_MUTATION_ROLES,
  clinicalRecordActionSchema,
  createLabRequestMutation,
  createPrescriptionMutation,
  createSickLeaveMutation,
  labRequestCreateSchema,
  labRequestUpdateSchema,
  prescriptionCreateSchema,
  prescriptionUpdateSchema,
  sickLeaveCreateSchema,
  sickLeaveUpdateSchema,
  transitionClinicalRecordMutation,
  updateLabRequestMutation,
  updatePrescriptionMutation,
  updateSickLeaveMutation,
  type ClinicalMutationData,
  type ClinicalTable,
} from "@/lib/clinical/mutations";
import type {
  DomainMutationMode,
  DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser } from "@/lib/rbac";

type ClinicalCore = (
  user: AuthedUser,
  input: unknown,
  mode?: DomainMutationMode,
) => Promise<DomainMutationResult<ClinicalMutationData>>;

function changes(result: ReturnType<typeof requireDomainMutationSuccess>) {
  const before = result.audit.before as Record<string, unknown> | undefined;
  const after = result.audit.after as Record<string, unknown> | undefined;
  const fields = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).filter(
    (field) =>
      ![
        "clinic_id",
        "created_by",
        "created_at",
        "updated_at",
      ].includes(field),
  );
  return scalarChanges(before, after, fields);
}

function draftAction<TInput>(options: {
  id: string;
  label: { en: string; ar: string };
  description: { en: string; ar: string };
  inputSchema: z.ZodType<TInput>;
  core: ClinicalCore;
  mode: "create" | "update";
}): RegisteredActionDefinition {
  const definition: ActionDefinition<TInput> = {
    id: options.id,
    roles: CLINICAL_MUTATION_ROLES,
    requiredFeatures: ["ai.write_records"],
    risk: "normal",
    pageSlug: "patients",
    inputSchema: options.inputSchema,
    labels: options.label,
    description: options.description,
    inputDescription: {
      en: "The complete validated clinical draft payload.",
      ar: "بيانات المسودة السريرية الكاملة بعد التحقق.",
    },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.label.en,
        summary: `${options.mode === "create" ? "Save" : "Update"} this clinical draft. It remains editable until finalized.`,
        changes: changes(result),
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: `${options.label.en} completed.`,
        data: { id: result.data.id, status: result.data.status },
        audit: domainAudit(result),
      };
    },
  };
  return registerActionDefinition(definition);
}

function transitionAction(options: {
  id: string;
  table: ClinicalTable;
  transition: "finalize" | "void";
  label: { en: string; ar: string };
  description: { en: string; ar: string };
}): RegisteredActionDefinition {
  const definition: ActionDefinition = {
    id: options.id,
    roles: CLINICAL_MUTATION_ROLES,
    requiredFeatures: ["ai.write_records"],
    risk: "sensitive",
    pageSlug: "patients",
    inputSchema: clinicalRecordActionSchema,
    labels: options.label,
    description: options.description,
    inputDescription: { en: "Clinical record id.", ar: "معرف السجل السريري." },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await transitionClinicalRecordMutation(
          user,
          options.table,
          input,
          options.transition,
          "preview",
        ),
      );
      return {
        title: options.label.en,
        summary:
          options.transition === "finalize"
            ? "Finalize this exact clinical record. It will no longer be editable as a draft."
            : "Void this exact finalized clinical record.",
        changes: changes(result),
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await transitionClinicalRecordMutation(
          user,
          options.table,
          input,
          options.transition,
          "execute",
        ),
      );
      return {
        summary: `${options.label.en} completed.`,
        data: { id: result.data.id, status: result.data.status },
        audit: domainAudit(result),
      };
    },
  };
  return registerActionDefinition(definition);
}

const definitions: RegisteredActionDefinition[] = [
  draftAction({
    id: "prescriptions.create_draft",
    label: { en: "Create prescription draft", ar: "إنشاء مسودة وصفة" },
    description: {
      en: "Create an editable prescription draft with validated medications.",
      ar: "إنشاء مسودة وصفة قابلة للتعديل مع أدوية متحقق منها.",
    },
    inputSchema: prescriptionCreateSchema,
    core: createPrescriptionMutation,
    mode: "create",
  }),
  draftAction({
    id: "prescriptions.update_draft",
    label: { en: "Update prescription draft", ar: "تحديث مسودة الوصفة" },
    description: {
      en: "Update a prescription while it is still a draft.",
      ar: "تحديث الوصفة ما دامت مسودة.",
    },
    inputSchema: prescriptionUpdateSchema,
    core: updatePrescriptionMutation,
    mode: "update",
  }),
  transitionAction({
    id: "prescriptions.finalize",
    table: "prescriptions",
    transition: "finalize",
    label: { en: "Finalize prescription", ar: "اعتماد الوصفة" },
    description: {
      en: "Finalize a prescription draft after verifying it has medications.",
      ar: "اعتماد مسودة وصفة بعد التحقق من وجود أدوية.",
    },
  }),
  transitionAction({
    id: "prescriptions.void",
    table: "prescriptions",
    transition: "void",
    label: { en: "Void prescription", ar: "إبطال الوصفة" },
    description: {
      en: "Void one finalized prescription.",
      ar: "إبطال وصفة معتمدة واحدة.",
    },
  }),
  draftAction({
    id: "lab_requests.create_draft",
    label: { en: "Create lab-request draft", ar: "إنشاء مسودة طلب مختبر" },
    description: {
      en: "Create an editable laboratory request draft with validated tests.",
      ar: "إنشاء مسودة طلب مختبر قابلة للتعديل مع فحوص متحقق منها.",
    },
    inputSchema: labRequestCreateSchema,
    core: createLabRequestMutation,
    mode: "create",
  }),
  draftAction({
    id: "lab_requests.update_draft",
    label: { en: "Update lab-request draft", ar: "تحديث مسودة طلب المختبر" },
    description: {
      en: "Update a laboratory request while it is still a draft.",
      ar: "تحديث طلب المختبر ما دام مسودة.",
    },
    inputSchema: labRequestUpdateSchema,
    core: updateLabRequestMutation,
    mode: "update",
  }),
  transitionAction({
    id: "lab_requests.finalize",
    table: "lab_requests",
    transition: "finalize",
    label: { en: "Finalize lab request", ar: "اعتماد طلب المختبر" },
    description: {
      en: "Finalize a laboratory-request draft after verifying it has tests.",
      ar: "اعتماد مسودة طلب مختبر بعد التحقق من وجود فحوص.",
    },
  }),
  transitionAction({
    id: "lab_requests.void",
    table: "lab_requests",
    transition: "void",
    label: { en: "Void lab request", ar: "إبطال طلب المختبر" },
    description: {
      en: "Void one finalized laboratory request.",
      ar: "إبطال طلب مختبر معتمد واحد.",
    },
  }),
  draftAction({
    id: "sick_leaves.create_draft",
    label: { en: "Create sick-leave draft", ar: "إنشاء مسودة إجازة مرضية" },
    description: {
      en: "Create an editable sick-leave draft with validated dates and subject.",
      ar: "إنشاء مسودة إجازة مرضية قابلة للتعديل مع تواريخ وموضوع متحقق منهما.",
    },
    inputSchema: sickLeaveCreateSchema,
    core: createSickLeaveMutation,
    mode: "create",
  }),
  draftAction({
    id: "sick_leaves.update_draft",
    label: { en: "Update sick-leave draft", ar: "تحديث مسودة الإجازة المرضية" },
    description: {
      en: "Update a sick leave while it is still a draft.",
      ar: "تحديث الإجازة المرضية ما دامت مسودة.",
    },
    inputSchema: sickLeaveUpdateSchema,
    core: updateSickLeaveMutation,
    mode: "update",
  }),
  transitionAction({
    id: "sick_leaves.finalize",
    table: "sick_leaves",
    transition: "finalize",
    label: { en: "Finalize sick leave", ar: "اعتماد الإجازة المرضية" },
    description: {
      en: "Finalize one sick-leave draft.",
      ar: "اعتماد مسودة إجازة مرضية واحدة.",
    },
  }),
  transitionAction({
    id: "sick_leaves.void",
    table: "sick_leaves",
    transition: "void",
    label: { en: "Void sick leave", ar: "إبطال الإجازة المرضية" },
    description: {
      en: "Void one finalized sick leave.",
      ar: "إبطال إجازة مرضية معتمدة واحدة.",
    },
  }),
];

export const CLINICAL_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] =
  definitions;
