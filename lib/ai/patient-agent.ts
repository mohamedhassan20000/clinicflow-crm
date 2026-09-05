import "server-only";

import { ToolLoopAgent, stepCountIs, type UIMessage } from "ai";
import { assertAiInputWithinPolicy, type AiExecutionHandle } from "@/lib/ai/client";
import type { BookingStage } from "@/lib/ai/booking-stage";
import {
  allowedToolsForStage,
  STAGE_INDEPENDENT_TOOLS,
} from "@/lib/ai/booking-stage";
import {
  DEFAULT_COMMUNICATION_STYLE,
  type CommunicationStyle,
} from "@/lib/ai/communication-style";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import {
  buildPatientStagePrompt,
  buildPatientSystemPrompt,
} from "@/lib/ai/prompts/patient";
import {
  buildPatientTools,
} from "@/lib/ai/patient-tools";
import type { PatientToolContext } from "@/lib/ai/patient-authorization";
import { annotateToolsForPromptCache } from "@/lib/ai/platform/prompt-cache";
import { createPatientToolCallRepair } from "@/lib/ai/tool-call-repair";
import type { GroundingLedger } from "@/lib/ai/patient-grounding";
import {
  bookingAuthorityInstruction,
  shouldForceAuthority,
  type BookingAuthority,
} from "@/lib/ai/booking-authority";

type PatientAgentContext = {
  clinicId: string;
  conversationId: string;
  locale: PromptLocale;
  execution: AiExecutionHandle;
  /**
   * P9 — the stage this turn opens in, resolved by the server before the model
   * is constructed, or `null` when stage-scoped orchestration is switched off.
   *
   * Passing a value rather than a loader is deliberate. The stage is a fact
   * about the conversation as the turn begins; recomputing it inside the model
   * loop would mean an extra `resolve_patient_ai_context` round trip per step,
   * and — worse — would make the mount depend on state the tools were mutating
   * mid-loop, which is a race with a security-shaped failure mode. The tools
   * that *change* the stage persist it; the next inbound turn picks it up.
   */
  bookingStage?: BookingStage | null;
  /**
   * P10 — the clinic's configured language, Arabic register, tone and style
   * line. Defaulted, so a caller that does not resolve it still builds the
   * certified prompt with the certified defaults rather than nothing.
   */
  communicationStyle?: CommunicationStyle;
  /**
   * P10 — the per-turn briefing: what is settled, what is outstanding, what is
   * genuinely missing, and whether the patient has just said goodbye.
   *
   * Mounted on every step, in both the base instructions and the stage-scoped
   * override, because the failure it fixes — asking again for a name the
   * patient gave four messages ago — happens on the steps *after* the first
   * one just as readily as on the first.
   */
  turnBriefing?: string | null;
  /**
   * P11 — the turn's grounding ledger, threaded into every tool's context so
   * the entities the server returned can be compared against the entities the
   * reply names. Optional: an agent built without one behaves exactly as it did
   * before, which is what keeps every existing caller and test valid.
   */
  grounding?: GroundingLedger | null;
  /**
   * P11G — the authoritative operation this turn needs, resolved server-side
   * by `openBookingStageTurn` before the model is constructed.
   *
   * Two effects, both narrow. It appends one sentence to the stage prompt
   * naming the operation (or, when a committed offer already satisfies the
   * step, telling the model *not* to call anything), and on the first step of a
   * turn whose requirement is genuinely unmet it pins `toolChoice` to that one
   * tool. It never widens the mount: `shouldForceAuthority` refuses to pin a
   * tool the stage table has hidden, so a stage can still only ever subtract.
   *
   * Optional. An agent built without one behaves exactly as it did before this
   * phase, which is what keeps every existing caller and test valid.
   */
  authority?: BookingAuthority | null;
  /**
   * P11G — the per-turn record of what the model actually did with that
   * requirement. Written by the agent, read by the caller after `generate`, so
   * the audit can distinguish the model tool path from the fallback path
   * without the caller having to re-derive either.
   */
  observer?: AuthorityObserver | null;
  /**
   * F-8 / F-11 — the patient's own inbound messages for the current episode.
   *
   * Threaded straight into the tool context and read only by the two
   * provenance gates. It changes nothing about the mount, the prompt or the
   * model request; it is what lets a tool refuse to commit a value the patient
   * never supplied. See `PatientToolContext.episodeUtterances`.
   */
  episodeUtterances?: readonly string[];
  /** Exact read-only scope for an unrelated FAQ/privacy/service turn. */
  informationalTools?: readonly string[] | null;
  timeFormat?: "12h" | "24h";
};

/**
 * What the model did with the turn's authority requirement.
 *
 * Deliberately labels and booleans only — this ends up in `audit_logs` beside
 * the stage trace, and neither a tool argument nor a tool result belongs there.
 */
export type AuthorityObserver = {
  /** True once `toolChoice` was pinned to the required operation. */
  forced: boolean;
  /** Tool names the model asked for, in order. */
  requested: string[];
};

export function createAuthorityObserver(): AuthorityObserver {
  return { forced: false, requested: [] };
}

export function createPatientAgent(ctx: PatientAgentContext) {
  const task = ctx.execution.taskPolicy.task;
  if (task !== "patient_booking" && task !== "patient_faq") {
    throw new Error("Patient agent requires a certified patient task class.");
  }
  const toolContext: PatientToolContext = {
    clinicId: ctx.clinicId,
    conversationId: ctx.conversationId,
    locale: ctx.locale,
    aiRequestId: ctx.execution.requestId,
    grounding: ctx.grounding ?? null,
    informationalOnly: ctx.informationalTools !== null && ctx.informationalTools !== undefined,
    timeFormat: ctx.timeFormat ?? "24h",
    ...(ctx.episodeUtterances ? { episodeUtterances: ctx.episodeUtterances } : {}),
  };

  // The mount is unchanged, always. Stage scoping narrows what is *active* for
  // a step; it never changes what is registered. That distinction is what keeps
  // the P6A containment claim intact — an unauthorized tool is still not in the
  // object at all, and a stage can only ever hide one the persona already had.
  const style = ctx.communicationStyle ?? DEFAULT_COMMUNICATION_STYLE;
  const briefing = ctx.turnBriefing ?? null;
  // F-14 — the tool block is the largest byte-stable region of the request and
  // the only one shared across conversations, so it carries the cache
  // breakpoint. Which transports support that, and where the marker may safely
  // sit, is decided by the platform layer: this call names no provider, and on
  // a transport without caching it returns the tools unchanged.
  const tools = annotateToolsForPromptCache(
    buildPatientTools(toolContext, task),
    ctx.execution.transport,
    { alwaysActive: STAGE_INDEPENDENT_TOOLS },
  );
  const mounted = Object.keys(tools);
  const stage = ctx.bookingStage ?? null;
  const authority = ctx.authority ?? null;
  const stageActiveTools =
    stage && task === "patient_booking"
      ? allowedToolsForStage(stage, mounted)
      : null;
  // P11I — this turn asks for a clinic-wide fact, not for booking progress.
  // Keep the directory read as the only active tool for every model step so a
  // later auto step cannot call `prepare_booking` and clear or replace a valid
  // booking selection after the authoritative directory result is returned.
  // This narrows the registered mount; it never adds to it.
  const authorityScopedTools =
    authority?.reason === "needs_clinic_directory" &&
    mounted.includes("list_clinic_departments")
      ? ["list_clinic_departments"]
      : stageActiveTools;
  // A settled slot is not itself write consent. Keep the write tool out of the
  // model-visible set on the summary turn; it becomes callable on the next
  // turn only when the server classifies an explicit confirmation.
  const confirmationScopedTools =
    authority?.reason === "needs_booking_confirmation"
      ? authorityScopedTools?.filter((name) => name !== "create_preliminary_booking") ?? null
      : authorityScopedTools;
  const activeTools = ctx.informationalTools
    ? ctx.informationalTools.filter((name) => mounted.includes(name))
    : confirmationScopedTools;
  const observer = ctx.observer ?? null;
  // The tools genuinely callable this turn: the stage-scoped set when there is
  // one, otherwise the flat mount. `shouldForceAuthority` is checked against
  // this and nothing else, so a rollback to `shadow` or `off` cannot produce a
  // pin naming a tool that is not there.
  const callable = activeTools ?? mounted;
  const authorityLine =
    authority
      ? bookingAuthorityInstruction(ctx.locale === "ar" ? "ar" : "en", authority)
      : null;

  return new ToolLoopAgent({
    id: "clinicflow-patient-assistant",
    model: ctx.execution.model,
    providerOptions: ctx.execution.providerOptions,
    instructions:
      buildPatientSystemPrompt(ctx.locale, style) +
      (briefing ? `\n\n${briefing}` : "") +
      (authorityLine ? `\n\n${authorityLine}` : ""),
    tools,
    stopWhen: stepCountIs(ctx.execution.taskPolicy.maxSteps),
    // P9C — a tool call the SDK cannot parse is repaired into one it can, so it
    // reaches `execute` and comes back as a real tool result. Without this, an
    // unparseable call is answered to the model with the raw validator message,
    // which is neither auditable nor recoverable and which the patient hears as
    // "there is a technical problem, please phone the clinic". See
    // `tool-call-repair.ts` for why the repair only ever subtracts.
    experimental_repairToolCall: createPatientToolCallRepair(ctx.clinicId),
    temperature: ctx.execution.taskPolicy.temperature,
    maxOutputTokens: ctx.execution.taskPolicy.maxOutputTokens,
    prepareStep: ({ messages, stepNumber }) => {
      ctx.execution.beginStep();
      assertAiInputWithinPolicy(
        messages,
        ctx.execution.taskPolicy.maxInputTokensPerStep,
      );
      // P11G — the one turn-level override that can *add* an obligation rather
      // than remove one, and the reason it is safe to: it can only ever name a
      // tool that is already callable this step, and it fires only on the first
      // step of a turn the server has determined needs fresh clinic state.
      //
      // Deliberately not `toolChoice: "required"`. A patient who writes
      // "شكراً" mid-booking resolves to `requirement: none` upstream (see
      // `resolveBookingAuthority`), so no tool is pinned and the turn is
      // answered in ordinary language — which is what a thank-you deserves.
      const forced =
        authority !== null &&
        shouldForceAuthority({ authority, mountedTools: callable, stepNumber });
      // P11I-R — the same "a directory turn cannot move the booking" guarantee
      // as above, but keyed on what actually happened rather than on whether
      // the server could prove the question's shape. Once the clinic-wide
      // directory has been read this turn, the rest of the turn is restricted
      // to the read-only, non-workflow tools. A paraphrase nobody enumerated
      // therefore gets the same protection as `ايه الاقسام الموجودة؟`.
      //
      // Narrowing only: it intersects whatever set was already active, so it
      // can never re-expose a tool the stage or the authority removed.
      const readDirectory =
        ctx.grounding?.toolsSeen().includes("list_clinic_departments") ?? false;
      const stepTools = readDirectory
        ? (activeTools ?? mounted).filter((name) =>
            (STAGE_INDEPENDENT_TOOLS as readonly string[]).includes(name),
          )
        : activeTools;
      const pin =
        forced && authority?.operation
          ? { toolChoice: { type: "tool" as const, toolName: authority.operation } }
          : {};
      if (forced && observer) observer.forced = true;
      if (!stage || task !== "patient_booking") {
        return {
          ...(stepTools ? { activeTools: [...stepTools] } : {}),
          ...pin,
        };
      }
      // Two overrides, both narrowing:
      //   * `activeTools` — only the tools this stage has a legitimate use for.
      //     `create_preliminary_booking` is simply absent until the day and the
      //     time are both established, which is the rule the prompt could only
      //     ask for politely.
      //   * `system` — the always-on safety sections plus the workflow prose
      //     for this stage, instead of all of it. The bilingual behaviour is
      //     preserved because the fragments are the same certified sentences in
      //     the same language, selected rather than rewritten.
      return {
        ...(stepTools ? { activeTools: [...stepTools] } : {}),
        ...pin,
        system:
          buildPatientStagePrompt(ctx.locale, stage, style, briefing) +
          (authorityLine ? `\n${authorityLine}` : ""),
      };
    },
    onStepFinish: (step) => {
      // Recorded before the execution handle sees the step, so an accounting
      // failure cannot lose the trace of what the model asked for.
      if (observer) {
        for (const call of step.toolCalls ?? []) {
          if (typeof call.toolName === "string") observer.requested.push(call.toolName);
        }
      }
      return ctx.execution.observeStep(step);
    },
  });
}

export type PatientAssistantUIMessage = UIMessage;
