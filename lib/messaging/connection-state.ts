/**
 * P6C connection-state machine (§8 P6C).
 *
 * A derived per-channel state for Meta-direct WhatsApp channels. Every state is
 * a pure function of *stored operational signals* (the `p6_channel_state_columns`
 * on `clinic_channels` plus the P3B template approval sync) — never invented, and
 * never derived from raw Meta payload text. This module has no I/O; the webhook
 * and the reconciliation poll normalize provider callbacks into `ChannelStateSignals`
 * and this function decides the state. Because it is pure, "unknown payloads never
 * invent a state" and "the same Graph response twice → one state" are plain unit
 * assertions.
 *
 * Honesty rules (plan lines 1282, 1310): no review-time estimate is ever encoded
 * here (only decision states); failure reasons are mapped to a small closed set of
 * sanitized codes — a raw Meta code/message is collapsed to a generic code and the
 * UI localizes the code, so no provider text reaches the client.
 */

export type ConnectionState =
  | "connecting_to_meta"
  | "waiting_phone_verification"
  | "business_verification_in_progress"
  | "templates_pending"
  | "connected"
  | "verification_failed";

/**
 * Sanitized, closed set of failure reason codes. The UI maps each to a localized
 * string (`settings.connectionReason.<code>`). Unknown provider codes collapse to
 * `generic` — a raw Meta payload never becomes one of these.
 */
export type ConnectionFailureReason =
  | "business_verification_rejected"
  | "business_verification_expired"
  | "phone_number_banned"
  | "phone_number_restricted"
  | "account_restricted"
  | "account_disabled"
  | "generic";

/**
 * Operational signals read from the channel row. All optional: a channel that has
 * only just completed the popup has none of them yet and derives to
 * `connecting_to_meta`. Values are the provider's own status strings (normalized
 * case-insensitively here), plus the derived approved-template count from the P3B
 * sync. `failureReason` is the *raw* provider signal; it is sanitized before it is
 * ever stored or shown.
 */
export type ChannelStateSignals = {
  /** clinic_channels.status — the local activation flag. */
  channelStatus?: "pending" | "active" | "error" | null;
  /** Meta WABA business/account verification status. */
  businessVerificationStatus?: string | null;
  /** Meta phone-number connection status. */
  phoneStatus?: string | null;
  /** Account review decision carried on `account_review_update`. */
  accountReviewStatus?: string | null;
  /** Provider-side confirmation that our app is subscribed to this WABA. */
  webhookSubscribed?: boolean | null;
  /** Count of approved templates for this clinic (P3B approval sync). */
  approvedTemplateCount?: number | null;
  /** Meta phone quality rating — carried for storage; does not gate the state. */
  qualityRating?: string | null;
  /** Meta messaging limit tier — carried for storage; does not gate the state. */
  messagingLimitTier?: string | null;
  /** Raw provider failure signal — sanitized by this module, never stored raw. */
  failureReason?: string | null;
};

export type DerivedConnectionState = {
  state: ConnectionState;
  /** Present only when `state === "verification_failed"`. */
  reason: ConnectionFailureReason | null;
};

function lower(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

type VerificationClass = "verified" | "pending" | "rejected" | "unknown";

/** Collapses Meta's many business-verification strings into three decisions. */
function classifyVerification(value: string | null | undefined): VerificationClass {
  const v = lower(value);
  if (!v) return "unknown";
  if (v === "verified") return "verified";
  if (v.includes("reject") || v.includes("fail") || v.includes("revok") || v.includes("expir")) {
    return "rejected";
  }
  if (v.includes("pending") || v === "not_verified" || v.includes("review") || v.includes("submit")) {
    return "pending";
  }
  return "unknown";
}

type PhoneClass = "connected" | "pending" | "blocked" | "unknown";

/** Collapses Meta phone-number statuses into gating classes. */
function classifyPhone(value: string | null | undefined): PhoneClass {
  const v = lower(value);
  if (!v) return "unknown";
  if (v === "connected" || v === "verified") return "connected";
  if (v.includes("ban") || v.includes("restrict") || v.includes("delete") || v.includes("disabl")) {
    return "blocked";
  }
  if (v.includes("pending") || v.includes("unverified") || v.includes("flag") || v.includes("migrat")) {
    return "pending";
  }
  return "unknown";
}

/**
 * Maps a raw provider failure signal to a sanitized, closed-set code. Keyword
 * matching only — the raw string is never returned, so no Meta text escapes.
 */
export function sanitizeFailureReason(
  raw: string | null | undefined,
): ConnectionFailureReason {
  const v = lower(raw);
  if (!v) return "generic";
  if (v.includes("ban")) return "phone_number_banned";
  if (v.includes("restrict")) {
    return v.includes("account") ? "account_restricted" : "phone_number_restricted";
  }
  if (v.includes("disabl")) return "account_disabled";
  if (v.includes("expir")) return "business_verification_expired";
  if (v.includes("reject") || v.includes("fail") || v.includes("revok") || v.includes("declin")) {
    return "business_verification_rejected";
  }
  return "generic";
}

/**
 * Derives the connection state from stored signals. Pure and total: any input,
 * including all-empty or all-unknown signals, yields a defined state. A state is
 * only reachable from its defining signal, so an unrecognized payload leaves the
 * channel in its earliest honest state (`connecting_to_meta`) rather than
 * fabricating progress.
 */
export function deriveConnectionState(
  signals: ChannelStateSignals,
): DerivedConnectionState {
  const businessVerification = classifyVerification(signals.businessVerificationStatus);
  const phone = classifyPhone(signals.phoneStatus);
  const review = lower(signals.accountReviewStatus);
  const reviewApproved = review === "approved";
  const verification = reviewApproved ? "verified" : businessVerification;
  const approved = signals.approvedTemplateCount ?? 0;

  // 1. Terminal failure signals win regardless of progress. The reason is taken
  //    from the most specific available signal and sanitized to a closed code.
  if (phone === "blocked") {
    return { state: "verification_failed", reason: sanitizeFailureReason(signals.phoneStatus) };
  }
  if (verification === "rejected") {
    return {
      state: "verification_failed",
      reason: sanitizeFailureReason(signals.failureReason ?? signals.businessVerificationStatus),
    };
  }
  if (review.includes("reject") || review.includes("disabl") || review.includes("restrict")) {
    return {
      state: "verification_failed",
      reason: sanitizeFailureReason(signals.failureReason ?? signals.accountReviewStatus),
    };
  }
  if (
    signals.webhookSubscribed === false &&
    phone === "connected" &&
    verification === "verified"
  ) {
    return { state: "verification_failed", reason: "generic" };
  }

  // 2. Phone must be connected before anything downstream can be claimed.
  if (phone === "pending") return { state: "waiting_phone_verification", reason: null };
  if (phone === "connected") {
    if (verification === "verified") {
      return approved >= 1 && signals.webhookSubscribed === true
        ? { state: "connected", reason: null }
        : { state: "templates_pending", reason: null };
    }
    // Phone is up but the business review is still outstanding (or unknown).
    return { state: "business_verification_in_progress", reason: null };
  }

  // 3. No usable phone signal yet: the popup returned but nothing has synced.
  return { state: "connecting_to_meta", reason: null };
}

/** Whether a derived state is a settled outcome the wizard can stop polling on. */
export function isTerminalConnectionState(state: ConnectionState): boolean {
  return state === "connected" || state === "verification_failed";
}
