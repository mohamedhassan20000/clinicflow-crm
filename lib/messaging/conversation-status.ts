/**
 * P15 — the one authoritative derivation of an Inbox conversation's
 * user-facing status.
 *
 * There are exactly seven visible statuses and there is exactly one function
 * that decides which one a thread wears. The conversation list badge, the
 * Inbox status filter, any count over those statuses and the tests all read
 * this module; nothing re-derives a status from raw columns anywhere else.
 *
 * Internal facts stay internal. `status` (open/closed), `ai_paused_at`,
 * assignment, patient linkage, booking stage and episode state are all still
 * the source data — they are simply never *shown* as statuses of their own.
 *
 *   | Visible status      | Key                | Means                              |
 *   |---------------------|--------------------|------------------------------------|
 *   | Problem             | `problem`          | something is technically broken     |
 *   | Needs human review  | `needsReview`      | a person at the clinic must act     |
 *   | Done                | `done`             | finished and resting                |
 *   | New contact         | `newContact`       | unknown sender, assistant not yet in |
 *   | Active conversation | `humanHandling`    | a person here is answering it       |
 *   | Awaiting patient    | `waitingPatient`   | the patient's message is unanswered |
 *   | AI handling         | `aiHandling`       | the assistant owns the thread       |
 *
 * ### Why the precedence changed in P15
 *
 * Before P15 `done` outranked everything, because closing a thread was the one
 * decision a human made directly. That is still true of *staff* closing a
 * thread — but P15 introduces two endings the machine reaches on its own, and
 * both of them must survive the episode closing:
 *
 *   * a genuine technical failure closes the episode and must still read
 *     `Problem`, otherwise the one badge that means "this is actually broken"
 *     is erased by the very code path that broke, and
 *   * an episode that staged a patient file or a booking request closes
 *     normally and must still read `Needs human review` until the clinic has
 *     actually reviewed it. "The conversation ended" is not "the work is done".
 *
 * So `problem` and `needsReview` now sit above `done`. Both are driven by
 * durable facts that clear themselves — the failure latch is cleared when the
 * thread is worked, the review obligation disappears when the artifacts are
 * reviewed — so neither can pin a badge to a thread forever.
 */

/**
 * The authoritative Inbox status registry, in display/precedence order.
 *
 * Consumers such as the Inbox filter iterate this tuple rather than keeping a
 * second list of statuses that can drift from {@link conversationBadgeState}.
 * There are seven and there is no eighth: a status that is not in this tuple
 * cannot be produced, labelled, filtered or styled.
 */
export const CONVERSATION_BADGE_STATES = [
  "done",
  "problem",
  "needsReview",
  "newContact",
  "humanHandling",
  "waitingPatient",
  "aiHandling",
] as const;

export type ConversationBadgeState = (typeof CONVERSATION_BADGE_STATES)[number];

/** The authoritative fields this derivation reads. Deliberately structural, so
 * both the conversation list and the thread header can pass what they hold. */
export type ConversationStatusInput = {
  status: "open" | "closed" | (string & {});
  /** `conversations.ai_escalated_at` — the AI asked for a human. */
  escalatedAt?: string | null;
  /** True when the thread carries an outbound message that failed to deliver. */
  hasDeliveryFailure?: boolean | null;
  /** `conversations.last_message_at` — newest message either way. */
  lastMessageAt?: string | null;
  /** Newest *inbound* message, i.e. the last time the patient said anything. */
  lastInboundAt?: string | null;
  /**
   * `conversations.patient_id`. `null` is a real answer — nobody is linked —
   * and `undefined` means the caller did not read the column.
   */
  patientId?: string | null;
  /**
   * P11T — `conversations.current_episode_id is not null`.
   *
   * `undefined` means the caller did not read it, and the status falls back to
   * the pre-P11T derivation. `false` means the thread is resting: Done.
   */
  hasActiveEpisode?: boolean | null;
  /**
   * P8 — `conversations.ai_paused_at`. Non-null while a staff member has taken
   * the thread over from the assistant.
   *
   * P15 keeps reading it, because it is still the column the Pause AI control
   * writes and still the strongest per-conversation "the assistant is not
   * answering here" signal. It is now expressed through `aiEnabled` rather
   * than being its own badge rule — see {@link effectiveAiEnabledFor}.
   */
  aiPausedAt?: string | null;
  /**
   * P15 — `conversations.ai_technical_failure_at`.
   *
   * Set only when the assistant should have handled a live inbound turn and a
   * genuine technical fault stopped it: a provider failure, an orchestration
   * or tool failure that cannot safely recover, a required backend error.
   * Never set for ordinary conversational outcomes — an ambiguous message, a
   * slot the clinic does not have free, a question the assistant does not
   * answer, a validation prompt. Those are conversation, not breakage.
   */
  aiTechnicalFailureAt?: string | null;
  /**
   * P15 — the episode created something a person at the clinic still has to
   * review: a staged patient file, a booking request, or both.
   *
   * One boolean because one badge. A conversation that staged *both* a file
   * and a booking is not twice as reviewable, and splitting it would put two
   * statuses on one row. It goes false only when every outstanding obligation
   * has actually been reviewed, which is what turns the thread into `done`.
   *
   * `undefined` means the caller did not read it.
   */
  hasOutstandingReview?: boolean | null;
  /**
   * P15 — whether the Patient Assistant is allowed to answer *this* thread
   * right now: the clinic-wide setting, overridden per conversation where the
   * clinic has said so. See `lib/messaging/ai-enablement.ts`, which is the one
   * place that resolves it.
   *
   * `undefined` means the caller did not read it, and the derivation falls
   * back to `aiPausedAt` alone — the pre-P15 reading.
   */
  aiEnabled?: boolean | null;
  /**
   * P15 — when the assistant last sent a message inside the current episode.
   *
   * This is what makes `New contact` a *stage* rather than a permanent label
   * on an unlinked number: the moment the assistant has actually answered, the
   * thread is being handled and says so. Null means it has not spoken yet in
   * this episode; `undefined` means the caller did not read it, in which case
   * the pre-P15 reading (unlinked ⇒ New contact) stands.
   */
  lastAssistantReplyAt?: string | null;
  /**
   * P15 — when a *person at the clinic* last replied on this thread, live.
   *
   * Both routes count and neither is guessed: a reply sent from ClinicFlow,
   * and the legitimate live outbound echo of a reply typed on the clinic's own
   * linked handset. A historical outbound imported by the history sync is not
   * a live human reply and is never recorded here — importing a year of chat
   * must not relabel a year of threads as actively handled.
   */
  lastHumanReplyAt?: string | null;
};

/**
 * Whether the assistant is answering this thread, as the badge should read it.
 *
 * Two inputs, one of which is legacy. `aiEnabled` is the resolved answer from
 * `lib/messaging/ai-enablement.ts` (clinic setting + per-conversation
 * override). `aiPausedAt` is the human-takeover column, and it always wins
 * towards *off*: a staff member holding a thread is holding it whatever the
 * clinic setting says, and that is the behaviour P8 shipped and P15 keeps.
 *
 * A caller that read neither gets `true`, i.e. the pre-P15 reading, rather
 * than having every thread relabelled.
 */
function effectiveAiEnabledFor(input: ConversationStatusInput): boolean {
  if (input.aiPausedAt) return false;
  return input.aiEnabled ?? true;
}

/**
 * True when a person at the clinic has spoken more recently than the patient.
 *
 * The comparison is against the patient's newest message, not against the
 * thread's newest message, because the assistant's own replies must not read
 * as human handling — that is the whole distinction between `aiHandling` and
 * `humanHandling`.
 *
 * A human reply with no inbound message to compare against still counts: the
 * clinic has spoken and nobody is waiting on them.
 */
function humanRepliedLast(input: ConversationStatusInput): boolean {
  if (!input.lastHumanReplyAt) return false;
  if (!input.lastInboundAt) return true;
  return new Date(input.lastHumanReplyAt).getTime() > new Date(input.lastInboundAt).getTime();
}

/**
 * True when the patient has spoken last and nobody at the clinic has answered.
 *
 * Only ever consulted once the assistant has been established as *not*
 * answering this thread, so this is literally "a patient message is sitting
 * unanswered in front of the clinic".
 */
function patientWaitingOnClinic(input: ConversationStatusInput): boolean {
  if (!input.lastInboundAt) return false;
  if (humanRepliedLast(input)) return false;
  if (!input.lastMessageAt) return true;
  // The fallback for a caller that has not read `lastHumanReplyAt`, and for a
  // reply recorded before P15 gave outbound rows their provenance: this branch
  // is only reached once the assistant has been established as *not* answering
  // this thread, so anything on it newer than the patient's message can only
  // have come from a person at the clinic. Reading it as such is what stops a
  // taken-over thread a colleague is mid-sentence in from being announced as
  // an unanswered message.
  return new Date(input.lastMessageAt).getTime() <= new Date(input.lastInboundAt).getTime();
}

export function conversationBadgeState(
  input: ConversationStatusInput,
): ConversationBadgeState {
  // 1. Something is actually broken. A latched technical failure and an
  //    undelivered outbound message are the only two things that mean it, and
  //    both outrank the episode ending — the failure is what ended it.
  if (input.aiTechnicalFailureAt) return "problem";
  if (input.hasDeliveryFailure === true) return "problem";

  // 2. A person at this clinic has to do something. An outstanding review
  //    obligation survives the episode closing by design (§G): the
  //    conversation is over, the work is not.
  if (input.hasOutstandingReview === true) return "needsReview";
  if (input.escalatedAt) return "needsReview";

  // 3. Resting. Staff Close, the patient saying they need nothing more, and
  //    the idle timer all land here.
  if (input.status === "closed") return "done";
  // Explicitly false only. `undefined` is "not read", and treating it as "no
  // episode" would relabel every thread Done for any caller that has not been
  // updated to select the column.
  if (input.hasActiveEpisode === false) return "done";

  // 4. A live thread with nobody linked to it, *before* the assistant has
  //    answered. Once it has, the thread is being handled and says so — an
  //    unlinked number the assistant is mid-conversation with is not news any
  //    more, and leaving it on `New contact` forever is how that badge stops
  //    meaning "somebody just arrived".
  //
  //    `lastAssistantReplyAt === undefined` is a caller that has not read the
  //    column, and keeps the pre-P15 reading rather than silently dropping the
  //    state.
  if (input.patientId === null && !input.lastAssistantReplyAt) return "newContact";

  const aiEnabled = effectiveAiEnabledFor(input);

  // 5. A person here answered more recently than the patient wrote. True
  //    whether they answered from ClinicFlow or from the clinic's own handset;
  //    the echo path records both the same way.
  if (humanRepliedLast(input)) return "humanHandling";

  // 6. The assistant is not answering this thread and the patient's message is
  //    unanswered — the clinic owes them a reply. This is the case the Inbox
  //    previously called `aiHandling`, on precisely the threads where no AI
  //    was going to speak.
  if (!aiEnabled && patientWaitingOnClinic(input)) return "waitingPatient";

  // 7. The assistant is not answering, and nobody is waiting on the clinic
  //    either. A person owns this thread; it is not the assistant's.
  if (!aiEnabled) return "humanHandling";

  // 8. A live episode the assistant is working.
  return "aiHandling";
}

/**
 * The design-system classes each state wears.
 *
 * Semantic tokens where the system has one (`primary`, `destructive`, `muted`)
 * and the shared Tailwind ramp elsewhere, always as a `/N` tint over a matching
 * foreground so both themes stay legible — the same construction the existing
 * verified/paused badges in this Inbox already use. No hex values.
 *
 * The states are deliberately far apart on the wheel — blue, grey, amber,
 * purple, emerald, red — because the whole point of the badge is being readable
 * at a glance down a column of eighty rows. Two states that need a second look
 * to tell apart are two states that will be confused.
 */
export const CONVERSATION_BADGE_CLASSES: Record<ConversationBadgeState, string> = {
  // Live, informational, the assistant is working.
  aiHandling: "border-primary/30 bg-primary/10 text-primary",
  // The same active informational family as `aiHandling` — because that is what
  // it is, a live thread the assistant is about to answer — carried a shade
  // louder so the two are still separable at a glance.
  newContact: "border-primary/50 bg-primary/15 text-primary",
  // Resting. Deliberately the quietest thing in the list.
  done: "border-muted-foreground/30 bg-muted text-muted-foreground",
  // A person has to do something.
  needsReview: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  // A person at this clinic is actively holding the thread.
  humanHandling: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  // The patient is waiting on us.
  waitingPatient: "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  // Something is actually broken.
  problem: "border-destructive/30 bg-destructive/10 text-destructive",
};
