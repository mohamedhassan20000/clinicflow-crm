"use server";

import {
  domainFailureToActionResult,
  domainFailureToActionResultWithFirstFieldError,
} from "@/actions/_domain";
import {
  completeAppointmentBillingMutation,
  sendInvoiceToPatientMutation,
  undoAppointmentBillingMutation,
} from "@/lib/billing/mutations";
import {
  arriveAppointmentMutation,
  confirmAndDisplaceAppointmentsMutation,
  createAppointmentMutation,
  dismissDisplacedAppointmentMutation,
  permanentDeleteAppointmentMutation,
  replaceAppointmentMutation,
  restoreAppointmentMutation,
  softDeleteAppointmentMutation,
  startAppointmentSessionMutation,
  undoAppointmentStatusMutation,
  updateAppointmentStatusMutation,
} from "@/lib/appointments/mutations";
import { requireMutationRole } from "@/lib/rbac";
import { redirect } from "next/navigation";
import type { Database } from "@/types/database";
import type { BillingValues } from "@/lib/validations/appointment";
import {
  checkSameDayPatient as legacyCheckSameDayPatient,
  emptyAppointmentsTrash as legacyEmptyAppointmentsTrash,
  getAppointmentReplacementChain as legacyGetAppointmentReplacementChain,
  getBillingContext as legacyGetBillingContext,
  getConflictingPendingAppointments as legacyGetConflictingPendingAppointments,
  getInvoiceUndoEligibility as legacyGetInvoiceUndoEligibility,
  getReplacementAvailability as legacyGetReplacementAvailability,
  getReplacementDoctorOptions as legacyGetReplacementDoctorOptions,
} from "@/actions/appointments-legacy";
import type {
  SendInvoiceResult as LegacySendInvoiceResult,
  UndoInvoiceCompletionResult as LegacyUndoInvoiceCompletionResult,
} from "@/actions/appointments-legacy";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};
type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
export type InvoiceUndoStatus = Extract<
  AppointmentStatus,
  "pending" | "confirmed" | "arrived" | "in_session"
>;
export type StartAppointmentSessionResult = ActionResult & {
  redirectTo?: string;
  patientId?: string;
};
export type BillingInput = BillingValues;
export type {
  BillingContext,
  ConflictingAppointment,
  InvoiceChannelState,
  ReplacementChainItem,
  ReplacementDoctorOption,
  SendInvoiceResult,
  UndoInvoiceCompletionResult,
} from "@/actions/appointments-legacy";

function nullableFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return value && value !== "none" ? value : null;
}

export async function createAppointment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const duration = formData.get("duration_minutes");
  const result = await createAppointmentMutation(user, {
    patient_id: formData.get("patient_id"),
    doctor_id: formData.get("doctor_id"),
    department_id: nullableFormValue(formData, "department_id"),
    scheduled_at: formData.get("scheduled_at"),
    duration_minutes: duration ? Number(duration) : 30,
    insurance_provider_id: nullableFormValue(
      formData,
      "insurance_provider_id",
    ),
    package_id: nullableFormValue(formData, "package_id"),
    notes: formData.get("notes") || null,
  });
  if (!result.ok) return domainFailureToActionResult(result);
  if (result.data.redirect_to) redirect(result.data.redirect_to);
  return { success: true };
}

export async function replaceAppointment(
  input: unknown,
): Promise<ActionResult & { appointmentId?: string }> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "doctor",
    "assistant",
  ]);
  const result = await replaceAppointmentMutation(user, input);
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, appointmentId: result.data.appointment_id };
}

export async function updateAppointmentStatus(
  id: string,
  newStatus: string,
  billingPayload?: BillingInput | null,
  cancellationReason?: string | null,
  noShowReason?: string | null,
): Promise<ActionResult> {
  if (newStatus === "completed") {
    const user = await requireMutationRole([
      "admin",
      "receptionist",
      "manager",
      "assistant",
    ]);
    const result = await completeAppointmentBillingMutation(user, {
      appointment_id: id,
      billing: billingPayload,
    });
    return result.ok
      ? {}
      : domainFailureToActionResultWithFirstFieldError(result);
  }
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const result = await updateAppointmentStatusMutation(user, {
    appointment_id: id,
    status: newStatus,
    reason:
      newStatus === "cancelled"
        ? cancellationReason
        : newStatus === "no_show"
          ? noShowReason
          : null,
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return {};
}

export async function softDeleteAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await softDeleteAppointmentMutation(user, {
    appointment_id: id,
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function restoreAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await restoreAppointmentMutation(user, { appointment_id: id });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function undoAppointmentStatus(
  id: string,
  targetStatus: InvoiceUndoStatus,
): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "doctor",
    "manager",
  ]);
  const result = await undoAppointmentStatusMutation(user, {
    appointment_id: id,
    target_status: targetStatus,
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function arriveAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const result = await arriveAppointmentMutation(user, { appointment_id: id });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function startAppointmentSession(
  id: string,
): Promise<StartAppointmentSessionResult> {
  const user = await requireMutationRole(["doctor"]);
  const result = await startAppointmentSessionMutation(user, {
    appointment_id: id,
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return {
    success: true,
    patientId: result.data.patient_id,
    redirectTo: result.data.redirect_to,
  };
}

export async function permanentDeleteAppointment(
  id: string,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await permanentDeleteAppointmentMutation(user, {
    appointment_id: id,
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function cancelAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  return updateAppointmentStatus(id, "cancelled", null, reason);
}

export async function confirmAndDisplaceConflicts(
  appointmentId: string,
  conflictingIds: string[],
): Promise<ActionResult> {
  const user = await requireMutationRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const result = await confirmAndDisplaceAppointmentsMutation(user, {
    appointment_id: appointmentId,
    conflicting_ids: conflictingIds,
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function dismissDisplacedAppointment(
  id: string,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await dismissDisplacedAppointmentMutation(user, {
    appointment_id: id,
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

// Read-only helpers and the bulk-destructive UI-only operation remain on their
// existing paths. The Assistant intentionally does not register empty-trash.
export async function getReplacementDoctorOptions(...args: Parameters<typeof legacyGetReplacementDoctorOptions>) {
  return legacyGetReplacementDoctorOptions(...args);
}
export async function getReplacementAvailability(...args: Parameters<typeof legacyGetReplacementAvailability>) {
  return legacyGetReplacementAvailability(...args);
}
export async function getAppointmentReplacementChain(...args: Parameters<typeof legacyGetAppointmentReplacementChain>) {
  return legacyGetAppointmentReplacementChain(...args);
}
export async function getInvoiceUndoEligibility(...args: Parameters<typeof legacyGetInvoiceUndoEligibility>) {
  return legacyGetInvoiceUndoEligibility(...args);
}
export async function undoInvoiceCompletion(
  id: string,
): Promise<LegacyUndoInvoiceCompletionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await undoAppointmentBillingMutation(user, {
    appointment_id: id,
  });
  if (!result.ok) {
    return {
      ...(await domainFailureToActionResult(result)),
      ...(result.details?.eligibility
        ? { eligibility: result.details.eligibility }
        : {}),
      ...(typeof result.details?.rpc === "string"
        ? { rpc: result.details.rpc }
        : {}),
    } as LegacyUndoInvoiceCompletionResult;
  }
  return {
    success: true,
    targetStatus: result.data.status as InvoiceUndoStatus | undefined,
    eligibility: result.data.eligibility,
    rpc: result.data.rpc,
  };
}
export async function sendInvoiceToPatient(
  appointmentId: string,
): Promise<LegacySendInvoiceResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
  const result = await sendInvoiceToPatientMutation(user, {
    appointment_id: appointmentId,
  });
  if (!result.ok) return domainFailureToActionResult(result);
  return {
    success: true,
    channels: result.data.channels as {
      email: "sent" | "already_sent" | "failed" | "unavailable";
      whatsapp: "sent" | "already_sent" | "failed" | "unavailable";
    },
  };
}
export async function emptyAppointmentsTrash(...args: Parameters<typeof legacyEmptyAppointmentsTrash>) {
  return legacyEmptyAppointmentsTrash(...args);
}
export async function getBillingContext(...args: Parameters<typeof legacyGetBillingContext>) {
  return legacyGetBillingContext(...args);
}
export async function checkSameDayPatient(...args: Parameters<typeof legacyCheckSameDayPatient>) {
  return legacyCheckSameDayPatient(...args);
}
export async function getConflictingPendingAppointments(...args: Parameters<typeof legacyGetConflictingPendingAppointments>) {
  return legacyGetConflictingPendingAppointments(...args);
}
