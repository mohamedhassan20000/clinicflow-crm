import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { stripBlankDisplayNames } from "@/lib/settings/display-names";
import {
  computeBillingUndoEligibility,
  type BillingUndoActivityEvent,
} from "@/lib/appointments/billing-undo";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ensureInvoiceFollowupSequence } from "@/lib/messaging/followups";
import { deliverIssuedInvoice } from "@/lib/messaging/invoice-delivery";
import {
  billingSchema,
  depositSchema,
  paymentMethodSchema,
} from "@/lib/validations/appointment";
import {
  createPatientPackageSchema,
  deactivatePatientPackageSchema,
  updatePatientPackageSchema,
} from "@/lib/validations/patient-package";
import {
  createPackageTemplateSchema,
  packageItemsSessions,
  packageItemsTotal,
  templateIdSchema,
  updatePackageTemplateSchema,
  type PackageTemplateItemValues,
} from "@/lib/validations/package-template";

export const PATIENT_BILLING_ROLES = ["admin", "receptionist"] as const;
export const PACKAGE_TEMPLATE_ROLES = ["admin"] as const;
export const APPOINTMENT_BILLING_ROLES = [
  "admin",
  "receptionist",
  "manager",
  "assistant",
] as const;
export const BILLING_UNDO_ROLES = ["admin", "receptionist", "manager"] as const;

export const patientDepositSchema = depositSchema.strict();
export const appointmentCompletionSchema = z
  .object({ appointment_id: z.string().uuid(), billing: billingSchema })
  .strict();
export const billingAppointmentIdSchema = z
  .object({ appointment_id: z.string().uuid() })
  .strict();
export const outstandingSettlementSchema = z
  .object({
    patient_id: z.string().uuid(),
    appointment_id: z.string().uuid().nullable().optional(),
    amount: z.number().positive(),
    payment_method: paymentMethodSchema,
    secondary_amount: z.number().nonnegative().default(0),
    secondary_payment_method: paymentMethodSchema.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.secondary_amount > 0 && !value.secondary_payment_method) {
      context.addIssue({
        code: "custom",
        path: ["secondary_payment_method"],
        message: "validation.required",
      });
    }
    if (
      value.secondary_amount > 0 &&
      value.secondary_payment_method === value.payment_method
    ) {
      context.addIssue({
        code: "custom",
        path: ["secondary_payment_method"],
        message: "validation.invalidFormat",
      });
    }
  });

type BillingMutationData = {
  id?: string;
  patient_id?: string;
  appointment_id?: string;
  status?: string;
  eligibility?: ReturnType<typeof computeBillingUndoEligibility>;
  rpc?: string;
};

export async function addPatientDepositMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PATIENT_BILLING_ROLES);
  const parsed = patientDepositSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patients.failedToAddDeposit", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const patient = await supabase
    .from("patients")
    .select("id, full_name")
    .eq("id", parsed.data.patient_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (patient.error || !patient.data)
    return domainFailure("patients.patientNotFound");
  const next = {
    patient_id: parsed.data.patient_id,
    clinic_id: user.clinicId,
    amount: Number(parsed.data.amount.toFixed(2)),
    payment_method: parsed.data.payment_method,
    note: parsed.data.note?.trim() || null,
    created_by: user.id,
  };
  if (mode === "preview") {
    return domainSuccess(
      { patient_id: parsed.data.patient_id },
      {
        targetTable: "patient_deposits",
        after: { ...next, patient_name: patient.data.full_name },
      },
    );
  }
  const inserted = await supabase
    .from("patient_deposits")
    .insert(next)
    .select("id")
    .single();
  if (inserted.error) return domainFailure("patients.failedToAddDeposit");
  revalidatePath(`/patients/${parsed.data.patient_id}`);
  return domainSuccess(
    { id: inserted.data.id, patient_id: parsed.data.patient_id },
    {
      targetTable: "patient_deposits",
      targetRecordIds: [inserted.data.id],
      after: { ...next, id: inserted.data.id },
    },
  );
}

export async function settleOutstandingMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PATIENT_BILLING_ROLES);
  const raw = input as Record<string, unknown>;
  if (!raw?.patient_id) return domainFailure("patients.missingPatient");
  if (!Number.isFinite(raw.amount) || Number(raw.amount) <= 0)
    return domainFailure("patients.amountMustBeGreaterThanZero");
  if (!paymentMethodSchema.safeParse(raw.payment_method).success)
    return domainFailure("patients.selectAValidPaymentMethod");
  const hasValidSecondary =
    Number.isFinite(raw.secondary_amount) &&
    Number(raw.secondary_amount) > 0 &&
    paymentMethodSchema.safeParse(raw.secondary_payment_method).success;
  if (hasValidSecondary && raw.secondary_payment_method === raw.payment_method)
    return domainFailure("patients.splitMethodsMustDifferFromThePrimaryMethod");
  const parsed = outstandingSettlementSchema.safeParse({
    ...raw,
    secondary_amount: hasValidSecondary ? Number(raw.secondary_amount) : 0,
    secondary_payment_method: hasValidSecondary
      ? raw.secondary_payment_method
      : null,
  });
  if (!parsed.success)
    return domainFailure("patients.failedToSaveSettlement", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  let patientName: string | null = null;
  if (mode === "preview") {
    const patient = await supabase
      .from("patients")
      .select("id, full_name")
      .eq("id", parsed.data.patient_id)
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false)
      .maybeSingle();
    if (patient.error || !patient.data)
      return domainFailure("patients.patientNotFound");
    patientName = patient.data.full_name;
  }
  if (mode === "preview" && parsed.data.appointment_id) {
    const appointment = await supabase
      .from("appointments")
      .select("id, outstanding_amount")
      .eq("id", parsed.data.appointment_id)
      .eq("patient_id", parsed.data.patient_id)
      .eq("clinic_id", user.clinicId)
      .gt("outstanding_amount", 0)
      .maybeSingle();
    if (appointment.error || !appointment.data)
      return domainFailure("patients.failedToSaveSettlement");
  }
  const snapshot = {
    patient_id: parsed.data.patient_id,
    patient_name: patientName,
    appointment_id: parsed.data.appointment_id ?? null,
    amount: Number(parsed.data.amount.toFixed(2)),
    payment_method: parsed.data.payment_method,
    secondary_amount: Number(parsed.data.secondary_amount.toFixed(2)),
    secondary_payment_method:
      parsed.data.secondary_amount > 0
        ? parsed.data.secondary_payment_method
        : null,
    note: parsed.data.note?.trim() || null,
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        patient_id: parsed.data.patient_id,
        appointment_id: parsed.data.appointment_id ?? undefined,
      },
      { targetTable: "outstanding_settlements", after: snapshot },
    );
  }
  const settled = await supabase.rpc("settle_patient_outstanding", {
    p_patient_id: snapshot.patient_id,
    p_appointment_id: snapshot.appointment_id ?? undefined,
    p_amount: snapshot.amount,
    p_payment_method: snapshot.payment_method,
    p_secondary_amount: snapshot.secondary_amount,
    p_secondary_payment_method:
      snapshot.secondary_payment_method ?? undefined,
    p_note: snapshot.note ?? undefined,
  });
  if (settled.error)
    return domainFailure("patients.failedToSaveSettlement");
  revalidatePath(`/patients/${snapshot.patient_id}`);
  return domainSuccess(
    {
      patient_id: snapshot.patient_id,
      appointment_id: snapshot.appointment_id ?? undefined,
    },
    { targetTable: "outstanding_settlements", after: snapshot },
  );
}

async function validatePatientPackageReferences(input: {
  patientId?: string;
  clinicId: string;
  departmentId: string | null;
  serviceId: string | null;
}) {
  const supabase = await createClient();
  if (input.patientId) {
    const patient = await supabase
      .from("patients")
      .select("id")
      .eq("id", input.patientId)
      .eq("clinic_id", input.clinicId)
      .eq("is_deleted", false)
      .maybeSingle();
    if (patient.error || !patient.data)
      return domainFailure("patient-packages.patientNotFound");
  }
  if (input.departmentId) {
    const department = await supabase
      .from("departments")
      .select("id")
      .eq("id", input.departmentId)
      .eq("clinic_id", input.clinicId)
      .maybeSingle();
    if (department.error)
      return domainFailure("patient-packages.failedToValidateDepartment");
    if (!department.data)
      return domainFailure("patient-packages.selectADepartmentFromThisClinic");
  }
  if (input.serviceId) {
    const service = await supabase
      .from("services")
      .select("id, department_id")
      .eq("id", input.serviceId)
      .eq("clinic_id", input.clinicId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (service.error)
      return domainFailure("patient-packages.failedToValidateService");
    if (!service.data)
      return domainFailure(
        "patient-packages.selectAnActiveServiceFromThisClinic",
      );
    if (
      input.departmentId &&
      service.data.department_id !== input.departmentId
    ) {
      return domainFailure(
        "patient-packages.selectAServiceThatBelongsToTheSelectedDepartment",
      );
    }
  }
  return null;
}

function refreshPatientPackage(patientId: string) {
  revalidatePath(`/patients/${patientId}`);
  revalidatePath("/patients");
}

export async function createPatientPackageMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PATIENT_BILLING_ROLES);
  const parsed = createPatientPackageSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patient-packages.failedToCreatePackagePleaseTryAgain", {
      validationError: parsed.error,
    });
  const referenceError = await validatePatientPackageReferences({
    patientId: parsed.data.patient_id,
    clinicId: user.clinicId,
    departmentId: parsed.data.department_id,
    serviceId: parsed.data.service_id,
  });
  if (referenceError) return referenceError;
  const next = {
    clinic_id: user.clinicId,
    patient_id: parsed.data.patient_id,
    name: parsed.data.name,
    total_sessions: parsed.data.total_sessions,
    used_sessions: parsed.data.used_sessions,
    price_per_session: parsed.data.price_per_session,
    notes: parsed.data.notes,
    department_id: parsed.data.department_id,
    service_id: parsed.data.service_id,
    created_by: user.id,
    is_active: true,
  };
  if (mode === "preview") {
    return domainSuccess(
      { patient_id: parsed.data.patient_id },
      { targetTable: "patient_packages", after: next },
    );
  }
  const supabase = await createClient();
  const inserted = await supabase
    .from("patient_packages")
    .insert(next)
    .select("id")
    .single();
  if (inserted.error)
    return domainFailure(
      "patient-packages.failedToCreatePackagePleaseTryAgain",
    );
  refreshPatientPackage(parsed.data.patient_id);
  return domainSuccess(
    { id: inserted.data.id, patient_id: parsed.data.patient_id },
    {
      targetTable: "patient_packages",
      targetRecordIds: [inserted.data.id],
      after: { ...next, id: inserted.data.id },
    },
  );
}

export async function updatePatientPackageMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PATIENT_BILLING_ROLES);
  const parsed = updatePatientPackageSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patient-packages.failedToUpdatePackagePleaseTryAgain", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("patient_packages")
    .select("*")
    .eq("id", parsed.data.package_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("patient-packages.packageNotFound");
  if (parsed.data.total_sessions < existing.data.used_sessions) {
    return domainFailure("patient-packages.totalSessionsBelowUsed", {
      values: { used: existing.data.used_sessions },
    });
  }
  const referenceError = await validatePatientPackageReferences({
    patientId: existing.data.patient_id,
    clinicId: user.clinicId,
    departmentId: parsed.data.department_id,
    serviceId: parsed.data.service_id,
  });
  if (referenceError) return referenceError;
  const next = {
    name: parsed.data.name,
    total_sessions: parsed.data.total_sessions,
    price_per_session: parsed.data.price_per_session,
    notes: parsed.data.notes,
    department_id: parsed.data.department_id,
    service_id: parsed.data.service_id,
    is_active: parsed.data.is_active,
  };
  if (mode === "preview") {
    return domainSuccess(
      { id: existing.data.id, patient_id: existing.data.patient_id },
      {
        targetTable: "patient_packages",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: { ...existing.data, ...next },
      },
    );
  }
  const updated = await supabase
    .from("patient_packages")
    .update(next)
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure(
      "patient-packages.failedToUpdatePackagePleaseTryAgain",
    );
  refreshPatientPackage(existing.data.patient_id);
  return domainSuccess(
    { id: existing.data.id, patient_id: existing.data.patient_id },
    {
      targetTable: "patient_packages",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: { ...existing.data, ...next },
    },
  );
}

export async function deactivatePatientPackageMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PATIENT_BILLING_ROLES);
  const parsed = deactivatePatientPackageSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("patient-packages.packageNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("patient_packages")
    .select("*")
    .eq("id", parsed.data.package_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("patient-packages.packageNotFound");
  if (mode === "preview") {
    return domainSuccess(
      { id: existing.data.id, patient_id: existing.data.patient_id },
      {
        targetTable: "patient_packages",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: { ...existing.data, is_active: false },
      },
    );
  }
  const updated = await supabase
    .from("patient_packages")
    .update({ is_active: false })
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure(
      "patient-packages.failedToDeactivatePackagePleaseTryAgain",
    );
  refreshPatientPackage(existing.data.patient_id);
  return domainSuccess(
    { id: existing.data.id, patient_id: existing.data.patient_id },
    {
      targetTable: "patient_packages",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: { ...existing.data, is_active: false },
    },
  );
}

async function validateTemplateDepartment(
  clinicId: string,
  departmentId: string,
) {
  const supabase = await createClient();
  const department = await supabase
    .from("departments")
    .select("id")
    .eq("id", departmentId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (department.error)
    return domainFailure("package-templates.failedToValidateDepartment");
  if (!department.data)
    return domainFailure("package-templates.selectADepartmentFromThisClinic");
  return null;
}

/**
 * Every service a package's lines name must be this clinic's, active, and in
 * the department the package is filed under.
 *
 * The database enforces two of those absolutely — `package_template_items`'
 * foreign keys carry both `clinic_id` and `department_id`, so a cross-clinic
 * or cross-department line cannot be stored by any writer, this one included —
 * and cannot express the third, because "active" and "not soft-deleted" are
 * mutable states rather than keys. `set_package_template_items` re-checks all
 * three server-side and raises; this runs first so a person editing a package
 * gets a field error on the line they chose rather than a constraint name.
 *
 * An empty list is not an error. A department-only package is the ordinary
 * shape and the permanent one.
 */
async function validateTemplateItems(
  clinicId: string,
  departmentId: string,
  items: readonly PackageTemplateItemValues[],
) {
  if (items.length === 0) return null;
  const supabase = await createClient();
  const ids = [...new Set(items.map((item) => item.service_id))];
  const services = await supabase
    .from("services")
    .select("id")
    .in("id", ids)
    .eq("clinic_id", clinicId)
    .eq("department_id", departmentId)
    .eq("is_active", true)
    .is("deleted_at", null);
  if (services.error)
    return domainFailure("package-templates.failedToValidateService");
  const usable = new Set((services.data ?? []).map((row) => row.id));
  const fieldErrorCodes: Record<string, string[]> = {};
  for (const [index, item] of items.entries()) {
    if (usable.has(item.service_id)) continue;
    fieldErrorCodes[`items.${index}.service_id`] = [
      "package-templates.selectAServiceFromThisDepartment",
    ];
  }
  if (Object.keys(fieldErrorCodes).length === 0) return null;
  return domainFailure("package-templates.selectAServiceFromThisDepartment", {
    fieldErrorCodes,
  });
}

/**
 * Writes a package's line set in one statement, through the RPC.
 *
 * The RPC exists because "these are the lines now" is a delete plus a set of
 * inserts that are only correct together; it also re-derives the header's
 * roll-up from the lines, in that one direction, so
 * `package_templates.total_sessions` keeps agreeing with what booking and
 * session consumption read off it.
 *
 * A database where the migration has not been applied has no RPC to call. That
 * is not an error to show a clinic filing the department-only packages they
 * have always filed — `callers` skip this entirely for an empty set — but it
 * *is* an error to swallow for a clinic that just typed three priced lines,
 * because succeeding silently would drop them.
 */
async function writeTemplateItems(
  templateId: string,
  items: readonly PackageTemplateItemValues[],
) {
  const supabase = await createClient();
  const written = await supabase.rpc("set_package_template_items", {
    p_template_id: templateId,
    p_items: items.map((item) => ({
      service_id: item.service_id,
      sessions: item.sessions,
      price_per_session: item.price_per_session,
    })),
  });
  return written.error
    ? domainFailure("package-templates.failedToSavePackageServices")
    : null;
}

/**
 * The header columns, without the lines.
 *
 * `items` is not a column on `package_templates` and never will be — it is the
 * child table. It rides in on the same parsed payload because it comes from the
 * same form, and it is removed here rather than at twelve call sites.
 *
 * When a package has lines, the three roll-up columns are *derived* from them
 * and are written by the RPC, so the values the form sent for them are dropped
 * here too: one writer, one direction, no cycle in which an edited total
 * reprices a line that then recomputes the total. An item-less package keeps
 * every number a person typed, a deliberately discounted total included.
 */
function templateHeader<T extends Record<string, unknown>>(
  record: T,
): Omit<T, "items"> {
  const { items: _items, ...header } = record as T & { items?: unknown };
  void _items;
  return header as Omit<T, "items">;
}

function refreshPackageTemplates() {
  revalidatePath("/settings/packages");
}

export async function createPackageTemplateMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PACKAGE_TEMPLATE_ROLES);
  const parsed = createPackageTemplateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("package-templates.failedToCreateTemplate", {
      validationError: parsed.error,
    });
  const departmentError = await validateTemplateDepartment(
    user.clinicId,
    parsed.data.department_id,
  );
  if (departmentError) return departmentError;
  const items = parsed.data.items;
  const itemsError = await validateTemplateItems(
    user.clinicId,
    parsed.data.department_id,
    items,
  );
  if (itemsError) return itemsError;
  // `stripBlankDisplayNames` drops a display-name key the clinic left empty
  // rather than writing `""`, which also keeps this insert working on a
  // database where the additive bilingual migration has not been applied yet.
  const next = templateHeader(
    stripBlankDisplayNames({
      ...parsed.data,
      clinic_id: user.clinicId,
      created_by: user.id,
      is_active: true,
      // Derived from the lines, in that one direction. The RPC writes the same
      // numbers server-side; seeding them here means the row is never briefly
      // inconsistent with the lines about to be attached to it.
      total_sessions: packageItemsSessions(items) ?? parsed.data.total_sessions,
      total_price: packageItemsTotal(items) ?? parsed.data.total_price,
      price_per_session:
        items.length === 1
          ? items[0].price_per_session
          : items.length > 1
            ? null
            : parsed.data.price_per_session,
    }),
  );
  if (mode === "preview") {
    return domainSuccess(
      {},
      { targetTable: "package_templates", after: { ...next, items } },
    );
  }
  const supabase = await createClient();
  const inserted = await supabase
    .from("package_templates")
    .insert(next)
    .select("id")
    .single();
  if (inserted.error)
    return domainFailure("package-templates.failedToCreateTemplate");
  if (items.length > 0) {
    const itemsWriteError = await writeTemplateItems(inserted.data.id, items);
    if (itemsWriteError) {
      // The header exists and the lines do not, which is a package the clinic
      // did not ask for. Remove it rather than leave a half-built one behind:
      // nothing references a template created a moment ago.
      await supabase
        .from("package_templates")
        .delete()
        .eq("id", inserted.data.id)
        .eq("clinic_id", user.clinicId);
      return itemsWriteError;
    }
  }
  refreshPackageTemplates();
  return domainSuccess(
    { id: inserted.data.id },
    {
      targetTable: "package_templates",
      targetRecordIds: [inserted.data.id],
      after: { ...next, id: inserted.data.id, items },
    },
  );
}

export async function updatePackageTemplateMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PACKAGE_TEMPLATE_ROLES);
  const parsed = updatePackageTemplateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("package-templates.failedToUpdateTemplatePleaseTryAgain", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("package_templates")
    .select("*")
    .eq("id", parsed.data.template_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("package-templates.templateNotFound");
  const departmentError = await validateTemplateDepartment(
    user.clinicId,
    parsed.data.department_id,
  );
  if (departmentError) return departmentError;
  const items = parsed.data.items;
  const itemsError = await validateTemplateItems(
    user.clinicId,
    parsed.data.department_id,
    items,
  );
  if (itemsError) return itemsError;
  const { template_id: templateId, items: _submitted, ...rest } = parsed.data;
  void templateId;
  void _submitted;
  const next = templateHeader(
    stripBlankDisplayNames({
      ...rest,
      total_sessions: packageItemsSessions(items) ?? rest.total_sessions,
      total_price: packageItemsTotal(items) ?? rest.total_price,
      price_per_session:
        items.length === 1
          ? items[0].price_per_session
          : items.length > 1
            ? null
            : rest.price_per_session,
    }),
  );
  if (mode === "preview") {
    return domainSuccess(
      { id: existing.data.id },
      {
        targetTable: "package_templates",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: { ...existing.data, ...next, items },
      },
    );
  }
  // How many lines this package holds right now, which decides whether the
  // item write can be skipped at all. A read that fails because the table is
  // not there yet is a package that cannot have lines, which is the honest
  // answer on a database where the migration has not run.
  const currentItems = await supabase
    .from("package_template_items")
    .select("id", { count: "exact", head: true })
    .eq("package_template_id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  const hadItems = !currentItems.error && (currentItems.count ?? 0) > 0;

  // Order matters, and only in one case. `package_template_items` keys the
  // package's department, so moving a package to another department cascades
  // into its lines — where the services still belong to the *old* department
  // and the service key refuses them. The header update would fail with a raw
  // constraint violation. Clearing the lines first is the only order that
  // works, and it is exactly right as product behaviour too: the services of
  // the department you just left cannot be the contents of this package.
  const departmentChanged = existing.data.department_id !== parsed.data.department_id;
  if (departmentChanged && hadItems) {
    const cleared = await writeTemplateItems(existing.data.id, []);
    if (cleared) return cleared;
  }

  const updated = await supabase
    .from("package_templates")
    .update(next)
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure(
      "package-templates.failedToUpdateTemplatePleaseTryAgain",
    );
  // Skipped entirely for a package that has no lines and is not being given
  // any — the department-only case, which must keep working untouched on a
  // database where neither the table nor the RPC exists.
  if (items.length > 0 || (hadItems && !departmentChanged)) {
    const itemsWriteError = await writeTemplateItems(existing.data.id, items);
    if (itemsWriteError) return itemsWriteError;
  }
  refreshPackageTemplates();
  return domainSuccess(
    { id: existing.data.id },
    {
      targetTable: "package_templates",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: { ...existing.data, ...next, items },
    },
  );
}

export async function setPackageTemplateActiveMutation(
  user: AuthedUser,
  input: unknown,
  active: boolean,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PACKAGE_TEMPLATE_ROLES);
  const parsed = templateIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("package-templates.templateNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("package_templates")
    .select("*")
    .eq("id", parsed.data.template_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("package-templates.templateNotFound");
  if (mode === "preview") {
    return domainSuccess(
      { id: existing.data.id },
      {
        targetTable: "package_templates",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: { ...existing.data, is_active: active },
      },
    );
  }
  const updated = await supabase
    .from("package_templates")
    .update({ is_active: active })
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure(
      active
        ? "package-templates.failedToRestoreTemplate"
        : "package-templates.failedToDeactivateTemplate",
    );
  refreshPackageTemplates();
  return domainSuccess(
    { id: existing.data.id },
    {
      targetTable: "package_templates",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: { ...existing.data, is_active: active },
    },
  );
}

export async function deletePackageTemplateMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, PACKAGE_TEMPLATE_ROLES);
  const parsed = templateIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("package-templates.templateNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("package_templates")
    .select("*")
    .eq("id", parsed.data.template_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_active", false)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("package-templates.templateNotFound");
  if (mode === "preview") {
    return domainSuccess(
      { id: existing.data.id },
      {
        targetTable: "package_templates",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: null,
      },
    );
  }
  const deleted = await supabase
    .from("package_templates")
    .delete()
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId)
    .eq("is_active", false);
  if (deleted.error)
    return domainFailure("package-templates.failedToDeleteTemplate");
  refreshPackageTemplates();
  return domainSuccess(
    { id: existing.data.id },
    {
      targetTable: "package_templates",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: null,
    },
  );
}

async function patientAccountBalance(patientId: string, clinicId: string) {
  const supabase = await createClient();
  const [deposits, appointments] = await Promise.all([
    supabase
      .from("patient_deposits")
      .select("amount")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId),
    supabase
      .from("appointments")
      .select("deposit_amount")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId),
  ]);
  const deposited = (deposits.data ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0,
  );
  const spent = (appointments.data ?? []).reduce(
    (sum, row) => sum + Number(row.deposit_amount ?? 0),
    0,
  );
  return Math.max(0, Number((deposited - spent).toFixed(2)));
}

export async function completeAppointmentBillingMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_BILLING_ROLES);
  const parsed = appointmentCompletionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.invalidBillingDetails", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const appointmentId = parsed.data.appointment_id;
  const appointment = await supabase
    .from("appointments")
    .select("id, patient_id, status, total_amount, paid_amount, outstanding_amount")
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (appointment.error || !appointment.data)
    return domainFailure("appointments.appointmentNotFound");
  if (
    !["pending", "confirmed", "arrived", "in_session"].includes(
      appointment.data.status,
    )
  ) {
    return domainFailure("appointments.cannotTransitionStatus", {
      values: { from: appointment.data.status, to: "completed" },
    });
  }
  const billing = parsed.data.billing;
  const total = Number(
    billing.line_items
      .reduce(
        (sum, item) => sum + Number(item.price) * Number(item.quantity),
        0,
      )
      .toFixed(2),
  );
  if (total <= 0)
    return domainFailure("appointments.invoiceTotalMustBeGreaterThanZero");
  if (billing.deposit_amount > 0) {
    const balance = await patientAccountBalance(
      appointment.data.patient_id,
      user.clinicId,
    );
    if (billing.deposit_amount > balance + 0.001) {
      return domainFailure("appointments.depositExceedsBalance", {
        values: {
          deposit: billing.deposit_amount.toFixed(2),
          balance: balance.toFixed(2),
        },
      });
    }
    if (billing.deposit_amount > total + 0.001)
      return domainFailure(
        "appointments.depositAppliedCannotExceedInvoiceTotal",
      );
  }
  const collected =
    billing.paid_amount +
    billing.insurance_amount +
    billing.secondary_amount +
    billing.deposit_amount;
  if (collected > total + 0.001)
    return domainFailure("appointments.collectedAmountExceedsInvoiceTotal");
  const after = {
    ...appointment.data,
    status: "completed",
    total_amount: total,
    paid_amount: billing.paid_amount,
    insurance_amount: billing.insurance_amount,
    patient_responsibility: billing.patient_responsibility,
    secondary_amount: billing.secondary_amount,
    deposit_amount: billing.deposit_amount,
    outstanding_amount: Number(Math.max(0, total - collected).toFixed(2)),
    payment_method: billing.payment_method,
    secondary_payment_method: billing.secondary_payment_method ?? null,
    payment_note: billing.payment_note ?? null,
    line_items: billing.line_items,
    previous_settlement_amount: billing.previous_settlement_amount,
    previous_payment_method: billing.previous_payment_method ?? null,
    previous_note: billing.previous_note ?? null,
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointmentId,
        patient_id: appointment.data.patient_id,
        status: "completed",
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointmentId],
        before: appointment.data,
        after,
      },
    );
  }
  const baseArgs = {
    p_appointment_id: appointmentId,
    p_line_items: billing.line_items,
    p_paid_amount: Number(billing.paid_amount.toFixed(2)),
    p_payment_method: billing.payment_method,
    p_insurance_amount: Number(billing.insurance_amount.toFixed(2)),
    p_insurance_calculation_mode: billing.insurance_calculation_mode,
    p_insurance_percentage: billing.insurance_percentage,
    p_patient_responsibility: Number(
      billing.patient_responsibility.toFixed(2),
    ),
    p_secondary_amount: Number(billing.secondary_amount.toFixed(2)),
    p_secondary_payment_method: billing.secondary_payment_method ?? null,
    p_deposit_amount: Number(billing.deposit_amount.toFixed(2)),
    p_payment_note: billing.payment_note ?? null,
  };
  const completed =
    billing.previous_settlement_amount > 0
      ? await supabase.rpc(
          "complete_appointment_billing_with_previous_settlement",
          {
            ...baseArgs,
            p_previous_settlement_amount: billing.previous_settlement_amount,
            p_previous_payment_method: billing.previous_payment_method ?? null,
            p_previous_note: billing.previous_note ?? null,
          },
        )
      : await supabase.rpc("complete_appointment_billing", baseArgs);
  if (completed.error) {
    const rpc =
      billing.previous_settlement_amount > 0
        ? "complete_appointment_billing_with_previous_settlement"
        : "complete_appointment_billing";
    const submitted = (input as { billing?: Record<string, unknown> }).billing;
    const failure = new Error(
      `Appointment billing transaction failed: ${completed.error.message}`,
      { cause: completed.error },
    );
    console.error("appointment_billing_transaction_failed", {
      appointmentId,
      clinicId: user.clinicId,
      rpc,
      code: completed.error.code ?? null,
      message: completed.error.message,
      details: completed.error.details ?? null,
      hint: completed.error.hint ?? null,
      financialContext: {
        submitted: {
          paidAmount: submitted?.paid_amount,
          insuranceAmount: submitted?.insurance_amount,
          insuranceCalculationMode: submitted?.insurance_calculation_mode,
          insurancePercentage: submitted?.insurance_percentage ?? null,
          patientResponsibility: submitted?.patient_responsibility,
          secondaryAmount: submitted?.secondary_amount,
          depositAmount: submitted?.deposit_amount,
        },
        normalized: {
          invoiceTotal: total,
          paidAmount: billing.paid_amount,
          insuranceAmount: billing.insurance_amount,
          insuranceCalculationMode: billing.insurance_calculation_mode,
          insurancePercentage: billing.insurance_percentage,
          patientResponsibility: billing.patient_responsibility,
          secondaryAmount: billing.secondary_amount,
          depositAmount: billing.deposit_amount,
          grossAllocated: Number(collected.toFixed(2)),
          outstandingAmount: after.outstanding_amount,
        },
        rpcArguments: baseArgs,
      },
      stack: failure.stack,
    });
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  if (after.outstanding_amount > 0.001)
    await ensureInvoiceFollowupSequence(user.clinicId, appointmentId);
  revalidatePath("/appointments");
  revalidatePath(`/patients/${appointment.data.patient_id}`);
  return domainSuccess(
    {
      appointment_id: appointmentId,
      patient_id: appointment.data.patient_id,
      status: "completed",
    },
    {
      targetTable: "appointments",
      targetRecordIds: [appointmentId],
      before: appointment.data,
      after,
    },
  );
}

export async function undoAppointmentBillingMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData>> {
  assertDomainMutationRole(user, BILLING_UNDO_ROLES);
  const parsed = billingAppointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const [appointment, event] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, patient_id, scheduled_at, status, total_amount, paid_amount, outstanding_amount, patients(full_name, file_number)",
      )
      .eq("id", parsed.data.appointment_id)
      .eq("clinic_id", user.clinicId)
      .maybeSingle(),
    supabase
      .from("activity_events")
      .select("id, action, occurred_at, previous_state")
      .eq("clinic_id", user.clinicId)
      .eq("entity_type", "appointment")
      .eq("entity_id", parsed.data.appointment_id)
      .in("action", [
        "appointment.completed",
        "appointment.billing_completion_undone",
      ])
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (appointment.error || event.error)
    return domainFailure("appointments.billingUndoActivityUnavailable");
  const eligibility = computeBillingUndoEligibility({
    currentStatus: appointment.data?.status ?? null,
    role: user.role,
    latestBillingEvent: (event.data as BillingUndoActivityEvent | null) ?? null,
  });
  if (!eligibility.canUndo || !eligibility.targetStatus) {
    const key = {
      eligible: "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
      unauthorized: "appointments.notAuthorizedToUndoAppointmentBilling",
      appointment_not_found: "appointments.appointmentNotFound",
      not_completed: "appointments.billingUndoRequiresCompletedAppointment",
      completion_event_missing:
        "appointments.billingUndoCompletionEventMissing",
      completion_already_undone:
        "appointments.billingCompletionAlreadyUndone",
      invalid_previous_status:
        "appointments.billingUndoPreviousStatusUnavailable",
      expired: "appointments.billingUndoWindowExpired",
      activity_unavailable: "appointments.billingUndoActivityUnavailable",
    } as const;
    return domainFailure(key[eligibility.reason], {
      details: { eligibility },
    });
  }
  const provenance = await supabase
    .from("outstanding_settlements")
    .select("id")
    .eq("clinic_id", user.clinicId)
    .eq("source_appointment_id", parsed.data.appointment_id)
    .limit(1);
  if (provenance.error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  const rpc =
    (provenance.data?.length ?? 0) > 0
      ? "undo_appointment_billing_with_previous_settlement"
      : "undo_appointment_billing";
  const patient = Array.isArray(appointment.data?.patients)
    ? appointment.data?.patients[0] ?? null
    : appointment.data?.patients;
  const before = appointment.data
    ? {
        id: appointment.data.id,
        patient_id: appointment.data.patient_id,
        patient_name: patient?.full_name ?? null,
        patient_file_number: patient?.file_number ?? null,
        scheduled_at: appointment.data.scheduled_at,
        status: appointment.data.status,
        total_amount: appointment.data.total_amount,
        paid_amount: appointment.data.paid_amount,
        outstanding_amount: appointment.data.outstanding_amount,
      }
    : null;
  const next = {
    ...before,
    status: eligibility.targetStatus,
    total_amount: null,
    paid_amount: null,
    outstanding_amount: null,
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: parsed.data.appointment_id,
        patient_id: appointment.data?.patient_id,
        status: eligibility.targetStatus,
        eligibility,
        rpc,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [parsed.data.appointment_id],
        before,
        after: next,
      },
    );
  }
  const undone = await supabase.rpc(rpc, {
    p_appointment_id: parsed.data.appointment_id,
    p_target_status: eligibility.targetStatus,
  });
  if (undone.error)
    console.error("appointment_billing_undo_failed", {
      appointmentId: parsed.data.appointment_id,
      clinicId: user.clinicId,
      rpc,
      code: undone.error.code ?? null,
      message: undone.error.message,
      details: undone.error.details ?? null,
      hint: undone.error.hint ?? null,
      eligibility,
    });
  if (undone.error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
      { details: { eligibility, rpc } },
    );
  revalidatePath("/appointments");
  revalidatePath("/revenue");
  revalidatePath("/reports/revenue");
  if (appointment.data?.patient_id)
    revalidatePath(`/patients/${appointment.data.patient_id}`);
  return domainSuccess(
    {
      appointment_id: parsed.data.appointment_id,
      patient_id: appointment.data?.patient_id,
      status: eligibility.targetStatus,
      eligibility,
      rpc,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.appointment_id],
      before,
      after: next,
    },
  );
}

export async function sendInvoiceToPatientMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<BillingMutationData & { channels?: unknown }>> {
  assertDomainMutationRole(user, BILLING_UNDO_ROLES);
  const parsed = billingAppointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const appointment = await supabase
    .from("appointments")
    .select(
      "id, status, patient_id, total_amount, outstanding_amount, patients(full_name, phone, email)",
    )
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (appointment.error || !appointment.data)
    return domainFailure("appointments.appointmentNotFound");
  if (
    appointment.data.status !== "completed" ||
    !(Number(appointment.data.total_amount ?? 0) > 0)
  ) {
    return domainFailure("appointments.noInvoiceToSend");
  }
  const snapshot = {
    appointment_id: appointment.data.id,
    patient_id: appointment.data.patient_id,
    patient_name: appointment.data.patients?.full_name ?? "",
    email: appointment.data.patients?.email ?? null,
    phone: appointment.data.patients?.phone ?? null,
    total_amount: appointment.data.total_amount,
    outstanding_amount: appointment.data.outstanding_amount,
  };
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointment.data.id,
        patient_id: appointment.data.patient_id,
      },
      {
        targetTable: "message_dispatches",
        targetRecordIds: [appointment.data.id],
        after: snapshot,
      },
    );
  }
  const delivered = await deliverIssuedInvoice({
    clinicId: user.clinicId,
    appointmentId: appointment.data.id,
    actorId: user.id,
  });
  if (!delivered)
    return domainFailure("appointments.failedToSendInvoice");
  const normalize = (outcome: { status: string } | null) => {
    if (outcome?.status === "sent" || outcome?.status === "ambiguous")
      return "sent";
    if (outcome?.status === "duplicate") return "already_sent";
    if (outcome?.status === "failed") return "failed";
    return "unavailable";
  };
  const channels = {
    email: normalize(delivered.email),
    whatsapp: normalize(delivered.whatsapp),
  };
  return domainSuccess(
    {
      appointment_id: appointment.data.id,
      patient_id: appointment.data.patient_id,
      channels,
    },
    {
      targetTable: "message_dispatches",
      targetRecordIds: [appointment.data.id],
      after: { ...snapshot, channels },
    },
  );
}
