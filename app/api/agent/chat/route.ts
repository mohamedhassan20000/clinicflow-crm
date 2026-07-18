import * as Sentry from "@sentry/nextjs";
import { consumeStream, convertToModelMessages, type UIMessage } from "ai";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { authorizeDoctorAssistant } from "@/lib/ai/authorization";
import {
  AiConversationError,
  ensureDoctorConversation,
  persistDoctorTurn,
} from "@/lib/ai/conversations";
import { createDoctorAgent } from "@/lib/ai/doctor-agent";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { releaseAiTurn, reserveAiTurn } from "@/lib/ai/usage";
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

type ErrorCode =
  | "unauthenticated"
  | "role_forbidden"
  | "feature_not_entitled"
  | "usage_limit_reached"
  | "subscription_inactive"
  | "lookup_failed"
  | "rate_limited"
  | "invalid_request"
  | "temporarily_unavailable";

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
  let releaseReservation: (() => Promise<void>) | null = null;
  try {
    const user = await authorizeDoctorAssistant();

    const rateLimit = await checkRateLimit("doctor-assistant", user.clinicId, {
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

    const reservation = await reserveAiTurn(user.clinicId);
    let reservationActive = true;
    releaseReservation = async () => {
      if (!reservationActive) return;
      reservationActive = false;
      await releaseAiTurn(user.clinicId, reservation.periodStart);
    };

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
    const agent = createDoctorAgent({
      user,
      locale,
      clinicName: clinic.name,
      patientId: conversation.patientId,
    });
    const result = await agent.stream({
      messages: await convertToModelMessages(uiMessages),
      abortSignal: request.signal,
    });
    let streamFailed = false;

    return result.toUIMessageStreamResponse({
      originalMessages: uiMessages,
      onError(error) {
        streamFailed = true;
        Sentry.captureException(error, {
          tags: { area: "doctor-assistant-stream" },
          extra: { clinicId: user.clinicId, conversationId: conversation.id },
        });
        return locale === "ar"
          ? "تعذر إكمال الرد. حاول مرة أخرى."
          : "The response could not be completed. Please try again.";
      },
      async onFinish({ responseMessage, isAborted, finishReason }) {
        const assistantText = responseMessage.parts
          .filter((part): part is Extract<(typeof responseMessage.parts)[number], { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (isAborted || streamFailed || finishReason === "error" || !assistantText) {
          await releaseReservation?.();
          return;
        }
        reservationActive = false;
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
            tags: { area: "doctor-assistant-persistence" },
            extra: { clinicId: user.clinicId, conversationId: conversation.id },
          });
        }
      },
      consumeSseStream: consumeStream,
    });
  } catch (error) {
    await releaseReservation?.();
    if (error instanceof AiToolAuthorizationError) return authorizationResponse(error);
    if (error instanceof AiConversationError) {
      return errorResponse(
        error.reason === "invalid_patient_context"
          ? "invalid_request"
          : "temporarily_unavailable",
        error.reason === "invalid_patient_context" ? 400 : 503,
      );
    }
    Sentry.captureException(error, { tags: { area: "doctor-assistant-route" } });
    return errorResponse("temporarily_unavailable", 503);
  }
}
