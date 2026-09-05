import * as Sentry from "@sentry/nextjs";
import { consumeStream, convertToModelMessages, type UIMessage } from "ai";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import {
  AI_STAFF_ANALYTICS_FEATURE,
  authorizeStaffAssistant,
} from "@/lib/ai/authorization";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  createAiRequestId,
  prepareAiExecution,
  staffTaskForRole,
  AiPolicyInputLimitError,
  type AiExecutionHandle,
  type AiExecutionOutcome,
} from "@/lib/ai/client";
import {
  AiConversationError,
  ensureDoctorConversation,
  persistDoctorTurn,
} from "@/lib/ai/conversations";
import { createStaffAgent } from "@/lib/ai/staff-agent";
import {
  applyProposals,
  ConversationContextRecorder,
  hasActiveEntitySlot,
} from "@/lib/ai/conversation-context";
import { resolvePageContextSeed } from "@/lib/ai/page-context-seed";
import {
  modelSafeHistory,
  persistedAssistantState,
} from "@/lib/ai/conversation-parts";
import {
  AiToolAuthorizationError,
  type AssistantErrorCode,
} from "@/lib/ai/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import {
  parseAssistantPageContext,
  patientIdFromAssistantPageContext,
  type AssistantPageContext,
} from "@/lib/ai/page-context";

export const maxDuration = 60;

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();
const requestSchema = z
  .object({
    id: z.string().uuid(),
    // Page context has its own strict discriminated-union parser. Keeping this
    // field unknown here lets malformed/forward-version context be dropped
    // without rejecting an otherwise valid Assistant turn.
    context: z.unknown().optional(),
    message: z
      .object({
        id: z.string().min(1).max(200),
        role: z.literal("user"),
        parts: z.array(textPartSchema).min(1).max(8),
      })
      .strict(),
  })
  .strict();

// The union lives in lib/ai/errors.ts so the client maps exactly the codes this
// route can emit — see ERROR_COPY_KEYS in components/assistant/assistant-chat.tsx.
type ErrorCode = AssistantErrorCode;

function errorResponse(code: ErrorCode, status: number, headers?: HeadersInit) {
  return Response.json({ error: code }, { status, headers });
}

function authorizationResponse(error: AiToolAuthorizationError) {
  const status =
    error.reason === "unauthenticated"
      ? 401
      : error.reason === "usage_limit_reached"
        ? 429
        : error.reason === "lookup_failed"
          ? 503
          : 403;
  return errorResponse(error.reason, status);
}

function messageText(message: z.infer<typeof requestSchema>["message"]): string {
  return message.parts.map((part) => part.text).join("\n").trim();
}

export async function POST(request: Request) {
  let execution: AiExecutionHandle | null = null;
  const finalizeExecution = async (
    outcome: AiExecutionOutcome,
    errorClass?: string,
  ) => {
    if (!execution) return;
    try {
      await execution.finalize({ outcome, errorClass });
    } catch (error) {
      Sentry.captureException(error, { tags: { area: "ai-budget-reconciliation" } });
    }
  };
  try {
    const user = await authorizeStaffAssistant();

    const rateLimit = await checkRateLimit("staff-assistant", user.clinicId, {
      limit: 30,
      windowSeconds: 60,
      failureMode: "open",
    });
    if (!rateLimit.allowed) {
      return errorResponse("rate_limited", 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return errorResponse("invalid_request", 400);
    const userText = messageText(parsed.data.message);
    if (!userText || userText.length > 4_000) {
      return errorResponse("invalid_request", 400);
    }
    const pageContext = parseAssistantPageContext(parsed.data.context);

    // The conversation is loaded *before* routing (action-routing fix).
    //
    // The class used to be computed from the current user message alone, so the
    // final turn of a multi-turn booking — "how do I book him for that slot?",
    // whose only operands are the patient and slot resolved in earlier turns —
    // read as a bare documentation question and lost the write surface. The
    // router now takes the conversation's live active-context slots as an
    // operand signal, which requires reading them first. `ensureDoctorConversation`
    // is a pure read (a first turn stays virtual until it is persisted), so
    // nothing is created for a turn that later fails the entitlement or budget
    // checks in `prepareAiExecution`.
    const locale = (await getLocale()) === "ar" ? "ar" : "en";
    const supabase = await createClient();
    const [{ data: clinic, error: clinicError }, conversation] = await Promise.all([
      supabase
        .from("clinics")
        .select("name")
        .eq("id", user.clinicId)
        .maybeSingle(),
      ensureDoctorConversation({
        supabase,
        user,
        conversationId: parsed.data.id,
        locale,
        patientId: patientIdFromAssistantPageContext(pageContext),
      }),
    ]);
    if (clinicError || !clinic) throw new AiConversationError("conversation_unavailable");

    // P4.6A: an administrative turn runs on the cheaper, tighter operational
    // task class only when the turn actually *is* an operational query — the
    // entitlement decides whether those tools exist, the turn's intent decides
    // the budget. Entitlements are cached per clinic, so this adds no
    // per-request database round-trip.
    const entitlements = await getEntitlements(user.clinicId);
    const { task, persona } = staffTaskForRole(user.role, {
      analyticsEntitled: hasFeature(entitlements, AI_STAFF_ANALYTICS_FEATURE),
      messageText: userText,
      // A launcher-opened conversation has no persisted slot yet on its first
      // turn — the page-context seed runs below — so the page the assistant was
      // opened on counts as a live entity for operand purposes. Presence only:
      // the seed itself is still re-read server-side through the caller's RLS
      // client, and this flag decides a budget, never an access.
      hasActiveEntityContext:
        hasActiveEntitySlot(conversation.activeContext) || pageContext !== null,
    });
    execution = await prepareAiExecution({
      user,
      requestId: createAiRequestId({
        clinicId: user.clinicId,
        actorId: user.id,
        conversationId: parsed.data.id,
        messageId: parsed.data.message.id,
      }),
      task,
      persona,
      surface: "staff_assistant",
    });

    const currentMessage: UIMessage = {
      id: parsed.data.message.id,
      role: "user",
      parts: [{ type: "text", text: userText }],
    };
    const uiMessages = [...conversation.messages, currentMessage];
    // Patient context is the only variant that participates in the existing
    // owner/clinic/RLS-backed conversation binding. Rebuild it from the
    // validated conversation result before prompt injection; every other
    // variant remains advisory and ephemeral for this turn.
    const authorizedPageContext: AssistantPageContext | null =
      pageContext?.type === "patient"
        ? conversation.patientId
          ? { type: "patient", patientId: conversation.patientId }
          : null
        : pageContext;
    // P4.10A: collects an active-context proposal (e.g. a high-confidence
    // patient resolution) produced by a tool during this turn; applied when the
    // turn is persisted so the next turn resolves the same entity.
    const contextRecorder = new ConversationContextRecorder();
    // Post-plan completion: a conversation opened from a contextual launcher
    // arrives empty with a page context. Seeding here — before the agent runs,
    // and through the recorder so a tool resolution later in the same turn still
    // wins — is what makes the launcher's first question about the record the
    // user was looking at, and what persists that binding for the next turn.
    // Every slot is re-read server-side through the caller's RLS client.
    if (conversation.messages.length === 0 && authorizedPageContext) {
      for (const proposal of await resolvePageContextSeed({
        supabase,
        user,
        context: authorizedPageContext,
        locale,
      })) {
        contextRecorder.propose(
          proposal.entityType,
          proposal.entityId,
          proposal.displayLabel,
          proposal.setBy,
        );
      }
    }
    const activeContext = applyProposals(
      conversation.activeContext,
      contextRecorder.takeAll(),
    );
    const agent = await createStaffAgent({
      user,
      locale,
      clinicName: clinic.name,
      pageContext: authorizedPageContext,
      execution,
      conversationId: conversation.id,
      activeContext,
      contextRecorder,
      // The *unfiltered* history. `modelSafeHistory` below still strips every
      // non-text part from the messages themselves; the agent derives the
      // bounded, allow-listed tool memory from this copy, gated on the tool
      // mount it resolves for this turn.
      history: uiMessages,
    });
    const result = await agent.stream({
      messages: await convertToModelMessages(modelSafeHistory(uiMessages)),
      abortSignal: request.signal,
    });
    let streamFailed = false;
    let inputLimitReached = false;

    return result.toUIMessageStreamResponse({
      originalMessages: uiMessages,
      // `onError` serves two distinct jobs in ai@6, and conflating them is what
      // review #2's H2 reported (see the transport notes in lib/ai/errors.ts):
      //
      //  - for a stream-level failure it produces the `error` chunk's text,
      //    which the client turns into `useChat`'s `error`;
      //  - for a tool whose execute() threw it produces the *`tool-output-error`
      //    part's* `errorText`, which never touches `useChat`'s `error` at all.
      //
      // Both are string-only channels, so this returns an `AssistantErrorCode`
      // and nothing else. A localized sentence here would be unclassifiable at
      // the receiving end and would land in model context untranslated; the
      // client maps the code to copy in the user's locale instead.
      onError(error) {
        streamFailed = true;
        inputLimitReached ||= error instanceof AiPolicyInputLimitError;
        Sentry.captureException(error, {
          tags: { area: "staff-assistant-stream" },
          extra: { clinicId: user.clinicId, conversationId: conversation.id },
        });
        if (error instanceof AiToolAuthorizationError) return error.reason;
        if (error instanceof AiPolicyInputLimitError) {
          return "input_limit_reached" satisfies ErrorCode;
        }
        return "temporarily_unavailable" satisfies ErrorCode;
      },
      async onFinish({ responseMessage, isAborted, finishReason }) {
        const assistantText = responseMessage.parts
          .filter((part): part is Extract<(typeof responseMessage.parts)[number], { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        // M2 (review #2): `streamFailed` is deliberately *not* part of this
        // condition.
        //
        // `onError` fires for every tool-error part, not only for a fatal
        // stream error, and a tool error is not fatal to the turn — the SDK
        // feeds it back to the model, which typically tries another tool and
        // produces a complete answer that the user watches stream to the end.
        // Treating that as a failure discarded the turn (the question and the
        // answer both vanished on the next page load) and billed the execution
        // as `failed` for a turn that visibly succeeded.
        //
        // The two signals that actually distinguish the fatal case are already
        // here: a stream that truly failed finishes with `finishReason ===
        // "error"`, and one that died before producing anything has no
        // assistant text. `streamFailed` is kept only as the Sentry-side record
        // that something was raised at all.
        const persisted = persistedAssistantState(responseMessage.parts);
        const hasPendingConfirmation = persisted.pendingConfirmations.length > 0;
        if (isAborted || finishReason === "error" || (!assistantText && !hasPendingConfirmation)) {
          await finalizeExecution(
            isAborted ? "aborted" : "failed",
            isAborted
              ? "client_aborted"
              : inputLimitReached
                ? "input_limit_reached"
                : "stream_failed",
          );
          if (inputLimitReached && !isAborted) {
            try {
              await persistDoctorTurn({
                supabase,
                user,
                conversationId: conversation.id,
                locale,
                patientId: conversation.patientId,
                userText,
                assistantText: "",
                assistantParts: [],
                contextProposals: contextRecorder.takeAll(),
              });
            } catch (error) {
              Sentry.captureException(error, {
                tags: { area: "staff-assistant-persistence" },
                extra: { clinicId: user.clinicId, conversationId: conversation.id },
              });
            }
          }
          return;
        }
        // Successful, but recorded as having recovered from something. The
        // ledger keeps the signal `streamFailed` used to carry without letting
        // it decide the outcome.
        await finalizeExecution(
          "success",
          streamFailed ? "recovered_tool_error" : undefined,
        );
        try {
          await persistDoctorTurn({
            supabase,
            user,
            conversationId: conversation.id,
            locale,
            patientId: conversation.patientId,
            userText,
            assistantText,
            assistantParts: persisted.parts,
            pendingConfirmations: persisted.pendingConfirmations,
            contextProposals: contextRecorder.takeAll(),
          });
        } catch (error) {
          Sentry.captureException(error, {
            tags: { area: "staff-assistant-persistence" },
            extra: { clinicId: user.clinicId, conversationId: conversation.id },
          });
        }
      },
      consumeSseStream: consumeStream,
    });
  } catch (error) {
    await finalizeExecution("failed", "request_failed");
    if (error instanceof AiToolAuthorizationError) return authorizationResponse(error);
    if (error instanceof AiConversationError) {
      return errorResponse(
        error.reason === "invalid_patient_context"
          ? "invalid_request"
          : "temporarily_unavailable",
        error.reason === "invalid_patient_context" ? 400 : 503,
      );
    }
    Sentry.captureException(error, { tags: { area: "staff-assistant-route" } });
    return errorResponse("temporarily_unavailable", 503);
  }
}
