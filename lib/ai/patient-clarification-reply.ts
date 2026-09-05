/**
 * F-2 — the server-owned clarification.
 *
 * ## The defect
 *
 * The roster offered Ahmed Nabil, Ahmed Mostafa and Sara Ali. The patient
 * replied *"عايز احجز مع دكتور احم"*. `resolveNamedEntity` returned exactly the
 * right thing — `ambiguous [Ahmed Mostafa 0.88, Ahmed Nabil 0.88]` — and the
 * patient received *"أهلًا بيك في العيادة. تحب أساعدك في إيه النهاردة؟"*. No
 * clarification, no candidates, no forward progress.
 *
 * Three server-side mechanisms compounded. The pre-commit discarded the
 * `ambiguous` verdict; the authority reported the doctor step already satisfied
 * by a committed roster, so nothing was pinned; and the instruction for that
 * satisfied case told the model, in both languages, *not to call the booking
 * tool again*. Whether the patient got asked came down to the deployed model's
 * judgement, against a prompt pointing the other way. The first two are fixed
 * where they live (`offered-selection.ts`, `booking-authority.ts`). This module
 * is the third: it removes the model from the decision entirely.
 *
 * ## Why the whole reply is replaced
 *
 * The same reason `enforcePatientFactReply` owns a list once the tool has
 * returned. The server has *already decided* the answer was ambiguous; a reply
 * that says anything else on that turn — a guess, a greeting, or the write
 * gate's correction copy — is a reply that contradicts a decision the server
 * made. Replacing it is not a fallback for a bad model, it is the same
 * deterministic-presentation rule applied to a question instead of a list.
 *
 * The candidates come from `BookingAuthority.clarificationCandidates`, which
 * `resolveOfferedDoctor` filled from the offered roster and which is closed
 * over it by construction: this can never name somebody the conversation has
 * not already seen.
 */

import type { BookingAuthority } from "@/lib/ai/booking-authority";
import { buildDeterministicDoctorChoiceReply } from "@/lib/ai/patient-grounding";

export type ClarificationReplyEnforcement = {
  text: string;
  outcome: "passthrough" | "clarified";
  /** How many readings the patient is being asked to choose between. */
  candidateCount: number;
};

export function enforcePatientClarificationReply(input: {
  locale: "ar" | "en";
  text: string;
  authority: BookingAuthority | null;
}): ClarificationReplyEnforcement {
  const authority = input.authority;
  if (!authority || authority.reason !== "needs_clarification") {
    return { text: input.text, outcome: "passthrough", candidateCount: 0 };
  }
  const candidates = authority.clarificationCandidates ?? [];
  // Fewer than two readings is not an ambiguity, and asking about one of them
  // would be a question with a single answer.
  if (candidates.length < 2) {
    return { text: input.text, outcome: "passthrough", candidateCount: 0 };
  }
  return {
    text: buildDeterministicDoctorChoiceReply({
      locale: input.locale,
      doctors: candidates.map((item) => item.name),
    }),
    outcome: "clarified",
    candidateCount: candidates.length,
  };
}
