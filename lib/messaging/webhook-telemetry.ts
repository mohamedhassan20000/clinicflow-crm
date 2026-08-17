import "server-only";

export type WhatsAppWebhookProvider = "dialog360" | "meta" | "linked_device";
export type WebhookRejectionKind = "signature" | "rate_limit";

export type WebhookRouteTelemetry = {
  signatureFailures: number | null;
  rateLimitRejections: number | null;
  windowHours: 24;
};

const WINDOW_HOURS = 24;
const KEY_TTL_SECONDS = 26 * 60 * 60;

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function hourBucket(date: Date): string {
  return date.toISOString().slice(0, 13).replaceAll("-", "").replace("T", "");
}

function bucketKey(
  provider: WhatsAppWebhookProvider,
  kind: WebhookRejectionKind,
  date: Date,
): string {
  return `p6d:webhook-route:${provider}:${kind}:${hourBucket(date)}`;
}

function recentKeys(
  provider: WhatsAppWebhookProvider,
  kind: WebhookRejectionKind,
  now: Date,
): string[] {
  return Array.from({ length: WINDOW_HOURS }, (_, offset) =>
    bucketKey(provider, kind, new Date(now.valueOf() - offset * 60 * 60 * 1000)),
  );
}

async function redisCommand<T>(
  command: unknown[],
): Promise<{ ok: true; result: T } | { ok: false }> {
  const config = redisConfig();
  if (!config) return { ok: false };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { ok: false };
    const payload = (await response.json()) as { result?: T };
    return payload.result === undefined
      ? { ok: false }
      : { ok: true, result: payload.result };
  } catch {
    return { ok: false };
  }
}

/**
 * Best-effort route telemetry. Rejections happen before a request can be trusted
 * and tenant-routed, so counts are intentionally provider-route aggregates, not
 * attributed to the clinic id claimed by an untrusted payload.
 */
export async function recordWebhookRouteRejection(
  provider: WhatsAppWebhookProvider,
  kind: WebhookRejectionKind,
): Promise<void> {
  const key = bucketKey(provider, kind, new Date());
  await redisCommand([
    "EVAL",
    "local n=redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],ARGV[1]); return n",
    1,
    key,
    KEY_TTL_SECONDS,
  ]);
}

async function readCount(
  provider: WhatsAppWebhookProvider,
  kind: WebhookRejectionKind,
  now: Date,
): Promise<number | null> {
  const result = await redisCommand<Array<string | number | null>>([
    "MGET",
    ...recentKeys(provider, kind, now),
  ]);
  if (!result.ok) return null;
  let total = 0;
  for (const value of result.result) {
    const parsed = Number(value ?? 0);
    total += Number.isFinite(parsed) ? parsed : 0;
  }
  return total;
}

export async function getWebhookRouteTelemetry(
  provider: WhatsAppWebhookProvider,
  now = new Date(),
): Promise<WebhookRouteTelemetry> {
  const [signatureFailures, rateLimitRejections] = await Promise.all([
    readCount(provider, "signature", now),
    readCount(provider, "rate_limit", now),
  ]);
  return {
    signatureFailures,
    rateLimitRejections,
    windowHours: WINDOW_HOURS,
  };
}
