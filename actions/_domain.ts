import "server-only";

import {
  actionAppointmentStatus,
  actionError,
  actionWeekday,
} from "@/lib/i18n/action-errors";
import type { DomainMutationFailure } from "@/lib/domain-mutations";
import { localizeZodFieldErrors } from "@/lib/validations/server";

export async function domainFailureToActionResult(
  failure: DomainMutationFailure,
): Promise<{ error?: string; fieldErrors?: Record<string, string[]> }> {
  const zodFieldErrors = failure.validationError
    ? await localizeZodFieldErrors(failure.validationError)
    : undefined;
  const codedFieldErrors = failure.fieldErrorCodes
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(failure.fieldErrorCodes).map(async ([field, codes]) => [
            field,
            await Promise.all(codes.map((code) => actionError(code))),
          ]),
        ),
      )
    : undefined;
  const fieldErrors = codedFieldErrors ?? zodFieldErrors;
  let values = failure.values;
  if (failure.code === "appointments.cannotTransitionStatus" && values) {
    values = {
      ...values,
      from: await actionAppointmentStatus(String(values.from)),
      to: await actionAppointmentStatus(String(values.to)),
    };
  }
  if (
    (failure.code === "settings.staffScheduleOnClosedDay" ||
      failure.code === "settings.staffHoursOutsideClinicHours" ||
      failure.code === "appointments.clinicClosedOnDay") &&
    values &&
    typeof values.day === "number"
  ) {
    values = { ...values, day: await actionWeekday(values.day) };
  }
  const firstFieldError = (
    Object.values(fieldErrors ?? {}) as string[][]
  ).flat()[0];
  const error =
    firstFieldError ?? (await actionError(failure.code, values));
  return {
    ...(error ? { error } : {}),
    ...(fieldErrors && Object.keys(fieldErrors).length > 0
      ? { fieldErrors }
      : {}),
  };
}

export async function domainFailureToActionResultWithFirstFieldError(
  failure: DomainMutationFailure,
) {
  const result = await domainFailureToActionResult(failure);
  const first = Object.values(result.fieldErrors ?? {}).flat()[0];
  return {
    ...result,
    error: first ?? result.error ?? (await actionError(failure.code, failure.values)),
  };
}
