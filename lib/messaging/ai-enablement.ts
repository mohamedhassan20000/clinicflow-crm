/**
 * P15 — whether the Patient Assistant may answer a given WhatsApp thread.
 *
 * One function, one precedence rule, used by the server path that actually
 * invokes the assistant *and* by the UI that explains the state to staff. The
 * UI is a mirror of this decision, never a second implementation of it.
 *
 * ### The precedence
 *
 *   effectiveAiEnabled =
 *     conversation override, if the clinic has explicitly set one
 *     otherwise the clinic-wide setting
 *
 * That is the whole model, and it is deliberately symmetric:
 *
 *   * **Global ON** — the assistant answers everywhere, and the clinic can
 *     exclude individual conversations (`override = false`).
 *   * **Global OFF** — the assistant answers nowhere, and the clinic can admit
 *     individual conversations (`override = true`).
 *
 * ### Why the global setting is `clinics.ai_reply_mode` and not a new column
 *
 * `ai_reply_mode` already exists, is already entitlement-gated, is already the
 * value the orchestrator refuses to speak without, and already has three
 * meaningful positions: `off`, `suggest` (draft for staff, never send), and
 * `auto` (send). A second clinic-level boolean beside it would be a second
 * thing to keep in sync with the first, and the first would keep winning —
 * exactly the failure this pass exists to remove. "AI replies ON" is
 * `suggest`/`auto`; "AI replies OFF" is `off`.
 *
 * ### Why the per-conversation override is one nullable boolean
 *
 * Three states, and all three are needed: *follow the clinic* (null), *never
 * here* (false), *always here* (true). A pair of booleans, or a boolean plus a
 * flag, can represent a fourth state that means nothing, and something would
 * eventually write it.
 *
 * ### How this relates to Pause AI
 *
 * `ai_paused_at` is the human-takeover marker: a staff member saying *I have
 * this one*. It remains its own column, it remains what the thread header and
 * the takeover banner read, and it always suppresses automatic sending.
 *
 * The Pause AI control writes that column and *only* that column. It does not
 * touch the override, which is what makes a takeover perfectly reversible:
 * whatever exception the thread carried before the pause, it carries after the
 * resume, because nothing wrote to it in between.
 *
 * That separation is load-bearing rather than tidy. `false` is `false`: if the
 * pause stored its suppression in the override, no later read could tell it
 * apart from an exclusion the clinic set deliberately, and the resume would
 * have to guess which one it was undoing. Keeping the two facts in two columns
 * and combining them *here*, at read time, is what removes the guess — the
 * single question "will the assistant answer here?" has a single answer
 * because one function computes it, not because one column stores it.
 *
 * A row paused before P15 has `ai_paused_at` set and no override; the pause is
 * still honoured, because it is checked independently below.
 *
 * ### Why the Inbox shows two controls rather than one three-position one
 *
 * Pause AI and the per-conversation exception look similar and are not the
 * same decision, so collapsing them would make one of them unsayable.
 *
 * *Pause AI* is "I am answering this one, right now" — a takeover a colleague
 * starts when they pick a thread up and ends when they are done with it. It is
 * momentary, it belongs to whoever is on shift, and the assistant is expected
 * back afterwards.
 *
 * *The exception* is a standing decision the clinic sets and leaves set:
 * exclude a number the assistant should never talk to, or admit one while the
 * assistant is switched off everywhere else. Nobody expects it to expire.
 *
 * Folding the exception into the Pause control would mean a receptionist
 * finishing a conversation silently undoing a clinic-level decision — which is
 * exactly why `set_conversation_ai_pause` does not write the exception at all,
 * in either direction.
 *
 * The Inbox therefore renders the exception as its own control, offering the
 * state the clinic setting is not already producing, with one button rather
 * than a menu: "follow the clinic" or the opposite of what the clinic is doing
 * is the whole space of things a staff member ever wants to say here.
 */

/** The clinic-wide patient reply mode, as stored on `clinics.ai_reply_mode`. */
export type ClinicAiReplyMode = "off" | "suggest" | "auto";

/**
 * The per-conversation exception, as stored on
 * `conversations.ai_enabled_override`.
 *
 * `null`/`undefined` both mean "no exception — follow the clinic".
 */
export type ConversationAiOverride = boolean | null | undefined;

export type EffectiveAiInput = {
  clinicMode: ClinicAiReplyMode;
  override: ConversationAiOverride;
  /** `conversations.ai_paused_at`. Non-null always suppresses. */
  aiPausedAt?: string | null;
};

/**
 * Why the assistant is or is not answering this thread.
 *
 * Returned rather than inferred by the caller so the Inbox can explain the
 * state in one sentence without re-deriving it, and so a log line can say
 * which rule fired.
 */
export type EffectiveAiReason =
  /** A staff member has taken this thread over. */
  | "human_takeover"
  /** The clinic excluded this conversation while the assistant is on. */
  | "conversation_disabled"
  /** The clinic admitted this conversation while the assistant is off. */
  | "conversation_enabled"
  /** No exception; the clinic-wide setting decided. */
  | "clinic_setting";

export type EffectiveAiDecision = {
  enabled: boolean;
  reason: EffectiveAiReason;
  /** True when a per-conversation exception, rather than the clinic, decided. */
  overridden: boolean;
};

/**
 * The single authoritative answer to "may the assistant answer this thread?".
 *
 * Note the asymmetry that is deliberate rather than an oversight: an override
 * of `true` admits a conversation the clinic setting would have excluded, but
 * it cannot overrule a human takeover. A staff member is in the thread; no
 * clinic-level or per-thread configuration outranks that.
 */
export function resolveEffectiveConversationAi(
  input: EffectiveAiInput,
): EffectiveAiDecision {
  if (input.aiPausedAt) {
    return { enabled: false, reason: "human_takeover", overridden: true };
  }
  if (input.override === true) {
    return { enabled: true, reason: "conversation_enabled", overridden: true };
  }
  if (input.override === false) {
    return { enabled: false, reason: "conversation_disabled", overridden: true };
  }
  return {
    enabled: input.clinicMode !== "off",
    reason: "clinic_setting",
    overridden: false,
  };
}

/** The boolean alone, for callers that do not need to explain themselves. */
export function effectiveConversationAiEnabled(input: EffectiveAiInput): boolean {
  return resolveEffectiveConversationAi(input).enabled;
}

/** Whether the clinic-wide switch is on at all, for the settings control. */
export function clinicAiRepliesEnabled(mode: ClinicAiReplyMode): boolean {
  return mode !== "off";
}
