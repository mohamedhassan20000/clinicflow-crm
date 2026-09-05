/**
 * P11Q — the rules of a bulk send, with nothing that touches a database.
 *
 * Split out of `bulk-send.ts` because the Inbox needs the ceiling and the skip
 * reasons in the browser, and that file is `server-only` by design — it holds
 * the runner that reaches the send path. Keeping the decisions here means they
 * can be unit-tested without a database *and* rendered without shipping the
 * runner to the client.
 */

import type { SendErrorCode } from "@/lib/messaging/types";

/**
 * The ceiling on one bulk send.
 *
 * Deliberately small. This is a clinic operations tool — "the doctor is off
 * sick, tell today's patients" — and a limit that comfortably covers a day's
 * appointments while making the feature useless for bulk marketing is the
 * correct shape for it, not an arbitrary technical bound.
 */
export const MAX_BULK_RECIPIENTS = 50;

/**
 * How many sends are in flight at once.
 *
 * A linked device is one WhatsApp socket belonging to one clinic phone. Three is
 * chosen to keep the queue moving without ever presenting that socket with a
 * burst it would not see from human use.
 */
export const BULK_SEND_CONCURRENCY = 3;

/** A pause between sends, so a long job paces itself rather than sprinting. */
export const BULK_SEND_DELAY_MS = 250;

/** Why a selected conversation will not be written to at all. */
export type BulkSkipReason =
  /** Not a WhatsApp thread; this feature sends WhatsApp only. */
  | "not_whatsapp"
  /** No provider address on the conversation, so there is nobody to send to. */
  | "no_address"
  /** The thread is closed. Re-opening it is a deliberate act, not a side effect. */
  | "conversation_closed";

export type BulkRecipientPlan =
  | { conversationId: string; send: true; recipient: string }
  | { conversationId: string; send: false; reason: BulkSkipReason };

/** The conversation fields the planner needs. Nothing clinical. */
export type BulkPlannableConversation = {
  id: string;
  channel: string;
  status: string;
  participantAddress: string | null;
};

/**
 * Decides, for each selected conversation, whether it can be written to.
 *
 * Pure and separate from the sending so that "who gets skipped, and why" is a
 * property the tests can pin without a database. Duplicates collapse onto the
 * first occurrence: selecting the same thread twice is a UI accident, not a
 * request to send twice.
 */
export function planBulkRecipients(
  conversations: readonly BulkPlannableConversation[],
): BulkRecipientPlan[] {
  const seen = new Set<string>();
  const plans: BulkRecipientPlan[] = [];
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    if (conversation.channel !== "whatsapp") {
      plans.push({ conversationId: conversation.id, send: false, reason: "not_whatsapp" });
      continue;
    }
    if (conversation.status === "closed") {
      plans.push({ conversationId: conversation.id, send: false, reason: "conversation_closed" });
      continue;
    }
    const recipient = conversation.participantAddress?.trim();
    if (!recipient) {
      plans.push({ conversationId: conversation.id, send: false, reason: "no_address" });
      continue;
    }
    plans.push({ conversationId: conversation.id, send: true, recipient });
  }
  return plans;
}

/**
 * Whether a failed send may be attempted again.
 *
 * The important half is `PROVIDER_SEND_AMBIGUOUS`. The provider may have
 * accepted an ambiguous message, so retrying it risks sending a patient the same
 * message twice — and a duplicate is worse than a message the Inbox is unsure
 * about, because the delivery callback can still repair the record while a
 * second WhatsApp message cannot be unsent.
 */
export function isRetryableSendFailure(code: SendErrorCode): boolean {
  return code !== "PROVIDER_SEND_AMBIGUOUS";
}

/** The terminal state a finished job reports, given what actually happened. */
export function bulkJobOutcome(counts: {
  sent: number;
  failed: number;
  skipped: number;
}): "completed" | "completed_with_failures" | "failed" {
  if (counts.failed === 0 && counts.skipped === 0) return "completed";
  if (counts.sent === 0) return "failed";
  return "completed_with_failures";
}

/**
 * How long a recipient may sit in `sending` before it is treated as interrupted.
 *
 * Generous on purpose. A healthy send resolves in seconds, so anything still in
 * flight after five minutes is a process that is not coming back — and being
 * slow to flag costs nothing, while being quick to flag would start calling
 * live sends "interrupted".
 */
export const BULK_STALE_AFTER_SECONDS = 300;

/**
 * The duplicate-risk boundary, stated exactly.
 *
 * When a process dies between claiming a recipient and recording the result,
 * one of two things happened and the recipient row alone cannot say which:
 *
 *   1. the send never reached WhatsApp — resending is correct; or
 *   2. WhatsApp accepted the message and the process died before writing it
 *      down — resending sends the patient the same message twice.
 *
 * The evidence that separates them is not in this table. `sendMessage()` writes
 * an ordinary `outbound_messages` row *before* it dispatches, so the presence of
 * such a row for this conversation, created at or after the claim, means case 2
 * is live and a resend is unsafe. Its absence means the send path never got far
 * enough to record anything, which is case 1.
 *
 * A missing `claimedAt` is treated as unsafe rather than safe: with no anchor
 * there is no window to look in, and the whole point of this function is to
 * refuse to guess.
 */
export function interruptedResendRisk(input: {
  claimedAt: string | null;
  /** `created_at` of manual outbound messages on this recipient's conversation. */
  outboundCreatedAt: readonly string[];
}): "safe_to_resend" | "duplicate_risk" {
  if (!input.claimedAt) return "duplicate_risk";
  const claimed = new Date(input.claimedAt).getTime();
  if (!Number.isFinite(claimed)) return "duplicate_risk";
  const sentSinceClaim = input.outboundCreatedAt.some((value) => {
    const created = new Date(value).getTime();
    return Number.isFinite(created) && created >= claimed;
  });
  return sentSinceClaim ? "duplicate_risk" : "safe_to_resend";
}

/**
 * Every stable code a recipient row can carry, and the i18n key that explains it
 * to staff.
 *
 * The codes stay in the database and the logs — they are stable, greppable, and
 * provider-neutral. Only the *rendering* is localized, and it is a total map so
 * a new code cannot quietly reach the UI as a raw enum: the parity test walks
 * this object.
 */
export const BULK_FAILURE_LABEL_KEYS = {
  // Skips, decided before sending.
  not_whatsapp: "failureReason.notWhatsapp",
  no_address: "failureReason.noAddress",
  conversation_closed: "failureReason.conversationClosed",
  // Interruption and its resolutions.
  interrupted: "failureReason.interrupted",
  interrupted_dismissed: "failureReason.interruptedDismissed",
  // Send failures, from SendErrorCode.
  INVALID_INPUT: "failureReason.invalidInput",
  EMAIL_SUBJECT_REQUIRED: "failureReason.generic",
  CHANNEL_LOOKUP_FAILED: "failureReason.channelUnavailable",
  NO_ACTIVE_CHANNEL: "failureReason.channelUnavailable",
  NOT_ENTITLED: "failureReason.notEntitled",
  SUBSCRIPTION_INACTIVE: "failureReason.subscriptionInactive",
  USAGE_LIMIT_REACHED: "failureReason.usageLimitReached",
  CREDENTIALS_UNAVAILABLE: "failureReason.channelUnavailable",
  CONVERSATION_NOT_FOUND: "failureReason.conversationNotFound",
  CONVERSATION_CLOSED: "failureReason.conversationClosed",
  SERVICE_WINDOW_CLOSED: "failureReason.serviceWindowClosed",
  TEMPLATE_NOT_APPROVED: "failureReason.templateUnavailable",
  TEMPLATE_PARAMETERS_INVALID: "failureReason.templateUnavailable",
  MEDIA_UNSUPPORTED: "failureReason.mediaUnsupported",
  MEDIA_UNAVAILABLE: "failureReason.mediaUnsupported",
  MEDIA_REQUEST_REJECTED: "failureReason.mediaUnsupported",
  MEDIA_STORAGE_FETCH_FAILED: "failureReason.mediaUnsupported",
  MEDIA_TRANSCODE_FAILED: "failureReason.mediaUnsupported",
  MEDIA_BAILEYS_SEND_FAILED: "failureReason.mediaUnsupported",
  RECORD_FAILED: "failureReason.generic",
  PROVIDER_SEND_FAILED: "failureReason.providerSendFailed",
  PROVIDER_SEND_AMBIGUOUS: "failureReason.providerSendAmbiguous",
} as const satisfies Record<string, string>;

export type BulkFailureCode = keyof typeof BULK_FAILURE_LABEL_KEYS;

/** The i18n key for a stored code, falling back to one honest generic sentence. */
export function bulkFailureLabelKey(code: string | null): string | null {
  if (!code) return null;
  return (
    (BULK_FAILURE_LABEL_KEYS as Record<string, string>)[code] ?? "failureReason.generic"
  );
}
