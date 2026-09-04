/**
 * Canonical value serialization shared by the confirm-token digest and by the
 * preview-diff comparison.
 *
 * Phase 5f F2: the privileged before→after diff must decide "did this field
 * actually change?" with the *same* normalisation the confirm token is bound
 * to. Comparing raw references classified two structurally identical arrays
 * (e.g. `supervising_doctor_ids`) as a change and rendered a phantom row in the
 * security attestation the admin re-authenticates against.
 *
 * This module deliberately carries no `server-only` marker: `lib/ai/actions/
 * types.ts` is reachable from client bundles through type-only imports, and the
 * preview contract check must be able to use the identical canonicaliser.
 */

export const ACTION_INPUT_MAX_BYTES = 16_000;
const MAX_CANONICAL_DEPTH = 16;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class ActionConfirmationError extends Error {
  constructor(
    public readonly reason:
      | "configuration"
      | "invalid_input"
      | "invalid"
      | "expired"
      | "replayed",
  ) {
    super(`AI action confirmation failed: ${reason}`);
    this.name = "ActionConfirmationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new ActionConfirmationError("invalid_input");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new ActionConfirmationError("invalid_input");
    return value.map((item) => stableValue(item, depth + 1));
  }
  if (!isPlainObject(value)) throw new ActionConfirmationError("invalid_input");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => {
        if (BLOCKED_KEYS.has(key)) {
          throw new ActionConfirmationError("invalid_input");
        }
        return [key, stableValue(nested, depth + 1)];
      }),
  );
}

export function canonicalActionInput(value: unknown): string {
  const canonical = JSON.stringify(stableValue(value));
  if (byteLength(canonical) > ACTION_INPUT_MAX_BYTES) {
    throw new ActionConfirmationError("invalid_input");
  }
  return canonical;
}

/**
 * Structural equality under the canonical form. Values the canonicaliser
 * refuses (undefined, class instances, cycles) fall back to reference equality
 * so an uncomparable field is still reported as changed rather than silently
 * dropped from a security diff.
 */
export function sameCanonicalValue(a: unknown, b: unknown): boolean {
  try {
    return canonicalActionInput(a) === canonicalActionInput(b);
  } catch {
    return a === b;
  }
}

function byteLength(value: string): number {
  return typeof Buffer === "undefined"
    ? new TextEncoder().encode(value).length
    : Buffer.byteLength(value, "utf8");
}
