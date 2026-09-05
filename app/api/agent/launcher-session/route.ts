import * as Sentry from "@sentry/nextjs";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { authorizeStaffAssistant } from "@/lib/ai/authorization";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { resolveAssistantLauncherSession } from "@/lib/ai/launchers";
import { parseAssistantPageContext } from "@/lib/ai/page-context";
import { checkRateLimit } from "@/lib/rate-limit";

const requestSchema = z.object({ context: z.unknown() }).strict();
const MAX_LAUNCHER_SESSION_BODY_BYTES = 2_048;

type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; tooLarge: boolean };

async function readLimitedJson(request: Request): Promise<LimitedJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isFinite(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > MAX_LAUNCHER_SESSION_BODY_BYTES
    ) {
      return { ok: false, tooLarge: true };
    }
  }

  if (!request.body) return { ok: false, tooLarge: false };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_LAUNCHER_SESSION_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

function errorResponse(error: string, status: number) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
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

/**
 * Authenticated, read-only hydration boundary for contextual launchers. It is
 * intentionally separate from the streaming route: opening a Sheet never
 * reserves or bills an AI turn, while sending a message still passes through
 * the chat route's independent authorization, rate-limit, budget, and tool
 * checks.
 */
export async function POST(request: Request) {
  try {
    const user = await authorizeStaffAssistant();

    const rateLimit = await checkRateLimit(
      "assistant-launcher-session",
      `${user.clinicId}:${user.id}`,
      { limit: 30, windowSeconds: 60, failureMode: "open" },
    );
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }

    const body = await readLimitedJson(request);
    if (!body.ok) {
      return errorResponse(
        body.tooLarge ? "request_too_large" : "invalid_request",
        body.tooLarge ? 413 : 400,
      );
    }
    const parsed = requestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse("invalid_request", 400);

    const context = parseAssistantPageContext(parsed.data.context);
    if (!context) {
      return errorResponse("invalid_request", 400);
    }

    const locale = (await getLocale()) === "ar" ? "ar" : "en";
    const resolution = await resolveAssistantLauncherSession({
      user,
      context,
      locale,
    });
    if (!resolution) return errorResponse("temporarily_unavailable", 503);

    // A contextual launcher always opens a *new* conversation seeded with the
    // server-derived context of the record on screen. Past conversations stay
    // reachable from the same shared history the /assistant page uses, so the
    // shortcut neither hijacks an unrelated chat nor needs its own persistence.
    return Response.json(
      {
        initialConversationId: crypto.randomUUID(),
        initialMessages: [],
        initialActiveContext: resolution.seededActiveContext,
        historyTruncated: false,
        remaining: resolution.access.remaining,
        capabilities: resolution.capabilities,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AiToolAuthorizationError) {
      return authorizationResponse(error);
    }
    Sentry.captureException(error, {
      tags: { area: "assistant-launcher-session-route" },
    });
    return errorResponse("temporarily_unavailable", 503);
  }
}
