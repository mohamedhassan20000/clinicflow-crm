/**
 * The context firewall: five layers, and what each is allowed to influence.
 *
 * ## The failure this is built against
 *
 * `resolve_patient_ai_context` returned everything about a conversation and
 * everything about the patient on every turn, and any code that could reach it
 * could use any of it for any purpose. `prepare_booking` used that reach to
 * pull a doctor out of appointment *history* and write it in as a settled fact
 * about the *current* conversation. Nothing prevented it, because "durable
 * fact" and "thing the patient just said" were the same kind of value living in
 * the same object.
 *
 * ## The design
 *
 * Each layer is a separate type with a separate capability, and the ones that
 * must not create intent are not merely marked — they are **not present** in
 * the object the interpreter is given. The interpreter cannot commit a doctor
 * from memory for the same reason it cannot commit one from the moon: it has
 * never been shown one.
 *
 * | Layer | May create intent | May fill slots | May select tools | May shape wording |
 * |---|---|---|---|---|
 * | L1 current turn      | **yes** | yes | via command | yes |
 * | L2 current episode   | continue only | yes | no | yes |
 * | L3 active flow state | no | it *is* the slots | yes | yes |
 * | L4 durable facts     | **no** | as `Candidate` only | no | yes |
 * | L5 history           | **no** | no | no | on retrieval only |
 *
 * ## Why L4 is a function and not a field
 *
 * Because a field gets read. `DurableFactsLoader` makes every durable read an
 * explicit, audited request made *by a running flow step* that declared it
 * needs the fact — which is what "loaded lazily only when a flow explicitly
 * needs it" has to mean if it is to survive the next person to touch the file.
 * Its return type is {@link Candidate}, so even a fact that is loaded cannot be
 * committed without the patient's word (I-5).
 */

import "server-only";

import type { Candidate, FlowState } from "@/lib/ai/v2/flow-state";
import type { CommunicationStyle } from "@/lib/ai/communication-style";

/** L1 — the message that just arrived. The only creator of new intent. */
export type CurrentTurn = {
  readonly text: string;
  readonly receivedAt: string;
  readonly locale: "ar" | "en";
  /** Media the patient attached, described. Never used to decide intent. */
  readonly attachments: readonly { kind: string; readable: boolean }[];
};

/**
 * L2 — what has been said inside the current episode, oldest first.
 *
 * Bounded and episode-scoped, using the existing `EpisodeContext`, so this is
 * the same isolation guarantee P11O/P11T already established. It may *continue*
 * an active flow — that is what makes "the 10th" readable as an answer — but it
 * may not start one, because a message from six turns ago is not this turn.
 */
export type EpisodeTranscript = {
  readonly turns: readonly {
    readonly role: "patient" | "assistant";
    readonly text: string;
    readonly at: string;
  }[];
};

/**
 * L4 — a durable fact, on request.
 *
 * Every method returns candidates. There is no method that returns a committed
 * value, and that is the enforcement: a caller who wants to commit one has to
 * go through an offer and an `affirm_offer`, which requires the patient to have
 * answered.
 *
 * `null` from any of these means "not available, or not permitted" and is never
 * distinguished from "does not exist" at this boundary — which is also the
 * anti-existence-oracle rule (nothing here can tell a caller whether some
 * *other* person's record exists).
 */
export type DurableFactsLoader = {
  /** The doctors this patient has actually been treated by here. */
  treatingDoctors(): Promise<readonly Candidate<string>[]>;
  /** The departments they are known in. */
  knownDepartments(): Promise<readonly Candidate<string>[]>;
  /** Their active, unexhausted packages. */
  activePackages(): Promise<readonly Candidate<string>[]>;
  /** Documents already issued to them by a person. Never generated here. */
  issuedDocuments(): Promise<readonly Candidate<string>[]>;
  /** Their upcoming and pending appointments. */
  appointments(): Promise<readonly Candidate<string>[]>;
  /** The canonical name on file, once identity is established. */
  canonicalName(): Promise<string | null>;
};

/**
 * L5 — prior episodes.
 *
 * Retrieval only, and the return type says so: a `HistoricalExcerpt` is
 * labelled, quoted material that reaches the composer as *data*, never as
 * conversation turns the model continues (I-6). There is no method here that
 * returns something shaped like a transcript, because a transcript is what a
 * model replays.
 */
export type HistoricalRetrieval = {
  /**
   * Excerpts matching an explicit request, or an empty list.
   *
   * Never called speculatively. The only caller is a flow step whose whole
   * purpose is answering a question about the past.
   */
  search(query: { topic: string; limit?: number }): Promise<
    readonly HistoricalExcerpt[]
  >;
};

export type HistoricalExcerpt = {
  readonly at: string;
  readonly summary: string;
  readonly untrusted: true;
};

/**
 * Who the sender is, as far as the server can prove.
 *
 * Deliberately three states rather than a boolean. `linked` means the thread's
 * own number selects a file — enough to book on, never enough to disclose on.
 * `verified` is the identity proof that disclosure requires. The distinction
 * is the existing `identityVerifiedAt` / `bookingIdentityConfirmedAt` split and
 * is preserved exactly.
 */
export type IdentityLevel = "anonymous" | "linked" | "verified";

export type TurnContext = {
  readonly clinicId: string;
  readonly conversationId: string;
  /** L1. */
  readonly turn: CurrentTurn;
  /** L2. */
  readonly episode: EpisodeTranscript;
  /** L3. */
  readonly flows: FlowState;
  /** L4, lazily. */
  readonly durable: DurableFactsLoader;
  /** L5, on explicit retrieval. */
  readonly history: HistoricalRetrieval;
  readonly identity: IdentityLevel;
  /** Present only when identity is at least `linked`. Never model-supplied. */
  readonly patientId: string | null;
  readonly clinic: {
    readonly name: string;
    readonly timeZone: string;
    readonly locale: "ar" | "en";
    readonly country: string | null;
    readonly timeFormat: "12h" | "24h";
  };
  readonly style: CommunicationStyle;
  readonly now: Date;
};

/**
 * What the interpreter is allowed to see.
 *
 * This is the firewall, expressed as a projection rather than as a rule. L4 and
 * L5 are simply absent: there is no durable loader on this object and no
 * history retrieval, so no prompt the interpreter is built from can contain a
 * doctor the patient has not mentioned. It cannot emit
 * `set_slot(doctor, "Ahmed Nabil")` for a name it was never given.
 *
 * What it *does* get about the running flow is deliberately minimal: which flow
 * is active, which slots are already filled (by name, not value, except where
 * the value is needed to read a correction), and what is currently offered. The
 * offer is what makes a bare «اه» unambiguous.
 */
export type InterpreterView = {
  readonly turnText: string;
  readonly locale: "ar" | "en";
  readonly recentTurns: readonly {
    readonly role: "patient" | "assistant";
    readonly text: string;
  }[];
  readonly activeFlow: {
    readonly name: string;
    readonly filledSlots: readonly string[];
    readonly awaitingSlot: string | null;
  } | null;
  readonly parkedFlow: string | null;
  readonly suspendedFlow: string | null;
  readonly openOffer: {
    readonly id: string;
    readonly kind: string;
    readonly slot: string | null;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  } | null;
  readonly identity: IdentityLevel;
};

/**
 * Projects the full context down to what the model may see.
 *
 * The one function that crosses the firewall, so it is the one place to audit.
 * Note what it does *not* copy: `durable`, `history`, `patientId`, `clinicId`,
 * `conversationId`. A model that never receives an id cannot return one.
 */
export function interpreterView(
  context: TurnContext,
  options: { historyTurns?: number } = {},
): InterpreterView {
  const limit = options.historyTurns ?? 10;
  const active = firstWith(context.flows.stack, "active");
  const parked = firstWith(context.flows.stack, "parked");
  const suspended = firstWith(context.flows.stack, "suspended");
  const offer = active?.offer ?? null;
  return {
    turnText: context.turn.text,
    locale: context.turn.locale,
    recentTurns: context.episode.turns.slice(-limit).map((entry) => ({
      role: entry.role,
      text: entry.text,
    })),
    activeFlow: active
      ? {
          name: active.flow,
          filledSlots: Object.keys(active.slots),
          awaitingSlot: offer?.slot ?? null,
        }
      : null,
    parkedFlow: parked?.flow ?? null,
    suspendedFlow: suspended?.flow ?? null,
    openOffer: offer
      ? {
          id: offer.id,
          kind: offer.kind,
          slot: offer.slot,
          options: offer.options.map((option) => ({
            id: option.id,
            label: option.label,
          })),
        }
      : null,
    identity: context.identity,
  };
}

function firstWith(
  stack: FlowState["stack"],
  status: "active" | "parked" | "suspended",
) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index]!;
    if (frame.status === status) return frame;
  }
  return null;
}
