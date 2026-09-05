import "server-only";

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
  addMedicalNoteMutation,
  archivePatientMutation,
  createPatientMutation,
  deleteMedicalNoteMutation,
  MEDICAL_NOTE_WRITE_ROLES,
  medicalNoteCreateSchema,
  medicalNoteIdSchema,
  medicalNoteUpdateSchema,
  PATIENT_ADMIN_ROLES,
  PATIENT_WRITE_ROLES,
  patientCreateSchema,
  patientIdSchema,
  patientUpdateSchema,
  restoreMedicalNoteMutation,
  restorePatientMutation,
  softDeletePatientMutation,
  updateMedicalNoteMutation,
  updatePatientMutation,
} from "@/lib/patients/mutations";

function auditChanges(
  result: ReturnType<typeof requireDomainMutationSuccess>,
  fields: readonly string[],
) {
  return scalarChanges(
    result.audit.before as Record<string, unknown> | undefined,
    result.audit.after as Record<string, unknown> | undefined,
    fields,
  );
}

const createPatient: ActionDefinition = {
  id: "patients.create",
  roles: PATIENT_WRITE_ROLES,
  requiredFeatures: ["ai.write_records"],
  risk: "normal",
  pageSlug: "patients",
  inputSchema: patientCreateSchema,
  labels: { en: "Create patient", ar: "إنشاء مريض" },
  description: {
    en: "Create a patient with the same identity, phone, assignment, and insurance validation as the patient form.",
    ar: "إنشاء مريض مع تحقق الهوية والهاتف والإسناد والتأمين نفسه المستخدم في نموذج المريض.",
  },
  inputDescription: {
    en: "Patient identity, contact, clinical demographics, assignment, and insurance.",
    ar: "هوية المريض وبيانات الاتصال والبيانات السريرية والإسناد والتأمين.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await createPatientMutation(user, input, "preview"),
    );
    return {
      title: "Create patient",
      summary: "Create this patient record.",
      changes: auditChanges(result, [
        "full_name",
        "national_id",
        "date_of_birth",
        "phone",
        "email",
        "blood_type",
        "department_id",
        "assigned_doctor_id",
        "insurance_provider_id",
        "file_number",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await createPatientMutation(user, input, "execute"),
    );
    return {
      summary: "Patient created.",
      data: {
        patient_id: result.data.patient_id,
        file_number: result.data.file_number,
      },
      audit: domainAudit(result),
    };
  },
};

const updatePatient: ActionDefinition = {
  ...createPatient,
  id: "patients.update",
  inputSchema: patientUpdateSchema,
  labels: { en: "Update patient", ar: "تحديث المريض" },
  description: {
    en: "Update one active patient record.",
    ar: "تحديث سجل مريض نشط واحد.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await updatePatientMutation(user, input, "preview"),
    );
    return {
      title: "Update patient",
      summary: "Apply these patient changes.",
      changes: auditChanges(result, [
        "full_name",
        "national_id",
        "date_of_birth",
        "phone",
        "email",
        "blood_type",
        "department_id",
        "assigned_doctor_id",
        "insurance_provider_id",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await updatePatientMutation(user, input, "execute"),
    );
    return {
      summary: "Patient updated.",
      data: { patient_id: result.data.patient_id },
      audit: domainAudit(result),
    };
  },
};

function patientLifecycleAction(options: {
  id: string;
  roles: readonly (typeof PATIENT_WRITE_ROLES)[number][];
  risk: "normal" | "destructive";
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  summary: string;
  completed: string;
  core: typeof softDeletePatientMutation;
}): ActionDefinition {
  return {
    id: options.id,
    roles: options.roles,
    requiredFeatures: ["ai.write_records"],
    risk: options.risk,
    pageSlug: "patients",
    inputSchema: patientIdSchema,
    labels: options.labels,
    description: options.description,
    inputDescription: { en: "Patient id.", ar: "معرف المريض." },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.labels.en,
        summary: options.summary,
        changes: [
          {
            label: "patient",
            before: patientIdentifier(result.audit.before),
            after: patientIdentifier(result.audit.after),
            identifiesRecord: true,
          },
          ...auditChanges(result, [
            "is_deleted",
            "deleted_at",
            "is_archived",
            "archived_at",
          ]),
        ],
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: options.completed,
        data: { patient_id: result.data.patient_id },
        audit: domainAudit(result),
      };
    },
  };
}

const softDeletePatient = patientLifecycleAction({
  id: "patients.soft_delete",
  roles: PATIENT_WRITE_ROLES,
  risk: "destructive",
  labels: { en: "Move patient to trash", ar: "نقل المريض إلى المهملات" },
  description: {
    en: "Soft-delete one patient using the application's patient cascade.",
    ar: "حذف مريض واحد مؤقتاً باستخدام مسار الحذف المعتمد في التطبيق.",
  },
  summary: "Move this exact patient to trash.",
  completed: "Patient moved to trash.",
  core: softDeletePatientMutation,
});

const restorePatient = patientLifecycleAction({
  id: "patients.restore",
  roles: PATIENT_ADMIN_ROLES,
  risk: "normal",
  labels: { en: "Restore patient", ar: "استعادة المريض" },
  description: {
    en: "Restore one patient from trash or archive.",
    ar: "استعادة مريض واحد من المهملات أو الأرشيف.",
  },
  summary: "Restore this exact patient.",
  completed: "Patient restored.",
  core: restorePatientMutation,
});

const archivePatient = patientLifecycleAction({
  id: "patients.archive",
  roles: PATIENT_ADMIN_ROLES,
  risk: "destructive",
  labels: { en: "Archive patient", ar: "أرشفة المريض" },
  description: {
    en: "Archive one patient already in trash.",
    ar: "أرشفة مريض واحد موجود في المهملات.",
  },
  summary: "Archive this exact patient.",
  completed: "Patient archived.",
  core: archivePatientMutation,
});

const addMedicalNote: ActionDefinition = {
  id: "medical_notes.create",
  roles: MEDICAL_NOTE_WRITE_ROLES,
  requiredFeatures: ["ai.write_records"],
  risk: "normal",
  pageSlug: "patients",
  inputSchema: medicalNoteCreateSchema,
  labels: { en: "Add medical note", ar: "إضافة ملاحظة طبية" },
  description: {
    en: "Add a medical note to an authorized active patient.",
    ar: "إضافة ملاحظة طبية لمريض نشط ومصرح به.",
  },
  inputDescription: {
    en: "Patient, optional appointment, and note text.",
    ar: "المريض والموعد الاختياري ونص الملاحظة.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await addMedicalNoteMutation(user, input, "preview"),
    );
    return {
      title: "Add medical note",
      summary: "Add this exact clinical note to the patient record.",
      changes: auditChanges(result, ["patient_id", "appointment_id", "note"]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await addMedicalNoteMutation(user, input, "execute"),
    );
    return {
      summary: "Medical note added.",
      data: {
        note_id: result.data.note_id,
        patient_id: result.data.patient_id,
      },
      audit: domainAudit(result),
    };
  },
};

const updateMedicalNote: ActionDefinition = {
  ...addMedicalNote,
  id: "medical_notes.update",
  inputSchema: medicalNoteUpdateSchema,
  labels: { en: "Update medical note", ar: "تحديث الملاحظة الطبية" },
  description: {
    en: "Update an authorized existing medical note.",
    ar: "تحديث ملاحظة طبية موجودة ومصرح بها.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await updateMedicalNoteMutation(user, input, "preview"),
    );
    return {
      title: "Update medical note",
      summary: "Replace the note text with this exact content.",
      changes: auditChanges(result, ["note"]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await updateMedicalNoteMutation(user, input, "execute"),
    );
    return {
      summary: "Medical note updated.",
      data: { note_id: result.data.note_id },
      audit: domainAudit(result),
    };
  },
};

function noteLifecycleAction(options: {
  id: string;
  risk: "normal" | "destructive";
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  summary: string;
  completed: string;
  core: typeof deleteMedicalNoteMutation;
}): ActionDefinition {
  return {
    id: options.id,
    roles: MEDICAL_NOTE_WRITE_ROLES,
    requiredFeatures: ["ai.write_records"],
    risk: options.risk,
    pageSlug: "patients",
    inputSchema: medicalNoteIdSchema,
    labels: options.labels,
    description: options.description,
    inputDescription: { en: "Medical note id.", ar: "معرف الملاحظة الطبية." },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      const changes = auditChanges(result, ["note", "deleted_at"]);
      const before = result.audit.before as Record<string, unknown> | undefined;
      return {
        title: options.labels.en,
        summary: options.summary,
        changes:
          options.risk === "destructive"
            ? [
                {
                  label: "medical note",
                  before: `Medical note “${String(before?.note ?? "")}” (record ${String(before?.id ?? "unknown id")})`,
                  after: "Moved to trash",
                  identifiesRecord: true as const,
                },
                ...changes.filter((change) => change.label === "deleted_at"),
              ]
            : changes,
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: options.completed,
        data: { note_id: result.data.note_id },
        audit: domainAudit(result),
      };
    },
  };
}

const deleteMedicalNote = noteLifecycleAction({
  id: "medical_notes.delete",
  risk: "destructive",
  labels: { en: "Delete medical note", ar: "حذف الملاحظة الطبية" },
  description: {
    en: "Move one authorized medical note to trash.",
    ar: "نقل ملاحظة طبية واحدة مصرح بها إلى المهملات.",
  },
  summary: "Move this exact medical note to trash.",
  completed: "Medical note moved to trash.",
  core: deleteMedicalNoteMutation,
});

const restoreMedicalNote = noteLifecycleAction({
  id: "medical_notes.restore",
  risk: "normal",
  labels: { en: "Restore medical note", ar: "استعادة الملاحظة الطبية" },
  description: {
    en: "Restore one authorized medical note from trash.",
    ar: "استعادة ملاحظة طبية واحدة مصرح بها من المهملات.",
  },
  summary: "Restore this exact medical note.",
  completed: "Medical note restored.",
  core: restoreMedicalNoteMutation,
});

export const PATIENT_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] =
  [
    createPatient,
    updatePatient,
    softDeletePatient,
    restorePatient,
    archivePatient,
    addMedicalNote,
    updateMedicalNote,
    deleteMedicalNote,
    restoreMedicalNote,
  ].map(registerActionDefinition);
