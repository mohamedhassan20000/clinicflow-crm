/**
 * The deterministic flow engine.
 *
 * ## What it is
 *
 * Plain TypeScript that takes the commands the interpreter proposed and decides
 * what — if anything — actually happens. It owns the flow stack, the slots, the
 * corrections, suspend/resume/cancel, parking and expiry, and it is the **only**
 * component that writes conversational flow state (I-8).
 *
 * It contains no model call. Every decision in this file can be exercised by a
 * test with a fixed clock and no network, which is the property the engine it
 * replaces never had: its equivalent logic ran inside a `ToolLoopAgent` call and
 * could only be observed by paying for a generation.
 *
 * ## The one rule that makes it safe
 *
 * A command is a **proposal**. Every handler below validates it against
 * server-owned state before acting, and a command that does not validate
 * becomes a clarification rather than an error, a guess, or a mutation (I-3,
 * I-4). There is no path through this file from an unvalidated command to a
 * business write.
 *
 * Concretely, that is why:
 *
 *   * `affirm_offer` resolves its `offerId` against the frame's own open offer,
 *     so a model cannot accept something the patient was never shown;
 *   * `set_slot` hands the patient's *words* to a step's resolver and commits
 *     only what the clinic's own data grounds;
 *   * `start_flow` is the sole way a flow begins, so nothing in durable memory
 *     can start one (I-1) and nothing in a parked frame can either (I-2).
 */

import "server-only";

import type { Command, FlowName, SlotName } from "@/lib/ai/v2/commands";
import {
  activeFrame,
  clearSlots,
  compactStack,
  findFrame,
  isRejected,
  newFrame,
  openOffer,
  parkedFrame,
  parkStaleFrames,
  pushFrame,
  rejectValue,
  replaceFrame,
  setSlot,
  suspendedFrame,
  type FlowFrame,
  type FlowState,
  type Offer,
  type OfferOption,
} from "@/lib/ai/v2/flow-state";
import {
  cascade,
  nextStep,
  stepDoneKey,
  type FlowDefinition,
  type FlowStep,
  type SlotResolution,
  type StepOutcome,
} from "@/lib/ai/v2/flow-definition";
import type { TurnContext } from "@/lib/ai/v2/context";

/**
 * What the composer is told happened. The engine's entire output surface.
 *
 * Effects carry copy *keys* and server-returned facts, never prose and never
 * anything the model wrote. The composer turns them into Arabic or English; it
 * cannot add a fact that is not here, and the grounding gate downstream checks
 * that it did not.
 */
export type Effect =
  | { kind: "say"; key: string; facts?: Readonly<Record<string, unknown>> }
  | {
      kind: "offer";
      key: string;
      offer: Offer;
      facts?: Readonly<Record<string, unknown>>;
    }
  | { kind: "ask"; key: string; slot: SlotName | null; facts?: Readonly<Record<string, unknown>> }
  | {
      kind: "handoff";
      reason: string;
      /**
       * The copy key the step wanted said before the thread changes hands.
       *
       * Carried rather than discarded: "I can't reach the clinic's departments
       * right now" and "I can't record those details" are different things to
       * be told, and collapsing both into a bare handoff left the composer with
       * nothing to render and the patient with a generic greeting. Absent for a
       * handoff the *patient* asked for, where the reason alone selects the
       * copy.
       */
      key?: string;
      facts?: Readonly<Record<string, unknown>>;
    }
  | { kind: "end_conversation" };

export type EngineResult = {
  readonly state: FlowState;
  readonly effects: readonly Effect[];
  /** Labels for the audit line. Never patient content. */
  readonly trace: readonly string[];
};

export type FlowRegistry = Readonly<Record<FlowName, FlowDefinition>>;

/**
 * Mints a server-issued reference.
 *
 * The format is the one `commands.ts` validates, so a reference the server did
 * not issue cannot round-trip through a command. Randomness is only needed to
 * make guessing impractical within one conversation, not to be a secret.
 */
function ref(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/**
 * Runs one turn.
 *
 * The order is the specification:
 *
 *   1. **park** stale frames, before anything reads the stack. A frame that has
 *      timed out is invisible to every decision below it, which is what makes
 *      an abandoned booking unable to answer a new message (I-2);
 *   2. **apply** each command in order, validating as it goes;
 *   3. **advance** the active flow by running its next step, if the commands
 *      left one running and nothing already produced a question.
 *
 * Step 3 is separate from step 2 on purpose. Commands say what the patient
 * meant; advancing is what the *clinic* does next, and keeping them apart is
 * what stops a misread command from also choosing a tool.
 */
export async function runEngine(input: {
  context: TurnContext;
  commands: readonly Command[];
  registry: FlowRegistry;
}): Promise<EngineResult> {
  const { context, commands, registry } = input;
  const at = context.now.toISOString();
  const trace: string[] = [];
  const effects: Effect[] = [];

  let state = parkStaleFrames(context.flows, context.now);
  if (state !== context.flows) trace.push("parked_stale_frames");

  for (const command of commands) {
    const applied = await applyCommand({
      command,
      state,
      context,
      registry,
      at,
    });
    state = applied.state;
    effects.push(...applied.effects);
    trace.push(applied.trace);
    if (applied.stop) break;
  }

  // Advance only if the turn has not already produced something to say. A
  // command that asked a question owns the turn; running a step underneath it
  // would put two questions in one message, which is the collision that let a
  // patient answer one and be recorded as answering the other.
  const producedQuestion = effects.some(
    (effect) => effect.kind === "offer" || effect.kind === "ask" || effect.kind === "handoff",
  );
  if (!producedQuestion) {
    const advanced = await advance({ state, context, registry, at });
    state = advanced.state;
    effects.push(...advanced.effects);
    trace.push(...advanced.traces);
  }

  return { state: compactStack(state), effects, trace };
}

type Applied = {
  state: FlowState;
  effects: Effect[];
  trace: string;
  stop?: boolean;
};

async function applyCommand(input: {
  command: Command;
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
  at: string;
}): Promise<Applied> {
  const { command, context, registry, at } = input;
  let state = input.state;

  switch (command.kind) {
    // -----------------------------------------------------------------------
    case "start_flow": {
      const definition = registry[command.flow];
      if (!definition) return unchanged(state, "start_flow_unknown");
      // Identity is checked when a step runs, not here: a flow may legitimately
      // begin before the patient is identified and ask for what it needs. What
      // is refused here is a *second* copy of a flow already running, which
      // would give the conversation two answers to the same question.
      const existing = findFrame(state, command.flow);
      if (existing && existing.status === "active") {
        return unchanged(state, "start_flow_already_active");
      }
      if (existing && existing.status === "parked") {
        // A parked frame is not resumed by starting the flow again — that would
        // be exactly the implicit resume I-2 forbids. It is offered instead, so
        // the patient decides whether this is the same booking or a new one.
        const offer = buildOffer({
          flow: command.flow,
          kind: "resume_flow",
          slot: null,
          options: [
            { value: "resume", label: "resume", source: "clinic_directory" },
            { value: "restart", label: "restart", source: "clinic_directory" },
          ],
          at,
        });
        const next = { ...existing, offer };
        return {
          state: replaceFrame(state, existing, next),
          effects: [{ kind: "offer", key: "flow.resume_or_restart", offer }],
          trace: "start_flow_offered_resume",
        };
      }
      // Anything currently running is suspended rather than dropped, so a
      // patient who changes subject mid-booking still has the booking to come
      // back to.
      state = suspendActive(state, at);
      state = pushFrame(state, newFrame({ flow: command.flow, at }));
      return { state, effects: [], trace: `start_flow_${command.flow}` };
    }

    // -----------------------------------------------------------------------
    case "set_slot":
    case "correct_slot": {
      const frame = activeFrame(state);
      if (!frame) {
        // A value with no flow to hold it is not an intent. This is one of the
        // paths that used to start a booking: a bare department name arrived,
        // nothing owned it, and the ladder took it as the opening move.
        return {
          state,
          effects: [{ kind: "ask", key: "clarify.no_active_flow", slot: null }],
          trace: "slot_without_flow",
        };
      }
      const definition = registry[frame.flow];
      const step = definition.steps.find((entry) => entry.fills === command.slot);
      if (!step) return unchanged(state, "slot_not_in_flow");

      const isCorrection = command.kind === "correct_slot";
      let working = frame;
      if (isCorrection) {
        // The cascade is data from the definition, so correcting the day drops
        // the time and the offers with it, and adding a slot later cannot
        // forget to invalidate what depends on it.
        const dependents = cascade(definition, command.slot);
        working = clearSlots(working, [command.slot, ...dependents]);
      }

      const resolved = await resolveSlotValue({
        step,
        frame: working,
        context,
        spoken: command.value,
      });
      if (resolved.kind === "unresolved") {
        return {
          state: replaceFrame(state, frame, working),
          effects: [{ kind: "ask", key: "clarify.value_not_recognised", slot: command.slot }],
          trace: "slot_unresolved",
        };
      }
      if (resolved.kind === "ambiguous") {
        // The server owes a question, and it names only the competing readings.
        // Nothing is committed, so a wrong guess is not even representable.
        const offer = buildOffer({
          flow: frame.flow,
          kind: "slot_value",
          slot: command.slot,
          options: resolved.options,
          at,
        });
        const next = { ...working, offer };
        return {
          state: replaceFrame(state, frame, next),
          effects: [{ kind: "offer", key: "clarify.which_one", offer }],
          trace: "slot_ambiguous",
        };
      }
      if (isRejected(working, command.slot, String(resolved.value))) {
        // The patient already said not this one. Honouring that is the whole
        // point of recording it.
        return {
          state: replaceFrame(state, frame, working),
          effects: [{ kind: "ask", key: "clarify.value_rejected", slot: command.slot }],
          trace: "slot_previously_rejected",
        };
      }
      const committed = setSlot(
        { ...working, offer: null },
        command.slot,
        {
          value: resolved.value,
          ...(resolved.label ? { label: resolved.label } : {}),
          provenance: "spoken",
          at,
        },
      );
      return {
        state: replaceFrame(state, frame, committed),
        effects: [],
        trace: isCorrection ? "correct_slot" : "set_slot",
      };
    }

    // -----------------------------------------------------------------------
    case "affirm_offer": {
      const found = openOffer(state, command.offerId);
      if (!found) {
        // The reference is not one the server issued, or the offer it named has
        // been withdrawn (a parked frame, a corrected slot). Either way there is
        // nothing to accept, and accepting *something else* is exactly the
        // failure mode this refuses.
        return {
          state,
          effects: [{ kind: "ask", key: "clarify.nothing_to_confirm", slot: null }],
          trace: "affirm_unknown_offer",
        };
      }
      const { frame, offer } = found;
      // A bare yes needs an unambiguous referent. It has one when the offer
      // carries a single option, and also when the question posed a yes/no
      // about a named one — "your usual doctor is Dr X; shall I book them?"
      // shows a list *and* asks about its first member, and refusing that yes
      // would be both wrong and infuriating.
      //
      // A plain list has neither, and there "yes" really does mean nothing:
      // asking which one is the correct answer, not picking the first.
      const option =
        offer.options.length === 1
          ? offer.options[0]!
          : (offer.options.find((entry) => entry.id === offer.primaryOptionId) ?? null);
      if (!option) {
        return {
          state,
          effects: [{ kind: "offer", key: "clarify.which_one", offer }],
          trace: "affirm_needs_choice",
        };
      }
      const accepted = acceptOption({ frame, offer, option, at });
      return {
        state: replaceFrame(state, frame, accepted.frame),
        effects: accepted.effects,
        trace: `affirm_${offer.kind}`,
      };
    }

    // -----------------------------------------------------------------------
    case "reject_offer": {
      const found = openOffer(state, command.offerId);
      if (!found) {
        return unchanged(state, "reject_unknown_offer");
      }
      const { frame, offer } = found;
      let next: FlowFrame = { ...frame, offer: null, lastAdvancedAt: at };
      if (offer.slot) {
        // The negative constraint. Every option that was on the table is ruled
        // out for this slot for the rest of the frame's life, so the next read
        // cannot put the same doctor back in front of the patient — which is
        // what «لا دكتور تاني» kept getting.
        for (const option of offer.options) {
          next = rejectValue(next, offer.slot, String(option.value));
        }
      }
      if (offer.kind === "package_use") {
        // Declining a package is a decision, not an absence of one. Recording
        // it stops the offer being made again on every subsequent turn.
        next = { ...next, memo: { ...next.memo, package_declined: true } };
      }
      return { state: replaceFrame(state, frame, next), effects: [], trace: "reject_offer" };
    }

    // -----------------------------------------------------------------------
    case "answer_question": {
      // A question never disturbs a running flow. It is pushed above it, which
      // is how «طب بكام الكشف؟» mid-booking keeps every slot the booking holds.
      const running = activeFrame(state);
      if (running) state = suspendActive(state, at);
      const frame = newFrame({
        flow: "answer_question",
        at,
        topic: command.topic,
        ...(command.scope
          ? { slots: { service: { value: command.scope, provenance: "spoken" as const, at } } }
          : {}),
      });
      state = pushFrame(state, frame);
      return { state, effects: [], trace: `answer_question_${command.topic}` };
    }

    // -----------------------------------------------------------------------
    case "suspend_flow": {
      const frame = activeFrame(state);
      if (!frame) return unchanged(state, "suspend_no_flow");
      return { state: suspendActive(state, at), effects: [], trace: "suspend_flow" };
    }

    // -----------------------------------------------------------------------
    case "resume_flow": {
      // The explicit resume I-2 requires. A parked frame comes back only here,
      // and only when the patient named the flow.
      const frame = findFrame(state, command.flow);
      if (!frame) {
        return {
          state,
          effects: [{ kind: "ask", key: "clarify.nothing_to_resume", slot: null }],
          trace: "resume_no_frame",
        };
      }
      state = suspendActive(state, at);
      const revived: FlowFrame = { ...frame, status: "active", lastAdvancedAt: at };
      return { state: replaceFrame(state, frame, revived), effects: [], trace: "resume_flow" };
    }

    // -----------------------------------------------------------------------
    case "cancel_flow": {
      const frame = command.flow ? findFrame(state, command.flow) : activeFrame(state);
      if (!frame) return unchanged(state, "cancel_no_flow");
      const definition = registry[frame.flow];
      if (definition.onAbandon === "confirm" && hasStagedWork(frame)) {
        // Something real exists behind this flow — a staged file, a pending
        // request. Dropping it silently is not the assistant's call.
        const offer = buildOffer({
          flow: frame.flow,
          kind: "summary",
          slot: null,
          options: [{ value: "cancel", label: "cancel", source: "clinic_directory" }],
          at,
        });
        return {
          state: replaceFrame(state, frame, { ...frame, offer }),
          effects: [{ kind: "offer", key: "flow.confirm_cancel", offer }],
          trace: "cancel_needs_confirmation",
        };
      }
      const cancelled: FlowFrame = { ...frame, status: "cancelled", offer: null };
      state = replaceFrame(state, frame, cancelled);
      state = resumeSuspended(state, at);
      return {
        state,
        effects: [{ kind: "say", key: "flow.cancelled" }],
        trace: "cancel_flow",
      };
    }

    // -----------------------------------------------------------------------
    case "ask_clarification": {
      // The safe default (I-3). It touches nothing: no flow starts, no slot
      // moves, no tool runs. «عندي استفسار» ends here, and the whole live
      // failure is the distance between this branch and the one the old engine
      // took instead.
      //
      // A parked booking is *mentioned* rather than resumed, because the
      // patient may well be coming back to it — but mentioning is all, and it
      // takes an explicit answer to pick it up.
      const parked = parkedFrame(state);
      return {
        state,
        effects: [
          {
            kind: "ask",
            key: "clarify.open",
            slot: null,
            facts: {
              reason: command.reason,
              ...(parked ? { parked_flow: parked.flow } : {}),
            },
          },
        ],
        trace: `clarify_${command.reason}`,
      };
    }

    // -----------------------------------------------------------------------
    case "small_talk": {
      // Greetings and thanks move nothing. This is «السلام عليكم»: an answer,
      // and no flow.
      return {
        state,
        effects: [{ kind: "say", key: `small_talk.${command.talk}` }],
        trace: `small_talk_${command.talk}`,
      };
    }

    // -----------------------------------------------------------------------
    case "request_handoff": {
      return {
        state,
        effects: [{ kind: "handoff", reason: command.reason }],
        trace: `handoff_${command.reason}`,
        stop: true,
      };
    }

    // -----------------------------------------------------------------------
    case "end_conversation": {
      const running = activeFrame(state);
      if (running && registry[running.flow].onAbandon === "confirm" && hasStagedWork(running)) {
        // «خلاص شكرا» with a half-staged file behind it is a question, not a
        // goodbye. Asking costs one turn; discarding somebody's half-open
        // medical file costs rather more.
        const offer = buildOffer({
          flow: running.flow,
          kind: "summary",
          slot: null,
          options: [{ value: "discard", label: "discard", source: "clinic_directory" }],
          at,
        });
        return {
          state: replaceFrame(state, running, { ...running, offer }),
          effects: [{ kind: "offer", key: "flow.confirm_discard_on_end", offer }],
          trace: "end_needs_confirmation",
        };
      }
      return {
        state: { ...state, stack: [] },
        effects: [{ kind: "end_conversation" }],
        trace: "end_conversation",
        stop: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Advancing
// ---------------------------------------------------------------------------

async function advance(input: {
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
  at: string;
  /** Re-entry depth, bounded by {@link MAX_SILENT_STEPS}. */
  depth?: number;
  /**
   * Step ids already run on this turn.
   *
   * The termination guarantee. A step is finished either because it filled its
   * slot or because it recorded itself done; a step that returns from `run`
   * having done neither will be selected again by `nextStep` on the next
   * re-advance, forever. That is a definition bug — and it is not hypothetical:
   * `package_offer` shipped with `fills: "package"` and an `inform` exit, so
   * every booking by a patient who owned no package spun here until the depth
   * bound ran out and answered them with a generic greeting.
   *
   * A depth bound alone does not catch it, because a bounded loop still looks
   * like a working turn. Refusing to run the same step twice does: the flow
   * stops, a person is asked to take over, and the trace names the step.
   */
  seen?: ReadonlySet<string>;
}): Promise<{
  state: FlowState;
  effects: Effect[];
  /**
   * Every step run this turn, not just the last one.
   *
   * A turn can run several steps in a row — a derivation, an action step that
   * had nothing to do, then the question. Returning one string kept only the
   * last, so the audit line said `step_confirm_offer` for a turn that had also
   * resolved a package decision and staged an intake, and a step that looped
   * was invisible in the trace entirely.
   */
  traces: string[];
}> {
  let state = input.state;
  const frame = activeFrame(state);
  if (!frame) {
    // No flow. Nothing to advance, and nothing to say — the commands already
    // said it. This branch existing at all is the difference from the engine
    // this replaces, where "no flow" was not a state anything could be in.
    return { state, effects: [], traces: [] };
  }
  const definition = input.registry[frame.flow];
  const step = nextStep(definition, frame);
  if (step && input.seen?.has(step.id)) {
    // The same step, twice, on one turn. See `seen` above: the flow cannot
    // make progress and no amount of re-running will change that, so it hands
    // over rather than looping or improvising.
    return {
      state,
      effects: [
        { kind: "handoff", reason: "flow_stuck", key: "flow.stuck" },
      ],
      traces: [`step_${step.id}_stuck`],
    };
  }
  if (!step) {
    const done: FlowFrame = { ...frame, status: "completed", offer: null };
    state = replaceFrame(state, frame, done);
    state = resumeSuspended(state, input.at);
    return {
      state,
      effects: [{ kind: "say", key: `${frame.flow}.completed` }],
      traces: ["flow_completed"],
    };
  }

  // The precondition gate (I-7). Evaluated against this frame's own committed
  // slots and the proven identity level — never against durable memory. A
  // doctor in the patient's history satisfies nothing here.
  const missing = step.pre.slots.filter((slot) => !frame.slots[slot]);
  if (missing.length > 0) {
    // A step whose own slot is unfilled but whose prerequisites are also
    // unfilled means the definition is out of order. Refusing is correct and
    // loud; guessing would be neither.
    return {
      state,
      effects: [{ kind: "ask", key: "clarify.step_blocked", slot: missing[0]! }],
      traces: ["step_precondition_unmet"],
    };
  }
  if (!identitySatisfied(step.pre.identity, input.context.identity)) {
    return {
      state,
      effects: [
        {
          kind: "ask",
          key: "identity.required",
          slot: null,
          facts: { level: step.pre.identity },
        },
      ],
      traces: ["step_identity_required"],
    };
  }

  const outcome = await step.run({ frame, context: input.context });
  const applied = applyOutcome({
    state,
    frame,
    outcome,
    at: input.at,
    stepId: step.id,
    definition,
  });
  const traces = [applied.trace];
  // A step that produced no question has not finished the turn. `fill` commits
  // a derived value and `inform` reports a fact — in both cases the flow can
  // keep going, and making the patient send another message to see the next
  // question would be an artefact of the implementation rather than a decision.
  //
  // Bounded, because a definition with a step that neither fills nor asks would
  // otherwise loop. Depth is small on purpose: a flow needing more than this
  // many silent steps in a row has a definition problem a bound should surface.
  if (
    outcome.kind === "fill" ||
    outcome.kind === "inform" ||
    // An invalidation has to re-advance, or the patient would be told the slot
    // is gone and then have to send another message to be offered a new one.
    outcome.kind === "invalidate"
  ) {
    const depth = (input.depth ?? 0) + 1;
    if (depth > MAX_SILENT_STEPS) {
      // A chain of *distinct* silent steps this long is the same failure the
      // `seen` guard catches, one shape over, and it must not end the same way
      // it used to: silently, with nothing said, falling through to the generic
      // clarification. A flow that cannot reach a question in this many steps
      // is one a person should finish.
      return {
        state: applied.state,
        effects: [
          ...applied.effects,
          { kind: "handoff", reason: "flow_stuck", key: "flow.stuck" },
        ],
        traces: [...traces, "advance_depth_exhausted"],
      };
    }
    const seen = new Set(input.seen ?? []);
    seen.add(step.id);
    const next = await advance({ ...input, state: applied.state, depth, seen });
    return {
      state: next.state,
      effects: [...applied.effects, ...next.effects],
      traces: [...traces, ...next.traces],
    };
  }
  return { state: applied.state, effects: applied.effects, traces };
}

/** How many steps may run without asking the patient anything. */
const MAX_SILENT_STEPS = 6;

function applyOutcome(input: {
  state: FlowState;
  frame: FlowFrame;
  outcome: StepOutcome;
  at: string;
  stepId: string;
  definition: FlowDefinition;
}): { state: FlowState; effects: Effect[]; trace: string } {
  const { frame, outcome, at } = input;
  let state = input.state;
  switch (outcome.kind) {
    case "offer": {
      const offer = buildOffer({
        flow: frame.flow,
        kind: outcome.offerKind,
        slot: outcome.slot,
        options: outcome.options,
        at,
        ...(outcome.primary !== undefined ? { primary: outcome.primary } : {}),
      });
      const next: FlowFrame = { ...frame, offer, lastAdvancedAt: at };
      return {
        state: replaceFrame(state, frame, next),
        effects: [
          {
            kind: "offer",
            key: outcome.say,
            offer,
            ...(outcome.facts ? { facts: outcome.facts } : {}),
          },
        ],
        trace: `step_${input.stepId}_offer`,
      };
    }
    case "ask": {
      const next: FlowFrame = { ...frame, offer: null, lastAdvancedAt: at };
      return {
        state: replaceFrame(state, frame, next),
        effects: [
          {
            kind: "ask",
            key: outcome.say,
            slot: outcome.slot,
            ...(outcome.facts ? { facts: outcome.facts } : {}),
          },
        ],
        trace: `step_${input.stepId}_ask`,
      };
    }
    case "inform": {
      // An action step that reported a fact has run. Recording it is what lets
      // the ladder move past a `fills: null` step; without it the flow would
      // return here on every advance and never reach the step after it.
      const next: FlowFrame = {
        ...frame,
        memo: {
          ...frame.memo,
          ...(outcome.memo ?? {}),
          [stepDoneKey(input.stepId)]: true,
        },
        lastAdvancedAt: at,
      };
      return {
        state: replaceFrame(state, frame, next),
        effects: [
          {
            kind: "say",
            key: outcome.say,
            ...(outcome.facts ? { facts: outcome.facts } : {}),
          },
        ],
        trace: `step_${input.stepId}_inform`,
      };
    }
    case "complete": {
      const done: FlowFrame = { ...frame, status: "completed", offer: null };
      state = replaceFrame(state, frame, done);
      state = resumeSuspended(state, at);
      return {
        state,
        effects: [
          {
            kind: "say",
            key: outcome.say,
            ...(outcome.facts ? { facts: outcome.facts } : {}),
          },
        ],
        trace: `step_${input.stepId}_complete`,
      };
    }
    case "fill": {
      // A derived value. Committed with `derived` provenance so the record says
      // plainly that the patient did not utter it and did not affirm it — which
      // keeps the audit honest and keeps the three provenances meaningful.
      const filled = setSlot({ ...frame, offer: null }, outcome.slot, {
        value: outcome.value,
        ...(outcome.label ? { label: outcome.label } : {}),
        provenance: "derived",
        at,
      });
      return {
        state: replaceFrame(state, frame, filled),
        effects: [],
        trace: `step_${input.stepId}_fill`,
      };
    }
    case "invalidate": {
      // Clear the named slots with their dependents, so nothing derived from a
      // dropped value survives it.
      const doomed = new Set<SlotName>();
      for (const slot of outcome.slots) {
        doomed.add(slot);
        for (const dependent of cascade(input.definition, slot)) doomed.add(dependent);
      }
      let next = clearSlots(frame, [...doomed]);
      if (outcome.memo && outcome.memo.length > 0) {
        // The flags that were *about* those slots — `confirmed` above all.
        // Consent to a booking is consent to a specific time, and it must not
        // outlive the time it was given for.
        const memo: Record<string, string | number | boolean> = { ...next.memo };
        for (const key of outcome.memo) delete memo[key];
        next = { ...next, memo };
      }
      next = { ...next, lastAdvancedAt: at };
      // Deliberately *not* marked done: the step has to run again once the
      // slots it cleared are filled in, which is the whole point.
      return {
        state: replaceFrame(state, frame, next),
        effects: [
          {
            kind: "say",
            key: outcome.say,
            ...(outcome.facts ? { facts: outcome.facts } : {}),
          },
        ],
        trace: `step_${input.stepId}_invalidate`,
      };
    }
    case "handoff": {
      // `outcome.say` travels with the handoff. A step that gives up still
      // knows *why*, and that sentence is the one the patient needs; the bare
      // reason label is for the escalation record, not for them.
      return {
        state,
        effects: [
          { kind: "handoff", reason: "unsupported_request", key: outcome.say },
        ],
        trace: `step_${input.stepId}_handoff`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unchanged(state: FlowState, trace: string): Applied {
  return { state, effects: [], trace };
}

function suspendActive(state: FlowState, at: string): FlowState {
  const frame = activeFrame(state);
  if (!frame) return state;
  return replaceFrame(state, frame, { ...frame, status: "suspended", lastAdvancedAt: at });
}

/**
 * Brings the innermost suspended frame back after an interruption finishes.
 *
 * The rung comes from the frame, not from the transcript, so a booking resumes
 * exactly where it stopped — no restart, no skipped step, no question asked
 * twice. That behaviour existed in the old engine for one nesting level via a
 * hand-maintained `interruptedBooking` draft; here it is the stack.
 */
function resumeSuspended(state: FlowState, at: string): FlowState {
  if (activeFrame(state)) return state;
  const frame = suspendedFrame(state);
  if (!frame) return state;
  return replaceFrame(state, frame, { ...frame, status: "active", lastAdvancedAt: at });
}

function identitySatisfied(
  required: "none" | "linked" | "verified",
  actual: TurnContext["identity"],
): boolean {
  if (required === "none") return true;
  if (required === "linked") return actual === "linked" || actual === "verified";
  return actual === "verified";
}

/** Does this frame have something staged that a person would have to undo? */
function hasStagedWork(frame: FlowFrame): boolean {
  return frame.memo.intake_staged === true || frame.memo.submitted === true;
}

function buildOffer(input: {
  flow: FlowName;
  kind: Offer["kind"];
  slot: SlotName | null;
  options: readonly { value: string | number; label: string; source: OfferOption["source"] }[];
  at: string;
  primary?: number;
}): Offer {
  const options = input.options.slice(0, 20).map((option) => ({
    id: ref("opt"),
    value: option.value,
    label: option.label,
    source: option.source,
  }));
  return {
    id: ref("ofr"),
    slot: input.slot,
    flow: input.flow,
    kind: input.kind,
    at: input.at,
    options,
    primaryOptionId:
      input.primary !== undefined && options[input.primary]
        ? options[input.primary]!.id
        : null,
  };
}

/**
 * Turns an accepted option into whatever accepting it *means*.
 *
 * The `kind` switch is the reason `OfferKind` exists. Accepting a doctor fills
 * a slot; accepting a summary is write consent; accepting a package permits a
 * decrement. Collapsing those into "yes" is how a confirmation ends up
 * authorising something the patient thought they were merely choosing.
 */
function acceptOption(input: {
  frame: FlowFrame;
  offer: Offer;
  option: OfferOption;
  at: string;
}): { frame: FlowFrame; effects: Effect[] } {
  const { offer, option, at } = input;
  const base: FlowFrame = { ...input.frame, offer: null, lastAdvancedAt: at };
  switch (offer.kind) {
    case "slot_value":
    case "identity_match":
    case "document_choice":
      if (!offer.slot) return { frame: base, effects: [] };
      return {
        frame: setSlot(base, offer.slot, {
          value: option.value,
          label: option.label,
          // The candidate/value boundary, crossed by the patient and recorded
          // as such. This is the only provenance a durable fact can ever carry.
          provenance: "affirmed",
          at,
        }),
        effects: [],
      };
    case "summary":
      // Write consent, recorded as a memo the confirming step reads. The step
      // still re-validates everything; this only unlocks it.
      return {
        frame: { ...base, memo: { ...base.memo, confirmed: true, confirmed_at: at } },
        effects: [],
      };
    case "package_use": {
      // Permission to consume a session, and nothing more. The booking write is
      // still the thing that consumes it, transactionally, and it refuses
      // without this flag.
      //
      // The slot is filled alongside the flag so the offer is not made again on
      // the next advance — the question is answered, and an answered question
      // must not come back.
      const permitted: FlowFrame = {
        ...base,
        memo: {
          ...base.memo,
          package_accepted: true,
          package_id: String(option.value),
        },
      };
      return {
        frame: offer.slot
          ? setSlot(permitted, offer.slot, {
              value: String(option.value),
              label: option.label,
              provenance: "affirmed",
              at,
            })
          : permitted,
        effects: [],
      };
    }
    case "resume_flow":
      return {
        frame:
          option.value === "resume"
            ? { ...base, status: "active" }
            : // "restart" is a fresh frame's worth of emptiness, in place.
              { ...base, status: "active", slots: {}, rejected: {}, memo: {} },
        effects: [],
      };
  }
}

// ---------------------------------------------------------------------------
// Slot resolution
// ---------------------------------------------------------------------------

/**
 * Grounds the patient's words against the clinic's own data.
 *
 * Delegated to the step, because only the step knows what its slot is about.
 * What is uniform — and what lives here — is the *consequence*: resolved
 * commits, ambiguous asks which, unresolved asks again. The model never sees
 * any of it and never decides any of it.
 */
async function resolveSlotValue(input: {
  step: FlowStep;
  frame: FlowFrame;
  context: TurnContext;
  spoken: string;
}): Promise<SlotResolution> {
  const resolver = input.step.resolveValue;
  if (!resolver) {
    // A step with no resolver takes the patient's words verbatim. Only ever
    // declared for free-text slots that are validated by the write behind them
    // — a name, an email — never for anything that selects a record.
    return { kind: "resolved", value: input.spoken };
  }
  try {
    return await resolver({
      spoken: input.spoken,
      frame: input.frame,
      context: input.context,
    });
  } catch {
    // A resolver that threw has proven nothing. Unresolved is the safe reading
    // and produces a question rather than a guess.
    return { kind: "unresolved" };
  }
}
