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
  AiToolAuthorizationError,
  type AssistantErrorCode,
} from "@/lib/ai/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();
const requestSchema = z
  .object({
    id: z.string().uuid(),
    patientId: z.string().uuid().nullable().optional(),
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

    // P4.6A: an administrative turn runs on the cheaper, tighter operational
    // task class only when the turn actually *is* an operational query — the
    // entitlement decides whether those tools exist, the turn's intent decides
    // the budget. Entitlements are cached per clinic, so this adds no
    // per-request database round-trip.
    const entitlements = await getEntitlements(user.clinicId);
    const { task, persona } = staffTaskForRole(user.role, {
      analyticsEntitled: hasFeature(entitlements, AI_STAFF_ANALYTICS_FEATURE),
      messageText: userText,
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
        patientId: parsed.data.patientId,
      }),
    ]);
    if (clinicError || !clinic) throw new AiConversationError("conversation_unavailable");

    const currentMessage: UIMessage = {
      id: parsed.data.message.id,
      role: "user",
      parts: [{ type: "text", text: userText }],
    };
    const uiMessages = [...conversation.messages, currentMessage];
    const agent = await createStaffAgent({
      user,
      locale,
      clinicName: clinic.name,
      patientId: conversation.patientId,
      execution,
    });
    const result = await agent.stream({
      messages: await convertToModelMessages(uiMessages),
      abortSignal: request.signal,
    });
    let streamFailed = false;

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
        Sentry.captureException(error, {
          tags: { area: "staff-assistant-stream" },
          extra: { clinicId: user.clinicId, conversationId: conversation.id },
        });
        if (error instanceof AiToolAuthorizationError) return error.reason;
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
        if (isAborted || finishReason === "error" || !assistantText) {
          await finalizeExecution(
            isAborted ? "aborted" : "failed",
            isAborted ? "client_aborted" : "stream_failed",
          );
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
