import "server-only";

import { z } from "zod";

/**
 * P9C — how a booking tool names a doctor or a service.
 *
 * The production failure this replaces: every tool downstream of the roster
 * declared `doctor_id: z.string().uuid()`. The model never *has* a uuid unless
 * it just read one out of a tool result, and on a real WhatsApp turn it does not
 * — the patient answered "احمد نبيل" to a list the assistant had printed, so the
 * model called `list_available_days({ doctor_id: "احمد نبيل" })`.
 *
 * Zod refused it. That refusal happens in the AI SDK's `parseToolCall`, *before*
 * `execute`, so:
 *
 *   * the tool never ran, and none of the server-side recovery in
 *     `booking-target.ts` — the roster, the guidance, the persisted selection —
 *     could possibly have run either;
 *   * nothing was audited, which is why the stage trace for those turns records
 *     `tool_called: "none"` while the model demonstrably tried;
 *   * the model got back a raw `InvalidToolInputError` message, which is not a
 *     recoverable tool result and reads to it as a broken system. Its only
 *     remaining move was the apology with the clinic's phone number.
 *
 * A uuid was never the requirement. It was a *convenience* for the case where
 * the model happens to be echoing an id, and it made the far more common case —
 * the patient's own words — unrepresentable. So the wire type is now "a
 * reference": a uuid when the model has one, the patient's words when it does
 * not. Which of the two it is, and what it resolves to, is decided server-side
 * in `resolvePatientBookingTarget`, against the clinic's own directory.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/**
 * A doctor, as the model is able to name one.
 *
 * Deliberately not `.uuid()`. See the module note: the schema must accept every
 * value the model can legitimately produce, because a value it rejects can never
 * reach the code that knows how to recover from a wrong one.
 */
export const doctorRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe(
    "The doctor: either an id a previous tool returned, or the doctor's name exactly as the " +
      "patient said it (for example 'احمد نبيل' or 'Dr Ahmed Nabil'). Never invent an id.",
  );

/**
 * A service, same rule. A service is only ever a filter on a patient booking —
 * the duration does the real work — so an unrecognised one is dropped and
 * reported as dropped, never turned into a refusal.
 */
export const serviceRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe(
    "Optional service: an id a previous tool returned, or the service name. Unknown values are " +
      "ignored rather than refused.",
  );
