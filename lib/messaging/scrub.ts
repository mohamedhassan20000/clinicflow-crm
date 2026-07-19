/**
 * Sentry/log scrubbing for messaging and AI-provider credentials (§9.2/P4.5B).
 *
 * Deliberately NOT server-only: sentry.server.config.ts imports this at
 * instrumentation time. It is pure and holds no secrets of its own.
 */

/** Object keys whose values are credential material wherever they appear. */
const SENSITIVE_KEY_PATTERN =
  /(credential|secret|token|api[_-]?key|password|passwd|authorization|auth[_-]?header|appsid|app[_-]?sid|signature)/i;

/** String shapes that are secrets regardless of the key they sit under. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /whsec_[A-Za-z0-9+/=_-]+/g, // Svix/Resend webhook secrets
  /re_[A-Za-z0-9_-]{10,}/g, // Resend API keys
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9_-]{20,}/g, // Other provider-style API keys
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\\x[0-9a-fA-F]{40,}/g, // bytea credential envelopes
];

const FILTERED = "[Filtered]";
const MAX_DEPTH = 12;

export function scrubSensitiveString(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, FILTERED);
  }
  return result;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubSensitiveString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (seen.has(value)) return FILTERED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? FILTERED
      : scrubValue(entry, depth + 1, seen);
  }
  return result;
}

/**
 * Deep-scrubs credential material from any JSON-ish payload. Used as the
 * Sentry beforeSend hook and by sanitizeProviderError. Returns a new value;
 * the input is not mutated.
 */
export function scrubMessagingSecrets<T>(value: T): T {
  return scrubValue(value, 0, new WeakSet()) as T;
}

/**
 * Converts an unknown thrown value into a short, scrubbed message safe to
 * persist in outbound_messages.error and to report to Sentry.
 */
export function sanitizeProviderError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown provider error";
  return scrubSensitiveString(message).slice(0, 500);
}
