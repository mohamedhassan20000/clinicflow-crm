import "server-only";

export type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
  failureMode: "closed" | "open";
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  backendAvailable: boolean;
};

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, oldest[2] or now}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(window / 1000))
return {1, count + 1, now}
`;

export async function checkRateLimit(
  namespace: string,
  identifier: string,
  policy: RateLimitPolicy,
): Promise<RateLimitResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return {
      allowed: policy.failureMode === "open",
      retryAfterSeconds: 30,
      backendAvailable: false,
    };
  }

  const now = Date.now();
  const windowMs = policy.windowSeconds * 1000;
  const key = `rate-limit:${namespace}:${identifier}`;
  const member = `${now}:${crypto.randomUUID()}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["EVAL", SLIDING_WINDOW_SCRIPT, 1, key, now, windowMs, policy.limit, member]),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`Rate-limit backend returned ${response.status}`);
    const payload = (await response.json()) as { result?: [number, number, number] };
    const [allowed = 0, , oldest = now] = payload.result ?? [];
    return {
      allowed: allowed === 1,
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      backendAvailable: true,
    };
  } catch (error) {
    console.error("rate_limit_backend_unavailable", {
      namespace,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return {
      allowed: policy.failureMode === "open",
      retryAfterSeconds: 30,
      backendAvailable: false,
    };
  }
}
