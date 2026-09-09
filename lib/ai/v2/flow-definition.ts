/**
 * What a flow *is*, as data.
 *
 * ## Why declarative
 *
 * The engine this replaces expressed its business logic as 305 `if` branches
 * spread over five files, and the ordering constraints between them lived in
 * comments ("has to be read before the pre-commit rather than after it"). Every
 * new case was a new branch, and the branch count is what made the behaviour
 * unpredictable.
 *
 * A flow here is a list of steps and a dependency map. The engine walks it. The
 * *only* imperative code a flow may carry is a step's `resolve`, which asks an
 * authoritative tool a question and returns options — it cannot write, it
 * cannot choose, and it cannot see the model.
 *
 * The rule that keeps this from becoming the next patch surface: **a flow
 * definition contains no conditional business logic.** If a definition needs an
 * `if`, the thing it is deciding belongs in the engine, in one place, tested
 * without a model.
 */

import type { FlowName, SlotName } from "@/lib/ai/v2/commands";
import type { Candidate, FlowFrame, OfferKind } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";

/**
 * What a step needs before the engine may run it.
 *
 * Declarative, and evaluated against the frame's own committed slots — never
 * against durable memory (I-7). `list_available_days` is unreachable until
 * `department` and `doctor` are committed *in this frame*, and a doctor sitting
 * in the patient's appointment history satisfies neither.
 */
export type StepPrecondition = {
  /** Slots that must hold a committed value. */
  readonly slots: readonly SlotName[];
  /**
   * Whether the patient's identity must be established first.
   *
   * `none` — clinic-public, answerable to anyone.
   * `linked` — the thread's own number selects a file.
   * `verified` — full identity proof. Required by everything that discloses a
   * patient's own record: documents, packages, appointment history.
   */
  readonly identity: "none" | "linked" | "verified";
};

/** A step's result: what the engine should put in front of the patient. */
export type StepOutcome =
  | {
      /** Ask for this slot, offering these options. */
      readonly kind: "offer";
      readonly slot: SlotName | null;
      readonly offerKind: OfferKind;
      readonly options: readonly Candidate<string | number>[];
      /**
       * Index of the option a bare "yes" accepts, when `say` poses a yes/no
       * about one of them. Omitted for a plain list. See {@link Offer.primaryOptionId}.
       */
      readonly primary?: number;
      /** Copy key the composer renders. Never prose from a tool. */
      readonly say: string;
      readonly facts?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Ask an open question — no option set, because there is none. */
      readonly kind: "ask";
      readonly slot: SlotName | null;
      readonly say: string;
      readonly facts?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Say something and finish the flow. */
      readonly kind: "complete";
      readonly say: string;
      readonly facts?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Report a real-world answer that is not a failure — "no days free". */
      readonly kind: "inform";
      readonly say: string;
      readonly facts?: Readonly<Record<string, unknown>>;
      /**
       * Server-issued scalars to record on the frame for later steps.
       *
       * Deliberately as narrow as {@link FlowFrame.memo} itself: ids the server
       * returned and flags it set, never patient text and never a decision. A
       * step resolving an appointment into the doctor whose calendar the next
       * two steps read is the case this exists for — without it the identifiers
       * would have to be re-fetched per step, and two steps could then disagree
       * about whose diary they are in.
       */
      readonly memo?: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      /**
       * Commit a slot the server derived from slots already committed.
       *
       * The third and last legitimate provenance (I-5): not the patient's
       * words, not their acceptance of an offer, but a value computed from
       * something they already settled — the Latin rendering of a name they
       * gave, the department implied by a doctor they chose.
       *
       * Deliberately *not* a way to write durable memory into a slot. The
       * inputs a step may derive from are its own frame's committed slots, and
       * a step that reached for `context.durable` here would be writing exactly
       * what `Candidate` exists to prevent. The engine re-advances after a
       * fill, so a derivation costs the patient no turn.
       */
      readonly kind: "fill";
      readonly slot: SlotName;
      readonly value: string | number;
      readonly label?: string;
    }
  | {
      /**
       * The world moved under a committed slot. Undo it and go back.
       *
       * The case this exists for is the booking collision: the patient chose a
       * time, confirmed it, and by the moment the write ran somebody else had
       * taken it. Nothing was created, so the flow has not finished — but the
       * `time` slot now holds a value the clinic will never accept, and the
       * confirmation the patient gave was a confirmation *of that time*.
       *
       * Returning `inform` there ended the flow: the patient was asked "shall
       * we look at other times?" by a conversation that had just thrown away
       * everything it knew, so answering meant starting the booking again.
       * Returning `ask` would have been worse — the step is not marked done by
       * either, so the next turn would re-run the write with `confirmed` still
       * true and book whatever had landed in the slot.
       *
       * `invalidate` is the third answer: clear the named slots and the memo
       * flags that were about them, keep the frame alive, and let the engine
       * re-advance to the first step whose slot is now empty. The write is not
       * retried, because the consent that authorised it was cleared with the
       * value it was about — a fresh summary and a fresh `affirm_offer` are
       * required before anything is written again.
       *
       * Slots are cleared with their dependency cascade, so this cannot leave a
       * frame holding a value derived from something that is now gone.
       */
      readonly kind: "invalidate";
      /** Slots to drop. Their dependents go with them. */
      readonly slots: readonly SlotName[];
      /** Memo keys to drop — the flags that were *about* those slots. */
      readonly memo?: readonly string[];
      /**
       * Values this frame may not be offered again.
       *
       * The loop-breaker for a refused write. When the booking RPC says a slot
       * is unavailable and the availability read still shows it free — a
       * pending row somebody else holds is invisible to `computeAvailability` —
       * dropping the slot and re-reading offers the patient the very time that
       * was just refused, and the turn repeats for as long as they keep
       * choosing it. Recording the refusal means the next offer is built
       * without it, on this frame only and for this booking only.
       *
       * Same field the doctor step's «لا دكتور تاني» writes, used the same way:
       * a negative constraint, never a positive one.
       */
      readonly reject?: readonly { readonly slot: SlotName; readonly value: string }[];
      readonly say: string;
      readonly facts?: Readonly<Record<string, unknown>>;
    }
  | {
      /** The step cannot proceed and a person should take over. */
      readonly kind: "handoff";
      readonly say: string;
    };

export type FlowStep = {
  readonly id: string;
  /** The slot this step exists to fill, or null for a step that acts. */
  readonly fills: SlotName | null;
  readonly pre: StepPrecondition;
  /**
   * Runs the authoritative read or write behind this step.
   *
   * Given the frame and the turn's context, and nothing else — in particular
   * not the model's output, which has already been reduced to commands by the
   * time any step runs. A step may call tools; it may not decide what the
   * patient meant.
   */
  readonly run: (input: {
    frame: FlowFrame;
    context: TurnContext;
  }) => Promise<StepOutcome>;
  /**
   * Grounds the patient's words for this step's slot against clinic data.
   *
   * Declared per step because only the step knows what its slot is about: a
   * doctor is matched against the roster, a day against the calendar, a
   * national id against a format. Three answers, and the engine's response to
   * each is uniform — `resolved` commits, `ambiguous` asks which, `unresolved`
   * asks again. None of the three is available to the model, which is what
   * stops "Dr Ahmed" from silently selecting one of two Ahmeds.
   *
   * Omitted for free-text slots whose value is validated by the write behind
   * them (a name, an email). Never omitted for a slot that selects a record.
   */
  readonly resolveValue?: (input: {
    spoken: string;
    /**
     * The slot being filled.
     *
     * Redundant for a step that fills exactly one, and load-bearing for a
     * {@link FlowStep.collects} step, which validates several. Passed always so
     * a resolver never has to infer which question it is answering.
     */
    slot: SlotName;
    frame: FlowFrame;
    context: TurnContext;
  }) => Promise<SlotResolution>;
  /**
   * Additional slots this step may accept an answer for.
   *
   * The intake case, and the reason it exists. A `fills: null` step that asks
   * for a name, then a national id, then a date of birth is one step asking a
   * sequence of questions — but `set_slot` resolves the owning step by
   * `fills`, so an answer to any of those questions belonged to no step at all
   * and was **dropped**. The patient's name was collected, discarded, and asked
   * for again on the next turn, forever; nothing downstream of it could ever
   * run, so no third-party file was ever staged and no booking was ever
   * written for one.
   *
   * Declaring the slots a step collects is what makes those answers land. It is
   * data, not a branch: the engine still validates every value through
   * `resolveValue` and still commits nothing it cannot ground.
   */
  readonly collects?: readonly SlotName[];
  /**
   * True when this step's `resolveValue` is total over the patient's own words.
   *
   * Every other resolver grounds against something the clinic *has* — a
   * roster, a calendar, a directory — so the patient's words only mean
   * something in the presence of a live read. This one does not: `beneficiary`
   * is a two-value canonical slot, and "who is this for?" is answered in prose
   * that a lexicon settles on its own.
   *
   * The engine uses the flag for exactly one thing (see
   * `reconcileCanonicalAnswer`): while such a step's offer is open, the
   * deterministic reading of the turn text outranks whichever command the
   * interpreter emitted about it. Manual QA is why. «لحد تاني» arrived as an
   * `affirm_offer` against a two-option offer — the model's honest reading of
   * "answer THE OPEN OFFER" — and a bare affirmation of a two-option offer is
   * ambiguous by construction, so the engine asked which one and the patient
   * was shown the enum. The words were unambiguous the whole time; nothing but
   * the command shape said otherwise.
   *
   * Deliberately narrow. It is *not* a licence to re-read the turn text for
   * slots that select a record: "لا مش الجلدية" contains a department name,
   * and a rejection that resolves against the roster is how a patient gets
   * booked into the thing they just refused.
   */
  readonly canonicalAnswer?: boolean;
  /**
   * Slots invalidated when this step's slot is corrected.
   *
   * The correction cascade, as data. `day` lists `time`, so correcting the day
   * drops the time without anybody writing that branch — and adding a slot
   * later cannot forget to.
   */
  readonly invalidates?: readonly SlotName[];
};

/** What grounding the patient's words produced. See {@link FlowStep.resolveValue}. */
export type SlotResolution =
  | { kind: "resolved"; value: string | number; label?: string }
  | {
      kind: "ambiguous";
      options: readonly {
        value: string | number;
        label: string;
        source: Candidate<unknown>["source"];
      }[];
    }
  | { kind: "unresolved" }
  /**
   * The words were read perfectly well and the answer is no.
   *
   * The distinction `unresolved` cannot make. «بكرة» is not a day the resolver
   * failed to understand — it is a day the clinic does not sell online, and
   * answering it with «معلش، ما قدرتش أحدد اللي تقصده» tells the patient their
   * Arabic was unclear when the truth is that the policy is. A refusal carries
   * its own copy key and its own facts (the clinic's phone number, for the day
   * case), the slot stays empty, and the attempt counter is untouched — a
   * policy answer is not a failed clarification and must not escalate into
   * one.
   */
  | {
      kind: "refused";
      say: string;
      facts?: Readonly<Record<string, string | number | boolean>>;
    };

export type FlowDefinition = {
  readonly name: FlowName;
  /**
   * Ordered. The engine runs the first step whose `fills` slot is empty and
   * whose preconditions hold — which is a ladder, but a ladder that belongs to
   * *one flow that is actually running*, rather than one that answers for every
   * conversation that has ever existed.
   */
  readonly steps: readonly FlowStep[];
  /**
   * What happens when the patient walks away or cancels mid-flow.
   *
   * `discard` — nothing was created; drop it.
   * `confirm` — something is staged against a real record; ask before dropping.
   */
  readonly onAbandon: "discard" | "confirm";
  /** True when this flow may run for someone with no file and no linkage. */
  readonly public: boolean;
};

/**
 * The memo key recording that an action step has already run on this frame.
 *
 * A step with `fills: null` does not settle a slot, so "has it happened?"
 * cannot be read from the slots. Without a record, `nextStep` returned the
 * first such step forever and the flow could never reach the one after it —
 * a booking whose intake step had nothing to do could never get to its
 * confirmation. The record is per frame and per step id, so it cannot leak
 * between flows or survive a restart of one.
 */
export function stepDoneKey(stepId: string): string {
  return `done:${stepId}`;
}

/** The step that owns a slot for `set_slot` purposes: fills it, or collects it. */
export function stepForSlot(
  definition: FlowDefinition,
  slot: SlotName,
): FlowStep | null {
  return (
    definition.steps.find((step) => step.fills === slot) ??
    definition.steps.find((step) => step.collects?.includes(slot)) ??
    null
  );
}

/** The step the engine should run next, or null when the flow is finished. */
export function nextStep(
  definition: FlowDefinition,
  frame: FlowFrame,
): FlowStep | null {
  for (const step of definition.steps) {
    // A step that fills a slot is finished when the slot holds a value.
    if (step.fills && frame.slots[step.fills]) continue;
    // An action step is finished when it says so. Only `inform` and `fill`
    // mark it — a step that asked a question has not finished, and must be
    // returned again on the turn its answer arrives.
    if (!step.fills && frame.memo[stepDoneKey(step.id)] === true) continue;
    return step;
  }
  return null;
}

/** Everything invalidated by correcting `slot`, transitively and in order. */
export function cascade(
  definition: FlowDefinition,
  slot: SlotName,
): readonly SlotName[] {
  const out: SlotName[] = [];
  const queue: SlotName[] = [slot];
  const seen = new Set<SlotName>([slot]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const step = definition.steps.find((entry) => entry.fills === current);
    for (const dependent of step?.invalidates ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      out.push(dependent);
      queue.push(dependent);
    }
  }
  return out;
}
