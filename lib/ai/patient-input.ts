import "server-only";

import {
  clarificationGuidance,
  resolveField,
  type CollectedData,
  type FieldResolution,
  type SlotField,
} from "@/lib/ai/collected-state";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";
import { setConversationAiState } from "@/lib/supabase/admin";

/**
 * P8B §1 — the one place a patient tool turns words into a value.
 *
 * `collected-state.ts` decides what an answer *means* and is pure, so it can be
 * exercised as conversations rather than as strings. This module is the durable
 * half: it reads the state the conversation already carries, hands it to the
 * resolver, writes back whatever the turn established, and returns something a
 * tool can put in front of the model.
 *
 * Why every tool goes through here rather than calling the parser directly:
 *
 *   * **The refusal has to be free.** A value that cannot be read is refused
 *     *before* any rate-limited identity RPC is called, so our own inability to
 *     parse a date can never consume a verification attempt or lock a patient
 *     out. That property is the reason the resolution step is separate from the
 *     check step at all, and it is easy to lose if each tool parses its own way.
 *
 *   * **The memory has to be shared.** A date of birth settled while
 *     registering is the same value `verify_patient_identity` would otherwise
 *     ask for again. One store, written once.
 *
 *   * **What is stored has to stay inert.** Only normalized values of known
 *     fields are ever written (the RPC and `parseCollectedData` both enforce
 *     it), so nothing in this path can put a patient id, a clinic id or a
 *     verification flag into a place a later authorization decision reads.
 */

export type PatientInputOutcome =
  | { ok: true; value: string | number; fromMemory: boolean }
  | {
      ok: false;
      /** What the tool should report back, verbatim, as its refusal reason. */
      reason:
        | "ambiguous"
        | "incomplete"
        | "conflicting"
        | "unreadable";
      guidance: string;
      /** Present for an ambiguous date: the months to name, in words. */
      candidateMonths?: number[];
    };

/**
 * Resolves one field for one conversation and persists the result.
 *
 * The write is deliberately not awaited into the failure path: if persisting
 * the state fails, the *value* is still correct for this turn, and the worst
 * consequence is that the assistant asks again later — which is the behaviour
 * that existed before this module. Losing a correct answer because a bookkeeping
 * write failed would be strictly worse.
 */
export async function resolvePatientInput(
  identity: ResolvedPatientAiContext,
  field: SlotField,
  raw: string,
  options: { now?: Date } = {},
): Promise<PatientInputOutcome> {
  const resolution = resolveField({
    field,
    raw,
    collected: identity.collectedData,
    pending: identity.pendingClarification,
    country: identity.clinicCountry,
    timeZone: identity.clinicTimezone,
    now: options.now,
    // P10: the days this conversation was actually offered, so "يوم 28" —
    // answering a list the server printed one turn ago — resolves instead of
    // becoming "which day did you mean?". Only the server's own offers are
    // read, so no number can become a day nobody mentioned.
    offeredDays: identity.bookingStage.offeredDays,
  });

  await persist(identity, resolution).catch(() => undefined);
  return toOutcome(resolution);
}

/**
 * P9C — the same resolution, for somebody who is not the sender.
 *
 * The conversation's collected state is a record of the *sender*: their name,
 * their date of birth, the national id they gave for themselves. When the
 * patient is booking for a friend, reading that state would answer questions
 * about the friend with the sender's details and stage a file that belongs to
 * neither of them. Writing to it would be worse still — it would overwrite the
 * sender's own answers with a third party's.
 *
 * So a third-party field is resolved against nothing and persisted nowhere. It
 * is exactly one message's worth of words, parsed. The cost is that a friend's
 * details spread over several messages must arrive in one tool call; the model
 * has them all in its context, and re-asking a question is a far smaller failure
 * than mixing two people's records together.
 */
export function resolveThirdPartyInput(
  identity: ResolvedPatientAiContext,
  field: SlotField,
  raw: string,
  options: { now?: Date } = {},
): PatientInputOutcome {
  return toOutcome(
    resolveField({
      field,
      raw,
      collected: {},
      pending: null,
      country: identity.clinicCountry,
      timeZone: identity.clinicTimezone,
      now: options.now,
    }),
  );
}

async function persist(
  identity: ResolvedPatientAiContext,
  resolution: FieldResolution,
): Promise<void> {
  if (resolution.status === "resolved") {
    // Already on file and unchanged: nothing to write, and no reason to take a
    // row lock on every turn of a long conversation.
    if (resolution.fromMemory && identity.collectedData[resolution.field] === resolution.value) {
      if (!identity.pendingClarification) return;
    }
    await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      collected: { [resolution.field]: resolution.value } as CollectedData as Record<
        string,
        string | number
      >,
      clearPending: true,
    });
    return;
  }
  if (resolution.status === "ambiguous" || resolution.status === "incomplete") {
    await setConversationAiState({
      clinicId: identity.clinicId,
      conversationId: identity.conversationId,
      pending: resolution.pending as unknown as Record<string, unknown>,
    });
    return;
  }
  // `conflict` and `unresolved` change nothing. A contradiction in particular
  // must not overwrite what is on file — the patient has not yet said which
  // reading is right, and quietly taking the newer one is the failure mode this
  // whole module exists to prevent.
}

function toOutcome(resolution: FieldResolution): PatientInputOutcome {
  if (resolution.status === "resolved") {
    return { ok: true, value: resolution.value, fromMemory: resolution.fromMemory };
  }
  const guidance = clarificationGuidance(resolution) ?? "Ask the patient once, in ordinary words.";
  if (resolution.status === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous",
      guidance,
      candidateMonths: [
        ...new Set(resolution.candidates.map((iso) => Number(iso.slice(5, 7)))),
      ],
    };
  }
  if (resolution.status === "incomplete") {
    return { ok: false, reason: "incomplete", guidance };
  }
  if (resolution.status === "conflict") {
    return { ok: false, reason: "conflicting", guidance };
  }
  return { ok: false, reason: "unreadable", guidance };
}

/**
 * The date-shaped convenience the three date-taking tools share.
 *
 * Returns the canonical `YYYY-MM-DD`, or the refusal to hand straight back to
 * the model. Kept as a named function rather than inlined so that "no
 * verification attempt was used" is stated once, in the one place it is true.
 */
export async function resolvePatientDate(
  identity: ResolvedPatientAiContext,
  field: Extract<SlotField, "date_of_birth" | "appointment_date">,
  raw: string,
  options: { now?: Date } = {},
): Promise<
  | { ok: true; iso: string; fromMemory: boolean }
  | { ok: false; toolResult: Record<string, unknown> }
> {
  return toDateOutcome(await resolvePatientInput(identity, field, raw, options));
}

/** The third-party counterpart of `resolvePatientDate`. Reads and writes nothing. */
export function resolveThirdPartyDate(
  identity: ResolvedPatientAiContext,
  field: Extract<SlotField, "date_of_birth" | "appointment_date">,
  raw: string,
  options: { now?: Date } = {},
):
  | { ok: true; iso: string; fromMemory: boolean }
  | { ok: false; toolResult: Record<string, unknown> } {
  return toDateOutcome(resolveThirdPartyInput(identity, field, raw, options));
}

function toDateOutcome(
  outcome: PatientInputOutcome,
):
  | { ok: true; iso: string; fromMemory: boolean }
  | { ok: false; toolResult: Record<string, unknown> } {
  if (outcome.ok) {
    return { ok: true, iso: String(outcome.value), fromMemory: outcome.fromMemory };
  }
  // The reason strings the date-taking tools have always emitted. The resolver
  // itself is field-generic, but these three tools are the model's contract and
  // renaming them would be churn with no behaviour behind it.
  const reason = {
    ambiguous: "ambiguous_date",
    incomplete: "incomplete_date",
    conflicting: "conflicting_date",
    unreadable: "unrecognized",
  }[outcome.reason];

  return {
    ok: false,
    toolResult: {
      needs_clarification: true,
      reason,
      ...(outcome.candidateMonths ? { candidate_months: outcome.candidateMonths } : {}),
      guidance: `${outcome.guidance} No verification attempt was used.`,
    },
  };
}
