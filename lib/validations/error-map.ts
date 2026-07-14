import type { Locale } from "@/lib/i18n/config";
import { z } from "zod";

/**
 * The shape zod hands an error map. Deliberately structural rather than zod's `$ZodIssue`: the map
 * is called with the *raw* issue (whose `path` is still optional), and `input` — the field that
 * separates "missing" from "wrong type" — exists only there, not on the parsed result's issues.
 */
type RawIssue = {
  readonly code?: string;
  readonly input?: unknown;
  readonly format?: string;
  readonly [key: string]: unknown;
};

/**
 * P2A — the shared zod error map and its message keys (§4.1).
 *
 * Validation failures become **keys**, not English sentences, so the same schema can render its
 * errors in either locale. This is the infrastructure only: existing schemas keep their bespoke
 * messages until P2C extracts them, and any schema that supplies its own `message` still wins here
 * (the map is consulted only when a message is absent).
 */
export type ValidationMessageKey =
  | "required"
  | "invalidType"
  | "tooSmall"
  | "tooBig"
  | "invalidFormat"
  | "invalidEmail"
  | "unrecognizedKeys";

/** Maps a zod issue to a `validation.*` message key. Pure — no i18n runtime needed to test it. */
export function validationKeyForIssue(issue: RawIssue): ValidationMessageKey {
  switch (issue.code) {
    case "invalid_type":
      // zod reports a missing field as an `undefined` input to the expected type.
      return issue.input === undefined ? "required" : "invalidType";
    case "too_small":
      return "tooSmall";
    case "too_big":
      return "tooBig";
    case "invalid_format":
      return issue.format === "email" ? "invalidEmail" : "invalidFormat";
    case "unrecognized_keys":
      return "unrecognizedKeys";
    default:
      return "invalidType";
  }
}

type Translator = (key: string) => string;

/**
 * Translates a flattened zod `fieldErrors` object through the active locale.
 *
 * Values that are already keys (`validation.*`) are translated; anything else is a literal message
 * from a schema that has not been migrated yet and is passed through untouched. That is what lets
 * P2A land the mechanism without touching a single existing schema's copy.
 */
export function translateFieldErrors<T extends Record<string, string[] | undefined>>(
  fieldErrors: T,
  t: Translator,
): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (!messages) continue;
    output[field] = messages.map((message) =>
      message.startsWith("validation.") ? t(message.slice("validation.".length)) : message,
    );
  }
  return output;
}

/**
 * The shared error map, as a `z.config({ customError })` value.
 *
 * Deliberately **not** registered globally yet. Every form in the app currently renders zod's
 * message text straight through, so installing this map today would print `validation.required` in
 * the UI of every schema that has not been migrated — which would both regress English and break
 * P2A's "renders byte-identically in `en`" acceptance test. It is registered in the same change that
 * migrates the schemas and their consumers to keys (P2C string extraction); until then callers can
 * opt in per-schema. See docs/reviews/P2A_REVIEW.md.
 */
export function clinicFlowErrorMap(issue: RawIssue): string {
  return `validation.${validationKeyForIssue(issue)}`;
}

// P2C: every schema now emits catalog keys. Register once for constraints without an explicit key.
z.config({ customError: clinicFlowErrorMap });

/** Locales this map can render into today — kept in lockstep with `messages/*.json`. */
export const SUPPORTED_VALIDATION_LOCALES: readonly Locale[] = ["en", "ar"];
