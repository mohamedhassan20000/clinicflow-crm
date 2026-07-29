import type { Json } from "@/types/database";
import type { UserRole } from "@/lib/rbac";

export const APPOINTMENT_UNDO_WINDOW_MS = 10_000;

export type BillingUndoTargetStatus =
  | "pending"
  | "confirmed"
  | "arrived"
  | "in_session";

export type BillingUndoEligibilityReason =
  | "eligible"
  | "unauthorized"
  | "appointment_not_found"
  | "not_completed"
  | "completion_event_missing"
  | "completion_already_undone"
  | "invalid_previous_status"
  | "expired"
  | "activity_unavailable";

export type BillingUndoActivityEvent = {
  id: string;
  action: string;
  occurred_at: string;
  previous_state: Json | null;
};

export type BillingUndoEligibility = {
  canUndo: boolean;
  reason: BillingUndoEligibilityReason;
  targetStatus: BillingUndoTargetStatus | null;
  completionEventId: string | null;
  completionOccurredAt: string | null;
  expiresAt: string | null;
};

const BILLING_UNDO_ROLES: readonly UserRole[] = [
  "admin",
  "receptionist",
  "manager",
];

const RESTORABLE_STATUSES = new Set<BillingUndoTargetStatus>([
  "pending",
  "confirmed",
  "arrived",
  "in_session",
]);

function ineligible(
  reason: Exclude<BillingUndoEligibilityReason, "eligible">,
  event: BillingUndoActivityEvent | null = null,
): BillingUndoEligibility {
  return {
    canUndo: false,
    reason,
    targetStatus: null,
    completionEventId: event?.id ?? null,
    completionOccurredAt: event?.occurred_at ?? null,
    expiresAt: null,
  };
}

function previousStatus(event: BillingUndoActivityEvent): string | null {
  if (
    typeof event.previous_state !== "object" ||
    event.previous_state === null ||
    Array.isArray(event.previous_state)
  ) {
    return null;
  }

  const status = event.previous_state.status;
  return typeof status === "string" ? status : null;
}

/**
 * Applies the existing 10-second appointment Undo policy to persisted state.
 * Financial/insurance fields are deliberately not eligibility inputs: the
 * completion RPC owns their reconciliation, while the semantic completion
 * event owns the restore target.
 */
export function computeBillingUndoEligibility({
  currentStatus,
  role,
  latestBillingEvent,
  now = new Date(),
}: {
  currentStatus: string | null;
  role: UserRole;
  latestBillingEvent: BillingUndoActivityEvent | null;
  now?: Date;
}): BillingUndoEligibility {
  if (!BILLING_UNDO_ROLES.includes(role)) {
    return ineligible("unauthorized");
  }
  if (currentStatus === null) {
    return ineligible("appointment_not_found");
  }
  if (currentStatus !== "completed") {
    return ineligible("not_completed");
  }
  if (!latestBillingEvent) {
    return ineligible("completion_event_missing");
  }
  if (
    latestBillingEvent.action ===
    "appointment.billing_completion_undone"
  ) {
    return ineligible("completion_already_undone", latestBillingEvent);
  }
  if (latestBillingEvent.action !== "appointment.completed") {
    return ineligible("completion_event_missing", latestBillingEvent);
  }

  const targetStatus = previousStatus(latestBillingEvent);
  if (
    targetStatus === null ||
    !RESTORABLE_STATUSES.has(targetStatus as BillingUndoTargetStatus)
  ) {
    return ineligible("invalid_previous_status", latestBillingEvent);
  }

  const occurredAtMs = new Date(latestBillingEvent.occurred_at).getTime();
  if (!Number.isFinite(occurredAtMs)) {
    return ineligible("activity_unavailable", latestBillingEvent);
  }
  const expiresAtMs = occurredAtMs + APPOINTMENT_UNDO_WINDOW_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  if (now.getTime() > expiresAtMs) {
    return {
      ...ineligible("expired", latestBillingEvent),
      expiresAt,
    };
  }

  return {
    canUndo: true,
    reason: "eligible",
    targetStatus: targetStatus as BillingUndoTargetStatus,
    completionEventId: latestBillingEvent.id,
    completionOccurredAt: latestBillingEvent.occurred_at,
    expiresAt,
  };
}
