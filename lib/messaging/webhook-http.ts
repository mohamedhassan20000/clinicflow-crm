import "server-only";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

const WEBHOOK_RATE_LIMIT = {
  limit: 180,
  windowSeconds: 60,
  failureMode: "closed" as const,
};

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** Keep malformed, unknown, and invalidly signed pre-auth requests indistinguishable. */
export function unauthorizedWebhookResponse(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401, headers: NO_STORE_HEADERS },
  );
}

/** Preserve provider retry behavior without exposing internal routing details. */
export function unavailableWebhookResponse(): NextResponse {
  return NextResponse.json(
    { error: "Webhook temporarily unavailable" },
    {
      status: 503,
      headers: { ...NO_STORE_HEADERS, "Retry-After": "60" },
    },
  );
}

function requestIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function enforceWebhookRateLimit(
  request: Request,
  provider: string,
): Promise<NextResponse | null> {
  const result = await checkRateLimit(
    `webhook:${provider}`,
    requestIp(request),
    WEBHOOK_RATE_LIMIT,
  );
  if (result.allowed) return null;
  return NextResponse.json(
    { error: "Webhook temporarily unavailable" },
    {
      status: result.backendAvailable ? 429 : 503,
      headers: {
        ...NO_STORE_HEADERS,
        "Retry-After": String(result.retryAfterSeconds),
      },
    },
  );
}
