import type { UserRole } from "@/lib/rbac";

/**
 * Application read roles for private patient-document metadata and bytes.
 * Keep the action layer, Assistant registry, table RLS, and storage RLS aligned.
 */
export const PATIENT_DOCUMENT_READ_ROLES = [
  "admin",
  "receptionist",
] as const satisfies readonly UserRole[];

/**
 * Application read roles for medical-note narrative and attachments.
 * Doctor row scope is enforced by the existing table/storage RLS policies.
 */
export const MEDICAL_NOTE_READ_ROLES = [
  "admin",
  "receptionist",
  "doctor",
] as const satisfies readonly UserRole[];
