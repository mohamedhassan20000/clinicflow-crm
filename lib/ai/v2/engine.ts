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

import { formatInTimeZone } from "date-fns-tz";

import type { Command, FlowName, SlotName } from "@/lib/ai/v2/commands";
import { foldArabic, parseDateLowerBound } from "@/lib/ai/v2/normalize";
import { offerIndexFromSpoken } from "@/lib/ai/v2/present";
import { readsAsOwnEmailReference } from "@/lib/ai/v2/self-email-reference";
import { readsAsOwnNumberReference } from "@/lib/ai/v2/self-phone-reference";
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
  stepForSlot,
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
  | {
      kind: "ask";
      key: string;
      slot: SlotName | null;
      /**
       * A discriminator the composer may use to pick more specific copy.
       *
       * Deliberately not a fact: it selects a *sentence*, it is never rendered,
       * and it must not reach the polish prompt or the grounding ledger as a
       * value the model is asked to preserve. The only producer today is the
       * unresolved-value clarification, which carries `"other"` when the frame
       * is an explicit third-party intake — so the email repair line can offer
       * «استخدم إيميلي» exactly where that phrase resolves and nowhere else.
       *
       * Always optional, and the composer falls back through slot copy to the
       * generic line, so an unknown variant changes nothing.
       */
      variant?: string;
      facts?: Readonly<Record<string, unknown>>;
    }
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

  // Before anything reads the stack, and for the same reason parking runs here:
  // a spent question frame must be invisible to every decision below it. See
  // `retireStaleInformationalFrames` — it runs *before* the commands so that a
  // frame still holding an open offer survives to receive the answer to it.
  const retired = retireStaleInformationalFrames(state, at);
  if (retired !== state) trace.push("retired_stale_informational_frames");
  state = retired;

  // 1a. "What can you help me with?" is a question about this assistant.
  //
  // See `reconcileCapabilityQuestion`. First of the reconciliations because it
  // is about the *whole* message rather than about an open question, and
  // because the readings it displaces — a booking, a handoff, a clarification —
  // are exactly the ones that must not survive it.
  const capability = reconcileCapabilityQuestion({ commands, context });
  if (capability.commands !== commands) trace.push("capability_question_reconciled");

  // 1b. The patient's own words outrank the command shape, for a canonical slot.
  //
  // See `FlowStep.canonicalAnswer`. This changes no state and takes no step —
  // it rewrites at most one command into the `set_slot` the message plainly
  // was, and only while a canonical step's own offer is open. Everything after
  // it is the ordinary path, which is the point: there is no second way to
  // fill a slot, only a second way to read the sentence that fills it.
  const reconciled = await reconcileCanonicalAnswer({
    commands: capability.commands,
    state,
    context,
    registry,
  });
  if (reconciled.commands !== capability.commands) {
    trace.push("canonical_answer_reconciled");
  }

  // 1c. A narrowing of the question that is already open is not a new subject.
  //
  // See `reconcileDayRefinement`. Same shape as the canonical reconciliation
  // above and the same discipline: a deterministic read of the turn text, no
  // state change, and a rewrite only when the words say something the step the
  // patient is standing on can act on.
  const refined = reconcileDayRefinement({
    commands: reconciled.commands,
    state,
    context,
    registry,
  });
  if (refined.commands !== reconciled.commands) trace.push("day_refinement_reconciled");

  // 1d. An acceptance of a list is a *selection*, when the words say which line.
  //
  // See `reconcileOfferSelection`. Third application of the same rule as 1b and
  // 1c: while the server is holding a list open, a deterministic reading of the
  // patient's own words outranks the command shape the model chose.
  const selected = await reconcileOfferSelection({
    commands: refined.commands,
    state,
    context,
    registry,
  });
  if (selected.commands !== refined.commands) trace.push("offer_selection_reconciled");

  // 1e. "Use my number" is an answer to the phone question, not a failure to
  // give one.
  //
  // See `reconcileOwnNumberReference`. Same discipline as 1b–1d and the same
  // narrowness: it runs only while a third-party intake is standing on its own
  // phone question, it rewrites at most one turn's commands, and the value it
  // hands over is resolved by the step's ordinary resolver like every other.
  const addressed = reconcileOwnNumberReference({
    commands: selected.commands,
    state,
    context,
    registry,
  });
  if (addressed.commands !== selected.commands) trace.push("own_number_reconciled");

  // 1f. "Use my email" is an answer to the email question, for the same reason
  // and under the same restrictions.
  //
  // See `reconcileOwnEmailReference`. It runs only while a third-party intake
  // is standing on its own email question, it rewrites at most one turn's
  // commands, and the value that lands on the frame is produced by the intake
  // step's ordinary resolver from the requester's own record — not by anything
  // here, which reads nothing and knows no address.
  const emailed = reconcileOwnEmailReference({
    commands: addressed.commands,
    state,
    context,
    registry,
  });
  if (emailed.commands !== addressed.commands) trace.push("own_email_reconciled");

  for (const command of emailed.commands) {
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

  // 2b. Answer every question this turn asked, in the order it asked them.
  //
  // See {@link drainInformationalFrames}. This is separate from step 3 because
  // a read is not a step of the patient's flow: answering "what's your address?"
  // must not also advance a booking, and advancing a booking must not depend on
  // how many questions came with it.
  const drained = await drainInformationalFrames({ state, context, registry, at });
  state = drained.state;
  effects.push(...drained.effects);
  trace.push(...drained.traces);

  // Advance only if the turn has not already produced something to say. A
  // command that asked a question owns the turn; running a step underneath it
  // would put two questions in one message, which is the collision that let a
  // patient answer one and be recorded as answering the other.
  const producedQuestion = effects.some(
    (effect) => effect.kind === "offer" || effect.kind === "ask" || effect.kind === "handoff",
  );
  // A flow the drain resumed still owes the patient its question.
  //
  // This used to be `!producedQuestion && !drained.answered`, which meant a
  // side question during a booking answered the question and stopped. On
  // WhatsApp that reads as the booking having been abandoned: the assistant had
  // just asked «أنهي يوم يناسبك؟», the patient asked «بالمناسبة بتقبلوا تأمين
  // X؟», and the reply was the insurance answer alone with no sign the booking
  // still existed — so the patient had to say «عايز أكمل الحجز» to get back to
  // a step that had never actually moved.
  //
  // The guard it replaces was there to keep the drain from advancing a *flow*
  // as a side effect of answering a question. That property is kept and stated
  // more precisely: the advance below runs only when the frame now on top is a
  // real flow rather than another question, so answering one topic still cannot
  // answer the next one, and a turn with nothing underneath it advances
  // nothing — `advance` returns immediately when the stack has no active frame.
  //
  // It also removes the stray invitation. `NEXT_STEP` appends "shall I book you
  // an appointment?" only to a turn that asked nothing, and before this the
  // insurance answer qualified — so a patient halfway through a booking was
  // offered a booking. Re-asking the day makes the turn a question, and the
  // invitation is correctly withheld.
  const resumed = activeFrame(state);
  const resumedFlow = resumed !== null && resumed.flow !== "answer_question";
  if (!producedQuestion && (!drained.answered || resumedFlow)) {
    const advanced = await advance({ state, context, registry, at });
    state = advanced.state;
    effects.push(...advanced.effects);
    trace.push(...advanced.traces);
  }

  return { state: compactStack(state), effects, trace };
}

/**
 * How many informational topics one turn may answer.
 *
 * `MAX_COMMANDS_PER_TURN` already bounds how many can be asked for; this is the
 * same bound restated where the loop is, so a future widening of the command
 * cap cannot silently turn one message into an unbounded number of reads.
 */
const MAX_INFORMATIONAL_TOPICS_PER_TURN = 6;

/**
 * Answers every `answer_question` frame this turn created, oldest first.
 *
 * ## The defect this fixes
 *
 * `answer_question` pushes a frame and suspends whatever was running, and
 * `advance` runs exactly one frame: the topmost active one. So «عايز اعرف
 * العنوان ورقم التليفون والاقسام الموجودة عندكم» produced three commands, three
 * frames and **one answer** — the last topic named — while the other two sat on
 * the stack, unanswered and unmentioned.
 *
 * Worse, they did not stay there quietly. `complete` calls `resumeSuspended`,
 * which promoted the next unanswered question frame to *active*, so the
 * following turn opened with `ACTIVE FLOW: answer_question` about a topic the
 * patient had never been told was pending — and that frame `collects`
 * `department` and `service`, so a bare value on the next turn could be routed
 * into a stale question instead of the booking.
 *
 * ## Why order comes from the stack
 *
 * `pushFrame` appends, so stack order is command order is the order the patient
 * said things. Scanning from the bottom answers "the address, the phone and the
 * departments" in that sequence. Relying on `resumeSuspended` instead would
 * answer them backwards, because `suspendedFrame` scans from the top — correct
 * for an interruption, wrong for a queue.
 *
 * ## What stops it
 *
 * A question. If answering one topic produces an `ask` or an `offer` — "which
 * department's doctors did you mean?" — that question owns the turn, and the
 * topics behind it are cancelled rather than left on the stack. Leaving them is
 * how the zombie frames appeared in the first place; answering them underneath
 * an open question would put two questions in one message. Cancelling is the
 * honest third option: the patient can ask again, and the trace says it
 * happened.
 */
async function drainInformationalFrames(input: {
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
  at: string;
}): Promise<{
  state: FlowState;
  effects: Effect[];
  traces: string[];
  /** True when at least one informational frame ran. */
  answered: boolean;
}> {
  let state = input.state;
  const effects: Effect[] = [];
  const traces: string[] = [];
  let answered = false;

  for (let guard = 0; guard < MAX_INFORMATIONAL_TOPICS_PER_TURN; guard += 1) {
    const pending = state.stack.find((frame) => isPendingInformational(frame, input.at));
    if (!pending) break;

    // Exactly one frame is active while a step runs, because `advance` reads
    // the topmost active frame and would otherwise pick a different one than
    // the queue selected.
    const running = activeFrame(state);
    if (running && running !== pending) {
      state = replaceFrame(state, running, { ...running, status: "suspended" });
    }
    if (pending.status !== "active") {
      state = replaceFrame(state, pending, { ...pending, status: "active", lastAdvancedAt: input.at });
    }

    const advanced = await advance({
      state,
      context: input.context,
      registry: input.registry,
      at: input.at,
    });
    state = advanced.state;
    effects.push(...advanced.effects);
    traces.push(...advanced.traces);
    answered = true;

    if (
      advanced.effects.some(
        (effect) =>
          effect.kind === "offer" || effect.kind === "ask" || effect.kind === "handoff",
      )
    ) {
      // Everything still queued *behind* the question — never the frame that
      // asked it. That frame is active and holds the open offer the patient is
      // about to answer; cancelling it would throw away «أنهي قسم تحب تعرف
      // دكاتره؟» in the same breath as asking it.
      const owner = activeFrame(state);
      const remaining = state.stack.filter(
        (frame) => frame !== owner && isPendingInformational(frame, input.at),
      );
      if (remaining.length > 0) {
        for (const frame of remaining) {
          state = replaceFrame(state, frame, {
            ...frame,
            status: "cancelled",
            offer: null,
          });
        }
        traces.push(`informational_topics_deferred_${remaining.length}`);
      }
      break;
    }
  }

  return { state, effects, traces, answered };
}

/** A question frame from this turn that still owes the patient an answer. */
function isPendingInformational(frame: FlowFrame, at: string): boolean {
  return (
    frame.flow === "answer_question" &&
    frame.startedAt === at &&
    (frame.status === "active" || frame.status === "suspended")
  );
}

/**
 * Retires question frames left over from an earlier turn.
 *
 * Self-healing, for state written before the drain existed. An
 * `answer_question` frame is a one-shot read: once its turn is over it either
 * carries an open offer — a live question the patient still owes an answer to,
 * which must survive — or it is bookkeeping nobody is waiting on. The second
 * kind used to accumulate, report itself to the interpreter as the ACTIVE FLOW,
 * and offer its `collects` slots to values meant for a booking.
 *
 * Marked `cancelled` rather than deleted so `compactStack` performs the removal
 * and the stack has exactly one writer.
 */
function retireStaleInformationalFrames(state: FlowState, at: string): FlowState {
  let next = state;
  for (const frame of state.stack) {
    if (frame.flow !== "answer_question") continue;
    if (frame.startedAt === at) continue;
    // `parked` counts too. `parkStaleFrames` runs first, so a question frame
    // left by a turn hours ago arrives here already parked — and a parked
    // question is no more waiting on an answer than a suspended one is.
    if (frame.status !== "active" && frame.status !== "suspended" && frame.status !== "parked") {
      continue;
    }
    if (frame.offer) continue;
    next = replaceFrame(next, frame, { ...frame, status: "cancelled", offer: null });
  }
  return next;
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
      // `fills` first, then `collects`. Without the second lookup an answer to
      // a question an action step asked — every intake field — belonged to no
      // step, was silently dropped, and was asked for again next turn.
      const step = stepForSlot(definition, command.slot);
      if (!step) return unchanged(state, "slot_not_in_flow");

      // A number answers the list the patient is looking at.
      //
      // Before anything is resolved against clinic data, because "2" against a
      // day offer is the second *line* and not the second of the month, and
      // "1" against a doctor list is the first doctor and not a name to score.
      // Scoped to the frame's own open offer for this slot, so the index is
      // ephemeral by construction: an offer withdrawn by parking, by a
      // correction, or by having been answered is not an offer this can reach,
      // and a number then falls through to the ordinary resolver.
      const indexed = resolveOfferIndex({ frame, slot: command.slot, spoken: command.value });
      if (indexed) {
        const committed = setSlot(
          clearAttempts({ ...frame, offer: null }, command.slot),
          command.slot,
          { value: indexed.value, label: indexed.label, provenance: "affirmed", at },
        );
        return {
          state: replaceFrame(state, frame, committed),
          effects: [],
          trace: "slot_offer_index",
        };
      }

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
        slot: command.slot,
        frame: working,
        context,
        spoken: command.value,
      });
      if (resolved.kind === "unresolved") {
        // The clarification-loop breaker.
        //
        // Repeating «ممكن تكتبه تاني؟» to a patient who has now written it
        // twice is not a clarification, it is a wall: the same sentence
        // arrives, resolves to nothing for the same reason, and produces the
        // same sentence. Counting the attempts on the frame turns the second
        // one into *showing the choices again* — the step re-runs below,
        // because this branch produces no question of its own — which is an
        // answerable message rather than the same unanswerable one.
        const attempts = attemptCount(working, command.slot) + 1;
        const counted = countAttempt(working, command.slot, attempts);
        if (attempts >= 2) {
          return {
            state: replaceFrame(state, frame, counted),
            effects: [],
            trace: "slot_unresolved_reask",
          };
        }
        return {
          state: replaceFrame(state, frame, counted),
          effects: [
            {
              kind: "ask",
              key: "clarify.value_not_recognised",
              slot: command.slot,
              // The frame already knows whose file this is. Carried so the
              // repair line can name the self-reference phrase for a
              // third-party intake and stay silent about it otherwise.
              variant:
                working.slots.beneficiary?.value === "other" ? "other" : undefined,
            },
          ],
          trace: "slot_unresolved",
        };
      }
      if (resolved.kind === "refused") {
        // A policy answer, not a clarification. Nothing is committed, nothing
        // is counted against the clarification-loop breaker, and the frame is
        // left exactly where it was — the patient can name a different day on
        // the very next turn and the step is still standing there waiting for
        // one.
        return {
          state,
          effects: [
            { kind: "ask", key: resolved.say, slot: command.slot, facts: resolved.facts },
          ],
          trace: "slot_refused",
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
        // The offer is answered and the failed-attempt count is spent, so both
        // go with the value that settled them.
        clearAttempts({ ...working, offer: null }, command.slot),
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
      const running = activeFrame(state);
      if (running && command.reason === "unspecified_correction") {
        // «عايز أغير» — an edit with no field named.
        //
        // The four things this must not do are the four things that were
        // observed instead: guess a field, restart the booking, reset the
        // beneficiary, or hand the thread to a person. So it asks, and it asks
        // *narrowly*: the fields named back are the ones this frame actually
        // holds a value for, in the order its own steps collect them, so a
        // booking that has a doctor and a day offers those two and never offers
        // a time nobody has picked yet. Nothing is committed, nothing is
        // cleared, and the very next turn's `correct_slot` runs the ordinary
        // cascade — this changes which sentence an unspecified edit gets, and
        // nothing else.
        const editable = editableSlots(registry[running.flow], running);
        if (editable.length > 0) {
          return {
            state,
            effects: [
              {
                kind: "ask",
                key: "clarify.what_to_change",
                slot: null,
                facts: { fields: editable },
              },
            ],
            trace: "clarify_unspecified_correction",
          };
        }
        // Nothing committed yet, so there is nothing to edit. Falling through
        // re-asks the step the patient is standing on, which is the answerable
        // message.
        return { state, effects: [], trace: "clarify_correction_nothing_set" };
      }
      if (running) {
        // A live flow already has a question on the table, and «اتفضل، أقدر
        // أساعدك في إيه؟» in the middle of one is the assistant forgetting it.
        // Manual QA: the assistant had offered days, the patient wrote
        // something it could not read, and the greeting it got back looked
        // exactly like a reset — so the patient repeated themselves and the
        // next reading of the same sentence went somewhere worse.
        //
        // No effect and no `stop`, so the turn falls through to `advance` and
        // the step the patient is standing on asks its question again. Nothing
        // is committed, nothing is started, and the frame is untouched: this
        // changes which sentence an unreadable message gets, and nothing else.
        return { state, effects: [], trace: `clarify_in_flow_${command.reason}` };
      }
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
    // A `fill` is the one silent outcome that leaves the *same* step legitimately
    // next: an action step collecting a sequence of answers derives one of them
    // and still owes the patient the questions after it. Marking it seen turned
    // that into `flow_stuck` — the booking intake deriving the Latin spelling of
    // a name the patient wrote in English handed the thread to a person instead
    // of asking for the national id.
    //
    // Safe because a fill *commits a slot*, so the step it re-enters is looking
    // at a different frame, and because the depth bound above still counts every
    // silent step: a definition that fills forever is caught there rather than
    // running away.
    if (outcome.kind !== "fill") seen.add(step.id);
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
      // The slot the patient is now being asked for, recorded so the next turn
      // can be read in the context of the question. Without it a bare value —
      // «12:15» answering "which time?" — reached the interpreter with no
      // referent at all, and the honest reading of an unattached number is a
      // clarification, which is exactly the loop that was observed.
      const next: FlowFrame = {
        ...frame,
        offer: null,
        memo: awaitingMemo(frame, outcome.slot),
        lastAdvancedAt: at,
      };
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
      // The values this frame may not be offered again. Applied after the
      // clearing, because clearing a slot does not un-refuse the value it held.
      for (const rejection of outcome.reject ?? []) {
        next = rejectValue(next, rejection.slot, rejection.value);
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

/** Memo key holding how many times a slot's value failed to ground. */
/**
 * The fields on a live frame a patient could sensibly ask to change.
 *
 * Committed slots only, and only ones a step of this flow declares itself the
 * owner of — so the list is the flow's own vocabulary rather than the slot
 * table's, and it is in the order the flow collects them, which is the order
 * the patient supplied them in. Internal bookkeeping slots nothing `fills`
 * (`date_lower_bound`, `full_name_latin`) are not editable concepts and are not
 * offered.
 *
 * Labels are not produced here: the composer localizes the field names, because
 * the same list has to read «الدكتور» in one language and "doctor" in the other
 * and a canonical slot name must never reach a patient.
 */
function editableSlots(
  definition: FlowDefinition,
  frame: FlowFrame,
): readonly SlotName[] {
  const seen = new Set<SlotName>();
  const fields: SlotName[] = [];
  for (const step of definition.steps) {
    const name = step.fills;
    if (!name || seen.has(name)) continue;
    if (!frame.slots[name]) continue;
    seen.add(name);
    fields.push(name);
  }
  return fields;
}

function attemptKey(slot: SlotName): string {
  return `unresolved:${slot}`;
}

function attemptCount(frame: FlowFrame, slot: SlotName): number {
  const held = frame.memo[attemptKey(slot)];
  return typeof held === "number" ? held : 0;
}

function countAttempt(frame: FlowFrame, slot: SlotName, attempts: number): FlowFrame {
  return { ...frame, memo: { ...frame.memo, [attemptKey(slot)]: attempts } };
}

function clearAttempts(frame: FlowFrame, slot: SlotName): FlowFrame {
  const memo: Record<string, string | number | boolean> = { ...frame.memo };
  delete memo[attemptKey(slot)];
  if (memo[AWAITING_SLOT] === slot) delete memo[AWAITING_SLOT];
  return { ...frame, memo };
}

/** Memo key naming the slot an open `ask` is waiting on. */
export const AWAITING_SLOT = "awaiting_slot";

function awaitingMemo(
  frame: FlowFrame,
  slot: SlotName | null,
): FlowFrame["memo"] {
  const memo: Record<string, string | number | boolean> = { ...frame.memo };
  if (slot) memo[AWAITING_SLOT] = slot;
  else delete memo[AWAITING_SLOT];
  return memo;
}

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
// Canonical answers
// ---------------------------------------------------------------------------

/**
 * Reads the turn text as the answer to an open canonical offer.
 *
 * The defect, from a live WhatsApp session:
 *
 * ```
 *   assistant: الحجز ده ليك إنت ولا لحد تاني؟
 *   patient:   لحد تاني
 *   assistant: تقصد أنهي واحد في دول: self، other؟
 * ```
 *
 * Two failures, one turn. The interpreter emitted `affirm_offer` — a defensible
 * reading of "answer THE OPEN OFFER" — and a bare affirmation of a two-option
 * offer with no primary is ambiguous *by construction*, so the engine asked
 * which one and rendered the question from the offer's labels, which at the
 * time were the canonical values themselves. The patient's words were never
 * ambiguous; only the command was.
 *
 * So for a step that declares `canonicalAnswer`, the deterministic reading wins
 * and the commands about that offer are collapsed into the `set_slot` the
 * message was. Nothing here decides anything: `resolveSlotValue` is the same
 * function the ordinary `set_slot` path calls, the value it returns is the same
 * value that path would commit, and a message it cannot read leaves every
 * command exactly as the interpreter emitted it.
 *
 * Commands that are not about this offer are untouched and keep their order, so
 * «لحد تاني، وعايز الجلدية» still fills both slots, beneficiary first — which is
 * what its own precondition requires.
 */
async function reconcileCanonicalAnswer(input: {
  commands: readonly Command[];
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
}): Promise<{ commands: readonly Command[] }> {
  const { commands, state, context, registry } = input;
  const frame = activeFrame(state);
  const offer = frame?.offer ?? null;
  if (!frame || !offer || !offer.slot || offer.kind !== "slot_value") {
    return { commands };
  }
  const step = stepForSlot(registry[frame.flow], offer.slot);
  if (!step?.canonicalAnswer || !step.resolveValue) return { commands };
  const spoken = context.turn.text.trim();
  if (!spoken) return { commands };

  const resolution = await resolveSlotValue({
    step,
    slot: offer.slot,
    frame,
    context,
    spoken,
  });
  if (resolution.kind !== "resolved") return { commands };

  const slot = offer.slot;
  /** Every command that was an attempt at answering this offer. */
  const aboutThisOffer = (command: Command): boolean => {
    switch (command.kind) {
      case "affirm_offer":
      case "reject_offer":
        return command.offerId === offer.id;
      case "set_slot":
      case "correct_slot":
        return command.slot === slot;
      case "ask_clarification":
        return true;
      default:
        return false;
    }
  };
  if (!commands.some(aboutThisOffer)) return { commands };

  const answer: Command = { kind: "set_slot", slot, value: spoken };
  const rest = commands.filter((command) => !aboutThisOffer(command));
  return { commands: [answer, ...rest] };
}

/**
 * "What can you help me with?" — a question about the assistant, not the clinic.
 *
 * ## The turn this exists for
 *
 * ```
 *   patient:   ممكن تساعدني في ايه؟
 *   assistant: أهلًا بيك! أقدر أساعدك في إيه النهاردة؟
 * ```
 *
 * The message reads as small talk to a model and as `clinic_other` to a
 * charitable one — and `clinic_other` is answered from the clinic's FAQ, which
 * has no row about the assistant, so the honest empty answer came back as the
 * generic opening. Either way the patient asked a real question and was
 * greeted back.
 *
 * ## What this does
 *
 * The same discipline as the other reconciliations: a deterministic reading of
 * the patient's own words outranks the command shape the model chose. The
 * lexicon is narrow and every alternative in it *ends on the question word* —
 * «تساعدني في إيه», «بتعمل ايه», "what can you help me with" — so «ممكن
 * تساعدني في حجز موعد» is not matched by any of it and starts a booking exactly
 * as before.
 *
 * The whole turn becomes one `answer_question(capabilities)`, which the engine
 * treats like every other read-only topic: a running booking is suspended
 * rather than dropped, the answer is drained, and the booking's own step asks
 * its question again on the same turn. In particular **no flow is started**,
 * even though booking is on the list the answer names.
 */
function reconcileCapabilityQuestion(input: {
  commands: readonly Command[];
  context: TurnContext;
}): { commands: readonly Command[] } {
  const spoken = foldArabic(input.context.turn.text).toLowerCase();
  if (!spoken || !CAPABILITY_QUESTION.test(spoken)) return { commands: input.commands };
  if (
    input.commands.length === 1 &&
    input.commands[0]!.kind === "answer_question" &&
    input.commands[0]!.topic === "capabilities"
  ) {
    return { commands: input.commands };
  }
  return { commands: [{ kind: "answer_question", topic: "capabilities" }] };
}

/**
 * The ways a patient asks what this assistant is for.
 *
 * Folded through `foldArabic` first, so «إيه», «ايه» and «ايه؟» are one word.
 * Every alternative requires the question word next to the verb, which is what
 * separates «تساعدني في إيه؟» from «تساعدني في حجز موعد».
 */
const CAPABILITY_QUESTION =
  /(?:(?:تساعدني|تساعدنى|تفيدني|تعملي|تعمللي)\s*(?:في|ب|بـ)?\s*[اإ]?يه|بتعمل\s*[اإ]?يه|بتقدر\s*تعمل\s*[اإ]?يه|[اإ]يه\s*(?:الحاجات|الحاجه|الخدمات|اللي|الي)\s*(?:ال?لي\s*)?(?:ممكن\s*|تقدر\s*|اقدر\s*|أقدر\s*)?(?:تساعدني|اسال|أسأل|اسأل|اساله|استفسر)|[اإ]يه\s*امكانياتك|[اإ]يه\s*قدراتك|what\s+can\s+(?:you|u)\s+(?:help|do)|what\s+can\s+i\s+ask|how\s+can\s+you\s+help|what\s+(?:do|are)\s+you\s+(?:do|able)|what\s+are\s+your\s+capabilities)/u;

/**
 * A refinement of the question the patient is already being asked.
 *
 * ## The turn this exists for
 *
 * The assistant offered available days. The patient paused a few minutes and
 * wrote «ايه الايام المتاحة بعد يوم 11». They were answered «اتفضل، أقدر
 * أساعدك في إيه؟»; they repeated themselves, and were then told their identity
 * had to be verified before their record could be reached.
 *
 * Nothing had expired. The booking frame's idle limit is thirty minutes, it was
 * still `active`, and its day offer was still open. The failure was that the
 * sentence had **nowhere to go**: it is neither an answer to the offer nor a
 * new subject, and the only shape in the command vocabulary that fits it —
 * `set_slot(date_lower_bound)` — belonged to no step, so even when the
 * interpreter did emit it the engine dropped it as `slot_not_in_flow`. Left
 * with no representable reading, the model chose between a clarification and a
 * read-only topic; the second reading is what reached for `my_appointments`,
 * and that topic's own identity gate produced the challenge.
 *
 * ## What this does about it
 *
 * The same thing `reconcileCanonicalAnswer` does for the beneficiary question,
 * for the same reason: while a step is waiting on a value, a deterministic
 * reading of the patient's own words outranks the command shape the model
 * chose. `parseDateLowerBound` is arithmetic on a small lexicon — it fires only
 * on an explicit "after / from / next week" marker — so an ordinary day answer
 * («الثلاثاء», «8 سبتمبر», "2") is never mistaken for a refinement.
 *
 * ## What it deliberately does not do
 *
 *   * It does not run unless a booking or reschedule frame is **active** and
 *     its `day` slot is still **empty**. A refinement is a narrowing of an open
 *     request; changing a day already chosen is a correction, which the
 *     existing `correct_slot` cascade already handles and which must keep
 *     invalidating the time.
 *   * It does not touch state, start a flow, or clear a slot. It rewrites at
 *     most one turn's commands; every guarantee downstream — resolution against
 *     the clinic's calendar, the precondition gate, provenance — is unchanged.
 *   * It does not read anything. No clinic call, no durable fact, no model.
 */
function reconcileDayRefinement(input: {
  commands: readonly Command[];
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
}): { commands: readonly Command[] } {
  const { commands, state, context, registry } = input;
  const frame = activeFrame(state);
  if (!frame) return { commands };
  // Only a flow whose day step can hold a bound. `stepForSlot` answers that
  // from the definition, so a flow that does not declare `date_lower_bound`
  // is skipped rather than special-cased by name.
  const step = stepForSlot(registry[frame.flow], "date_lower_bound");
  if (!step) return { commands };
  // The day must still be the open question. A committed day makes this a
  // correction, not a refinement, and corrections have their own cascade.
  if (frame.slots.day) return { commands };
  const spoken = context.turn.text.trim();
  if (!spoken) return { commands };

  const today = formatInTimeZone(context.now, context.clinic.timeZone, "yyyy-MM-dd");
  const bound = parseDateLowerBound(spoken, today, {
    // The list the patient is looking at *right now*, and only that. A parked,
    // answered or invalidated offer is not on the frame, so «بعد التاريخ ده»
    // resolves to nothing rather than to a boundary out of a stale list (I-2).
    offeredDates: liveOfferedDates(frame),
  });
  if (!bound?.explicit) return { commands };
  // Nothing is dropped except the readings of *this* sentence that the bound
  // replaces. A turn that also asked something unrelated keeps that command.
  const displaced = (command: Command): boolean =>
    command.kind === "ask_clarification" ||
    (command.kind === "answer_question" && command.topic !== "clinic_other") ||
    (command.kind === "set_slot" && command.slot === "day") ||
    (command.kind === "correct_slot" && command.slot === "day") ||
    command.kind === "suspend_flow" ||
    command.kind === "start_flow";
  const rest = commands.filter((command) => !displaced(command));
  return {
    commands: [
      { kind: "set_slot", slot: "date_lower_bound", value: spoken },
      ...rest,
    ],
  };
}

/**
 * An acceptance of a multi-option list, read as the selection it plainly was.
 *
 * ## The turn this exists for
 *
 * From a live WhatsApp session, four times in ninety seconds:
 *
 * ```
 *   assistant: تقصد أنهي واحد فيهم؟
 *              1- 2003-04-02
 *              2- 2003-02-04
 *   patient:   1
 *   assistant: تقصد أنهي واحد فيهم؟
 *              1- 2003-04-02
 *              2- 2003-02-04
 * ```
 *
 * The engine's own numeric selection was never reached. `resolveOfferIndex`
 * lives on the `set_slot` path, and the interpreter had emitted `affirm_offer`
 * — its honest reading of "answer THE OPEN OFFER". A bare affirmation of a
 * list with no primary option is ambiguous *by construction*, so `applyCommand`
 * answered with the very list that had just been shown, and the patient's
 * answer was correct every single time. The same shape swallowed «2» against
 * the twenty-slot time list and «الساعة 9 وربع» against it.
 *
 * ## What this does
 *
 * Only for the offer shape whose affirmation the engine already refuses — more
 * than one option and no `primaryOptionId` — it re-reads the turn text through
 * the *same* two mechanisms an ordinary answer goes through, in the same order:
 *
 *   1. `resolveOfferIndex`, against the live offer, so "1" is the first line;
 *   2. the owning step's own `resolveValue`, so «الساعة 9 وربع» is grounded
 *      against the clinic's real availability exactly as it would have been.
 *
 * If either reads the message, the affirmation is rewritten into the `set_slot`
 * it was, and everything downstream — resolution, the rejected-value check,
 * provenance, the cascade — is the ordinary path. If neither does, **nothing
 * changes**: a genuine bare «اه» against a list still gets "which one?", which
 * is the right answer to it.
 *
 * ## What it deliberately does not do
 *
 *   * It never invents a referent. The index is resolved against `frame.offer`,
 *     so an offer that was withdrawn by parking, by a correction or by having
 *     been answered selects nothing (I-2).
 *   * It never widens what may be committed. The step's resolver is the same
 *     authority it always was; a value the clinic's data does not carry is
 *     still not a value.
 *   * It does not touch offers that are not about a slot — a summary, a
 *     document choice, a resume prompt — because accepting one of those is
 *     consent rather than selection, and consent is `affirm_offer`'s own job.
 */
async function reconcileOfferSelection(input: {
  commands: readonly Command[];
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
}): Promise<{ commands: readonly Command[] }> {
  const { commands, state, context, registry } = input;
  const frame = activeFrame(state);
  const offer = frame?.offer ?? null;
  if (!frame || !offer || !offer.slot || offer.kind !== "slot_value") {
    return { commands };
  }
  // The one shape the engine cannot honour. A single-option offer and one with
  // a primary are both answerable by a bare yes, and must keep being.
  if (offer.options.length <= 1 || offer.primaryOptionId !== null) return { commands };
  if (!commands.some((command) => command.kind === "affirm_offer" && command.offerId === offer.id)) {
    return { commands };
  }
  const spoken = context.turn.text.trim();
  if (!spoken) return { commands };

  const slot = offer.slot;
  const step = stepForSlot(registry[frame.flow], slot);
  if (!step) return { commands };

  const readable =
    resolveOfferIndex({ frame, slot, spoken }) !== null ||
    (await resolveSlotValue({ step, slot, frame, context, spoken })).kind === "resolved";
  if (!readable) return { commands };

  const answer: Command = { kind: "set_slot", slot, value: spoken };
  const rest = commands.filter(
    (command) =>
      !(
        (command.kind === "affirm_offer" && command.offerId === offer.id) ||
        command.kind === "ask_clarification"
      ),
  );
  return { commands: [answer, ...rest] };
}

/**
 * A reference to the number this conversation is being held on, read as the
 * answer to the phone question that is open right now.
 *
 * ## The turn this exists for
 *
 * ```
 *   assistant: ممكن رقم تليفون المريض؟
 *   patient:   خلي رقمها رقمي لأنها مراتي
 *   assistant: ممكن رقم تليفون المريض؟
 * ```
 *
 * A requester opening a file for his wife. The sentence has no digits in it, so
 * the intake's phone branch resolved nothing; and because the sentence is not a
 * *value*, the interpreter's honest reading of it was often a clarification
 * rather than a `set_slot` — which meant the resolver never saw it either. The
 * patient was asked the same question until they gave up.
 *
 * ## What this does
 *
 * The fourth application of the rule 1b, 1c and 1d already establish: while the
 * server is standing on one specific question, a deterministic reading of the
 * patient's own words outranks the command shape the model chose. It rewrites
 * the turn into the `set_slot(phone)` it plainly was and stops. The value that
 * lands on the frame is produced by the intake step's own resolver, from the
 * conversation's own `participantAddress` — not by anything here.
 *
 * ## What it deliberately does not do
 *
 *   * It runs **only** while the frame is an explicit third-party intake
 *     (`beneficiary === "other"`) that is waiting on `phone`. A self-booking is
 *     never asked for a number, so it can never reach this; and a phone
 *     question in some other flow is not one of these sentences' referents.
 *   * It never fires when the message carries a number. An explicit literal
 *     beneficiary phone wins, exactly as before — the digits are checked here
 *     as well as in the resolver, so a message containing both a number and the
 *     word «رقمي» is left to the ordinary path.
 *   * It reads nothing, writes nothing, and starts nothing. It touches one
 *     turn's command list.
 *   * It changes no ownership. `phone` is contact data on the beneficiary's
 *     staged file; the conversation's patient, the requester, the identity
 *     level and every approval remain exactly what they were.
 */
function reconcileOwnNumberReference(input: {
  commands: readonly Command[];
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
}): { commands: readonly Command[] } {
  const { commands, state, context, registry } = input;
  const frame = activeFrame(state);
  if (!frame) return { commands };
  // An explicit third-party flow, and nothing else.
  if (frame.slots.beneficiary?.value !== "other") return { commands };
  // The phone question has to be the one standing open.
  const awaiting = frame.offer?.slot ?? frame.memo[AWAITING_SLOT];
  if (awaiting !== "phone") return { commands };
  if (!stepForSlot(registry[frame.flow], "phone")) return { commands };

  const spoken = context.turn.text.trim();
  if (!spoken) return { commands };
  // A message with a number in it is a number, whatever else it says.
  if (foldArabic(spoken).replace(/[^0-9]/g, "").length >= 7) return { commands };
  if (!readsAsOwnNumberReference(spoken)) return { commands };

  const displaced = (command: Command): boolean =>
    command.kind === "ask_clarification" ||
    ((command.kind === "set_slot" || command.kind === "correct_slot") &&
      command.slot === "phone");
  if (
    commands.length === 1 &&
    commands[0]!.kind === "set_slot" &&
    commands[0]!.slot === "phone" &&
    commands[0]!.value === spoken
  ) {
    // The interpreter already read it this way. Nothing to rewrite.
    return { commands };
  }
  const rest = commands.filter((command) => !displaced(command));
  return {
    commands: [{ kind: "set_slot", slot: "phone", value: spoken }, ...rest],
  };
}

/**
 * «نفس إيميلي» is an answer to the email question, not a failure to give one.
 *
 * The email counterpart of {@link reconcileOwnNumberReference}, and the same
 * discipline: while the server is standing on one specific question, a
 * deterministic reading of the patient's own words outranks the command shape
 * the model chose. It rewrites the turn into the `set_slot(email)` it plainly
 * was and stops.
 *
 * What it deliberately does not do:
 *
 *   * It runs **only** while the frame is an explicit third-party intake
 *     (`beneficiary === "other"`) that is waiting on `email`. A sender opening
 *     their own file can never reach it.
 *   * It never fires when the message carries an address. An explicit literal
 *     beneficiary email wins, exactly as before — a message containing both an
 *     `@` and the word «إيميلي» is left to the ordinary path.
 *   * It reads nothing, writes nothing, and starts nothing. It touches one
 *     turn's command list, and the resolver behind it may still decline: a
 *     requester whose record carries no usable address gets the question again
 *     rather than an invented value.
 *   * It changes no ownership. `email` is contact data on the beneficiary's
 *     staged file; the conversation's patient, the identity level and every
 *     approval remain exactly what they were.
 */
function reconcileOwnEmailReference(input: {
  commands: readonly Command[];
  state: FlowState;
  context: TurnContext;
  registry: FlowRegistry;
}): { commands: readonly Command[] } {
  const { commands, state, context, registry } = input;
  const frame = activeFrame(state);
  if (!frame) return { commands };
  if (frame.slots.beneficiary?.value !== "other") return { commands };
  const awaiting = frame.offer?.slot ?? frame.memo[AWAITING_SLOT];
  if (awaiting !== "email") return { commands };
  if (!stepForSlot(registry[frame.flow], "email")) return { commands };

  const spoken = context.turn.text.trim();
  if (!spoken) return { commands };
  // A message with an address in it is an address, whatever else it says.
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(spoken)) return { commands };
  if (!readsAsOwnEmailReference(spoken)) return { commands };

  const displaced = (command: Command): boolean =>
    command.kind === "ask_clarification" ||
    ((command.kind === "set_slot" || command.kind === "correct_slot") &&
      command.slot === "email");
  if (
    commands.length === 1 &&
    commands[0]!.kind === "set_slot" &&
    commands[0]!.slot === "email" &&
    commands[0]!.value === spoken
  ) {
    // The interpreter already read it this way. Nothing to rewrite.
    return { commands };
  }
  const rest = commands.filter((command) => !displaced(command));
  return {
    commands: [{ kind: "set_slot", slot: "email", value: spoken }, ...rest],
  };
}

/**
 * The `YYYY-MM-DD` days the frame's **live** day offer is showing.
 *
 * Empty for every other shape of offer and for no offer at all, which is what
 * makes a contextual "after these dates" impossible to answer from a list the
 * patient cannot see. The offer is read off the frame rather than out of the
 * transcript, so it is withdrawn by exactly the things that withdraw an offer:
 * parking, a correction, an answer.
 */
function liveOfferedDates(frame: FlowFrame): readonly string[] {
  const offer = frame.offer;
  if (!offer || offer.slot !== "day" || offer.kind !== "slot_value") return [];
  return offer.options
    .map((option) => String(option.value))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
}

/**
 * The option a bare number selects, from the offer that is open right now.
 *
 * The numbered lists the composer renders are a *presentation* of one offer,
 * and this is the other half of that: "2" means the second line of the list the
 * patient is looking at, and it means nothing at all otherwise. Three
 * properties, all structural rather than remembered:
 *
 *   * the index is resolved against `frame.offer` — the live one — so a number
 *     cannot select against a list that was withdrawn when the frame parked,
 *     was answered, or was invalidated by a correction;
 *   * the offer's `slot` must be the slot being filled, so a number meant for a
 *     day list cannot land in the doctor slot;
 *   * the option's `value` is the server's own canonical id, carried straight
 *     from the offer, so nothing is matched, scored or parsed.
 *
 * Provenance is `affirmed`, which is what selecting from a list the server put
 * in front of the patient actually is (I-5).
 */
function resolveOfferIndex(input: {
  frame: FlowFrame;
  slot: SlotName;
  spoken: string;
}): { value: string | number; label: string } | null {
  const offer = input.frame.offer;
  if (!offer || offer.slot !== input.slot) return null;
  const index = offerIndexFromSpoken(input.spoken);
  if (index === null) return null;
  const option = offer.options[index - 1];
  if (!option) return null;
  return { value: option.value, label: option.label };
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
  slot: SlotName;
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
      slot: input.slot,
      frame: input.frame,
      context: input.context,
    });
  } catch {
    // A resolver that threw has proven nothing. Unresolved is the safe reading
    // and produces a question rather than a guess.
    return { kind: "unresolved" };
  }
}
