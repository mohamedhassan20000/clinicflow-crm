/**
 * The V2 turn: context → interpreter → commands → engine → tools → composer.
 *
 * ## Where this sits
 *
 * `runPatientInboundAiReply` still owns everything around a turn — the AI
 * on/off controls, the episode boundary, the escalation detection, the human
 * takeover, the technical-failure latch, the send and the suggestion record.
 * None of that was the problem and none of it is duplicated here. This function
 * replaces exactly one thing: the part between "we have the patient's message
 * and the episode's history" and "here is the reply".
 *
 * ## Failing closed
 *
 * Three conditions hand the turn back to the legacy engine rather than
 * improvising: the flag is off, the flow-state column is absent, or the
 * context could not be assembled. Each returns `{ handled: false }` and the
 * caller proceeds exactly as it did before. A half-working V2 must never be
 * the thing that answers a patient.
 */

import "server-only";

import * as Sentry from "@sentry/nextjs";
import { logAgentTool } from "@/lib/ai/audit";
import type { AiExecutionHandle } from "@/lib/ai/client";
import type { CommunicationStyle } from "@/lib/ai/communication-style";
import { compose } from "@/lib/ai/v2/composer";
import { interpreterView, type TurnContext } from "@/lib/ai/v2/context";
import { runEngine } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { interpret } from "@/lib/ai/v2/interpreter";
import { loadFlowState, saveFlowState } from "@/lib/ai/v2/store";
import { buildTurnContext } from "@/lib/ai/v2/assemble";
import type { PatientEscalationReason } from "@/lib/ai/patient-escalation";

/**
 * Which engine answers a patient turn.
 *
 * `legacy` is the default and stays the default until the shadow evaluation
 * says otherwise. `v2` is opt-in per environment; the intended rollout is a
 * per-clinic allow-list, which is a change to {@link patientEngineMode} and
 * nothing else.
 */
export type PatientEngineMode = "legacy" | "v2";

export function patientEngineMode(clinicId?: string): PatientEngineMode {
  const raw = process.env.AI_PATIENT_ENGINE?.trim().toLowerCase();
  if (raw !== "v2") return "legacy";
  // A comma-separated allow-list narrows `v2` to named clinics. Empty means
  // every clinic, which is correct for a development environment and is the
  // thing a rollout replaces with an explicit list.
  const allow = (process.env.AI_PATIENT_ENGINE_CLINICS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allow.length === 0) return "v2";
  return clinicId && allow.includes(clinicId) ? "v2" : "legacy";
}

/**
 * How a V2 handoff reason maps onto the escalation vocabulary the Inbox,
 * notifications and reports already speak.
 *
 * Total by construction — an unmapped reason becomes `agent_error`, which is
 * the honest label for "the engine gave up in a way nobody enumerated" and is
 * the one reading that cannot silently look like an ordinary low-confidence
 * turn. The mapping lives here rather than in `patient-reply.ts` so that the
 * two vocabularies meet in exactly one place.
 */
export function escalationReasonForHandoff(
  reason: string,
): PatientEscalationReason {
  switch (reason) {
    case "patient_requested_human":
      return "human_requested";
    case "clinical_question":
      return "medical";
    case "complaint":
    case "payment_dispute":
      return "complaint";
    case "unsupported_request":
      return "low_confidence";
    default:
      return "agent_error";
  }
}

export type V2TurnResult =
  | {
      handled: true;
      text: string;
      /** True when the turn asked the patient something. Feeds the lifecycle. */
      outstanding: boolean;
      /** True when a flow concluded on this turn. */
      completed: boolean;
      /** The patient asked for a person, or a step gave up. */
      handoff: { reason: string } | null;
      /** The patient said they were finished. */
      ended: boolean;
    }
  | { handled: false; reason: "disabled" | "unavailable" | "context_failed" };

export async function runPatientTurnV2(input: {
  clinicId: string;
  conversationId: string;
  message: string;
  locale: "ar" | "en";
  style: CommunicationStyle;
  /**
   * The episode's own transcript, already bounded by `EpisodeContext` in the
   * caller. Passed in rather than re-read so the V2 path cannot establish a
   * second, different answer to "what is in this episode".
   */
  episode: readonly { role: "patient" | "assistant"; text: string; at: string }[];
  execution: AiExecutionHandle;
  now?: Date;
}): Promise<V2TurnResult> {
  if (patientEngineMode(input.clinicId) !== "v2") {
    return { handled: false, reason: "disabled" };
  }
  // Everything from here answers *or* leaves a trace saying why it did not.
  //
  // Two of the three fallbacks used to be silent, and that cost a whole manual
  // QA pass: eight defects were recorded against V2 by a session that had in
  // fact been answered end to end by the legacy engine, and the only way to
  // know was that `audit_logs` held no V2 line at all. "Which engine answered
  // this turn?" must be a question the audit trail answers on its own.

  const loaded = await loadFlowState({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
  });
  if (loaded.status !== "ok") {
    // The column is not there. The legacy engine answers, and an operator can
    // see from this line that V2 was asked for and could not run.
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_v2_unavailable",
      params: { reason: "flow_state_column" },
    }).catch(() => undefined);
    return { handled: false, reason: "unavailable" };
  }

  let context: TurnContext;
  try {
    context = await buildTurnContext({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      message: input.message,
      locale: input.locale,
      style: input.style,
      episode: input.episode,
      flows: loaded.state,
      now: input.now ?? new Date(),
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: "patient-ai-v2-context" } });
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_v2_unavailable",
      params: { reason: "context_failed" },
    }).catch(() => undefined);
    return { handled: false, reason: "context_failed" };
  }

  // 1. Language → commands. No tools, no writes, no durable facts.
  const interpreted = await interpret({
    view: interpreterView(context),
    execution: input.execution,
  });

  // 2. Commands → state and effects. No model.
  const engine = await runEngine({
    context,
    commands: interpreted.commands,
    registry: FLOW_REGISTRY,
  });

  // 3. Persist. The one writer of flow state.
  const saved = await saveFlowState({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    state: engine.state,
  });
  if (!saved.ok) {
    // The stack *is* the state here, so a lost write would present the next
    // turn with a flow that had forgotten a step. Better to hand this turn to
    // the legacy engine than to answer from a state nobody recorded.
    // `code` is a classification — `rpc_error:42501`, `client_threw:TypeError`,
    // `column_unavailable` — and never a message. Without it the audit line
    // said only that a write failed, which is true of a permission denial, a
    // missing migration and a client-side TypeError alike; telling them apart
    // from production audit logs is the difference between an hour and a week.
    Sentry.captureMessage("patient_ai_v2_state_write_failed", {
      level: "error",
      tags: { area: "patient-ai-v2-runtime", cause: saved.code },
    });
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_v2_unavailable",
      params: { reason: "state_write_failed", cause: saved.code },
    }).catch(() => undefined);
    return { handled: false, reason: "unavailable" };
  }

  // 4. Effects → prose. Cannot change what happened.
  const composed = await compose({
    effects: engine.effects,
    locale: input.locale,
    style: input.style,
    execution: input.execution,
  });

  // One audit line per turn, labels and counts only — no patient words, no
  // slot values, no ids. This is the trace the shadow evaluation reads.
  await logAgentTool({
    clinicId: input.clinicId,
    actorId: null,
    tool: "patient_v2_turn",
    params: {
      commands: interpreted.commands.map((command) => command.kind),
      parse: interpreted.outcome,
      dropped: interpreted.dropped,
      trace: engine.trace,
      reply: composed.outcome,
      keys: composed.keys,
      stack: engine.state.stack.map((frame) => `${frame.flow}:${frame.status}`),
    },
  }).catch(() => undefined);

  const handoff = engine.effects.find((effect) => effect.kind === "handoff");
  return {
    handled: true,
    text: composed.text,
    outstanding: engine.effects.some(
      (effect) => effect.kind === "ask" || effect.kind === "offer",
    ),
    completed: engine.trace.some((entry) => entry.endsWith("_complete") || entry === "flow_completed"),
    handoff: handoff && handoff.kind === "handoff" ? { reason: handoff.reason } : null,
    ended: engine.effects.some((effect) => effect.kind === "end_conversation"),
  };
}
