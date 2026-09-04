/**
 * P18 — the vocabulary of the administrative audit trail.
 *
 * The database is the source of truth for what can be emitted: the triggers in
 * `20260912120000_p18_admin_audit_trail.sql` and the three scheduling calls in
 * `lib/settings/mutations.ts` are the only writers, and every action they can
 * produce appears here. This module exists so labels, filters and the feed
 * reader stay in lockstep with them — the same contract `lib/activity/events.ts`
 * keeps for the operational trail.
 *
 * It is deliberately isomorphic: the Audit Log page renders human sentences on
 * the client from the same table the server reads.
 */

export const AUDIT_MODULES = [
  "clinic",
  "departments",
  "services",
  "insurance",
  "staff",
  "scheduling",
  "appointments",
  "ai",
  "messaging",
] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/**
 * Modules that live in `admin_audit_events`. `appointments` is served by the
 * pre-existing `activity_events` trail and is merged in at read time rather
 * than copied, so it is a valid *filter* but never a valid *write* target.
 */
export const ADMIN_AUDIT_MODULES = AUDIT_MODULES.filter(
  (module) => module !== "appointments",
) as readonly AuditModule[];

export type AuditActorType = "staff" | "system" | "integration";
export type AuditSurface = "staff_web" | "system" | "whatsapp";
export type AuditOutcome = "success" | "failure";

/** Which underlying trail an event was read from. */
export type AuditTrail = "admin" | "activity" | "legacy";

export const AUDIT_ACTIONS = [
  // departments
  "department.created",
  "department.updated",
  "department.renamed",
  "department.enabled",
  "department.disabled",
  "department.archived",
  "department.restored",
  "department.deleted",
  // services
  "service.created",
  "service.updated",
  "service.renamed",
  "service.price_changed",
  "service.department_changed",
  "service.enabled",
  "service.disabled",
  "service.archived",
  "service.restored",
  "service.deleted",
  // insurance
  "insurance_provider.created",
  "insurance_provider.updated",
  "insurance_provider.renamed",
  "insurance_provider.enabled",
  "insurance_provider.disabled",
  "insurance_provider.archived",
  "insurance_provider.restored",
  "insurance_provider.deleted",
  // staff & permissions
  "staff.created",
  "staff.updated",
  "staff.renamed",
  "staff.role_changed",
  "staff.activated",
  "staff.deactivated",
  "staff.department_changed",
  "staff.archived",
  "staff.restored",
  "staff.deleted",
  "page_permission.granted",
  "page_permission.revoked",
  "page_permission.reset",
  "report_permission.granted",
  "report_permission.revoked",
  "report_permission.reset",
  "ai_permission.granted",
  "ai_permission.revoked",
  "ai_permission.reset",
  // clinic
  "clinic.settings_updated",
  "clinic.reminders_changed",
  "clinic.invoice_followups_changed",
  // scheduling
  "clinic_hours.updated",
  "staff_schedule.updated",
  "shift_templates.updated",
  // ai configuration
  "ai.patient_replies_changed",
  "ai.assistant_style_changed",
  "ai.provider_credential_created",
  "ai.provider_credential_rotated",
  "ai.provider_credential_revoked",
  "ai.provider_credential_tested",
  "ai.provider_mode_changed",
  "ai.provider_auto_fallback_changed",
  "ai.provider_hybrid_fallback",
  // messaging / whatsapp
  "whatsapp_account.connected",
  "whatsapp_account.disconnected",
  "whatsapp_account.replaced",
  "whatsapp_account.link_intent_changed",
  "messaging.channel_event",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The module an action belongs to. Derived from the action's own namespace
 * wherever the two agree, so a new action only has to be added to the list
 * above; the exceptions below are the cases where the namespace and the
 * settings screen the change belongs to genuinely differ.
 */
const MODULE_BY_PREFIX: Record<string, AuditModule> = {
  department: "departments",
  service: "services",
  insurance_provider: "insurance",
  staff: "staff",
  page_permission: "staff",
  report_permission: "staff",
  ai_permission: "staff",
  clinic: "clinic",
  clinic_hours: "scheduling",
  staff_schedule: "scheduling",
  shift_templates: "scheduling",
  ai: "ai",
  whatsapp_account: "messaging",
  messaging: "messaging",
  appointment: "appointments",
  follow_up: "appointments",
};

export function auditModuleForAction(action: string): AuditModule {
  const prefix = action.split(".")[0] ?? "";
  return MODULE_BY_PREFIX[prefix] ?? "clinic";
}

/** Tone used to colour the event marker, mirroring the activity timeline. */
export type AuditTone = "neutral" | "positive" | "warning" | "negative";

const NEGATIVE = new Set<string>([
  "department.deleted",
  "service.deleted",
  "insurance_provider.deleted",
  "staff.deleted",
  "staff.archived",
  "staff.deactivated",
  "department.archived",
  "service.archived",
  "insurance_provider.archived",
  "page_permission.revoked",
  "report_permission.revoked",
  "ai_permission.revoked",
  "whatsapp_account.disconnected",
  "ai.provider_credential_revoked",
]);
const POSITIVE = new Set<string>([
  "department.created",
  "service.created",
  "insurance_provider.created",
  "staff.created",
  "staff.activated",
  "staff.restored",
  "department.enabled",
  "service.enabled",
  "insurance_provider.enabled",
  "department.restored",
  "service.restored",
  "insurance_provider.restored",
  "page_permission.granted",
  "report_permission.granted",
  "ai_permission.granted",
  "whatsapp_account.connected",
]);
const WARNING = new Set<string>([
  "service.price_changed",
  "staff.role_changed",
  "department.disabled",
  "service.disabled",
  "insurance_provider.disabled",
  "ai.patient_replies_changed",
  "whatsapp_account.replaced",
  "ai.provider_mode_changed",
  "ai.provider_credential_rotated",
]);

export function auditActionTone(action: string): AuditTone {
  if (NEGATIVE.has(action)) return "negative";
  if (POSITIVE.has(action)) return "positive";
  if (WARNING.has(action)) return "warning";
  return "neutral";
}

/**
 * next-intl treats dots as path separators, so the wire action
 * (`service.price_changed`) and its message key (`servicePriceChanged`) differ.
 * Identical convention to `activityActionMessageKey`.
 */
export function auditActionMessageKey(action: string): string {
  return action.replace(/[._]([a-z0-9])/g, (_match, char: string) =>
    char.toUpperCase(),
  );
}
