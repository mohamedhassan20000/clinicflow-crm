import "server-only";

import { ActionBusinessRuleError } from "@/lib/ai/actions/errors";
import type {
  ActionAuditState,
  ActionPreviewChange,
} from "@/lib/ai/actions/types";
import type {
  DomainMutationResult,
  DomainMutationSuccess,
} from "@/lib/domain-mutations";

export function requireDomainMutationSuccess<T>(
  result: DomainMutationResult<T>,
): DomainMutationSuccess<T> {
  if (!result.ok) throw new ActionBusinessRuleError(result.code);
  return result;
}

export function domainAudit(
  success: DomainMutationSuccess<unknown>,
): ActionAuditState {
  return {
    targetTable: success.audit.targetTable,
    targetRecordIds: success.audit.targetRecordIds,
    before: success.audit.before,
    after: success.audit.after,
  };
}

export function scalarChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): ActionPreviewChange[] {
  return fields.map((field) => ({
    label: field,
    before: displayScalar(before?.[field]),
    after: displayScalar(after?.[field]),
  }));
}

export function patientIdentifier(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Unknown patient";
  }
  const row = value as Record<string, unknown>;
  const name =
    typeof row.full_name === "string" && row.full_name.trim()
      ? row.full_name.trim()
      : "Unknown patient";
  const fileNumber =
    typeof row.file_number === "string" && row.file_number.trim()
      ? row.file_number.trim()
      : "unknown file";
  const id =
    typeof row.id === "string" && row.id.trim() ? row.id : "unknown id";
  return `${name} — file ${fileNumber} (record ${id})`;
}

function displayScalar(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  return JSON.stringify(value);
}
