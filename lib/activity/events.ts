/**
 * Phase 8D — vocabulary for the unified activity trail.
 *
 * The DB trigger `record_activity_event()` is the single source of truth for
 * which semantic actions are emitted; this module mirrors that vocabulary for
 * the client/server so labels, filters, and analytics stay in lockstep with the
 * database. Keep the two in sync: every action produced by the trigger must
 * appear here, and every action here must be producible by the trigger.
 */

export const ACTIVITY_ENTITY_TYPES = ["appointment", "follow_up"] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const ACTIVITY_ACTIONS = [
  // appointments
  "appointment.created",
  "appointment.confirmed",
  "appointment.checked_in",
  "appointment.session_started",
  "appointment.completed",
  "appointment.cancelled",
  "appointment.no_show",
  "appointment.replaced",
  "appointment.rescheduled",
  "appointment.status_changed",
  "appointment.trashed",
  "appointment.restored",
  "appointment.updated",
  "appointment.deleted",
  // follow-ups
  "follow_up.recorded",
  "follow_up.outcome_changed",
  "follow_up.updated",
  "follow_up.deleted",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/** Tone used by the timeline UI to colour each event dot. */
export type ActivityTone = "neutral" | "positive" | "warning" | "negative";

const ACTION_TONE: Record<ActivityAction, ActivityTone> = {
  "appointment.created": "neutral",
  "appointment.confirmed": "positive",
  "appointment.checked_in": "positive",
  "appointment.session_started": "positive",
  "appointment.completed": "positive",
  "appointment.cancelled": "negative",
  "appointment.no_show": "negative",
  "appointment.replaced": "warning",
  "appointment.rescheduled": "warning",
  "appointment.status_changed": "neutral",
  "appointment.trashed": "negative",
  "appointment.restored": "neutral",
  "appointment.updated": "neutral",
  "appointment.deleted": "negative",
  "follow_up.recorded": "neutral",
  "follow_up.outcome_changed": "warning",
  "follow_up.updated": "neutral",
  "follow_up.deleted": "negative",
};

export function activityActionTone(action: string): ActivityTone {
  return ACTION_TONE[action as ActivityAction] ?? "neutral";
}

/**
 * Maps a dotted action id to the camelCase message key used under the `activity`
 * i18n namespace. next-intl treats dots as path separators, so the wire format
 * (`appointment.confirmed`) and the message key (`appointmentConfirmed`) differ.
 */
export function activityActionMessageKey(action: string): string {
  return action.replace(/[._]([a-z])/g, (_match, char: string) => char.toUpperCase());
}
