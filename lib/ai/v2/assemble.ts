/**
 * Builds the five-layer {@link TurnContext} — the firewall, constructed.
 *
 * ## Why L4 is a closure and not a fetch
 *
 * Every method on the durable loader is a function that runs only if a flow
 * step calls it. Nothing here reads a treating doctor, a package or a document
 * up front. That is the difference from `resolve_patient_ai_context`, which
 * returned the whole world on every turn and thereby made "a durable fact
 * influenced this decision" untraceable — any code that could reach the object
 * could use any of it.
 *
 * The loaders are also memoized per turn, so a flow that asks twice pays once
 * and two steps cannot see different answers.
 *
 * ## Why the identity level is computed here
 *
 * Because it is the one fact every precondition depends on, and it must have a
 * single derivation. `linked` and `verified` are the existing
 * `patient_link_status` / `identityVerifiedAt` distinction, unchanged: linkage
 * is enough to book on, verification is what disclosure costs.
 */

import "server-only";

import {
  authorizePatientConversation,
  type ResolvedPatientAiContext,
} from "@/lib/ai/patient-authorization";
import { getClinicAiReplyContext } from "@/lib/supabase/admin";
import type { CommunicationStyle } from "@/lib/ai/communication-style";
import type { Candidate, FlowState } from "@/lib/ai/v2/flow-state";
import type {
  DurableFactsLoader,
  HistoricalRetrieval,
  IdentityLevel,
  TurnContext,
} from "@/lib/ai/v2/context";
import * as tools from "@/lib/ai/v2/tools";

/** Runs `load` at most once per turn, whatever asks for it. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

/**
 * The one derivation of how much the server can prove about this sender.
 *
 * Linkage is the floor, not an alternative route. `identityVerifiedAt` alone
 * used to return `verified`, which meant a conversation carrying a verification
 * stamp but no live `patient_id` — a patient unlinked after verifying, a
 * half-written row, a link cleared by a staff correction — was treated as the
 * *most* trusted state there is. Nothing leaked in practice, because the
 * patient-scoped RPCs resolve the patient from the conversation's own linkage
 * and return empty for an unlinked thread. But that is the RPC's guarantee
 * standing in for this function's, and the whole point of one derivation is
 * that the levels mean what they say wherever they are read.
 *
 * So verification is a step *above* linkage and requires both: the thread must
 * select a file, and the identity behind it must have been proven. An
 * inconsistent record fails closed to the strongest thing still provable —
 * which for a thread with no patient is `anonymous`.
 */
function identityLevel(identity: ResolvedPatientAiContext): IdentityLevel {
  const linked = identity.linked === true && Boolean(identity.patientId);
  if (!linked) return "anonymous";
  return identity.identityVerifiedAt ? "verified" : "linked";
}

export async function buildTurnContext(input: {
  clinicId: string;
  conversationId: string;
  message: string;
  locale: "ar" | "en";
  style: CommunicationStyle;
  episode: readonly { role: "patient" | "assistant"; text: string; at: string }[];
  flows: FlowState;
  now: Date;
}): Promise<TurnContext> {
  const [identity, clinicRow] = await Promise.all([
    authorizePatientConversation({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      locale: input.locale,
    }),
    getClinicAiReplyContext(input.clinicId),
  ]);
  const clinic = clinicRow.data as Record<string, unknown> | null;
  const level = identityLevel(identity);

  // The context object is built first so the loaders can close over it. They
  // are never invoked here — that is the whole point of L4 being lazy.
  //
  // `durable` and `history` are attached below rather than passed in, because
  // each loader needs the finished context to call a tool with. They are
  // assigned onto *this* object rather than spread into a copy, so the object
  // the closures captured and the object the steps receive are the same one —
  // a copy would leave every loader holding a context whose `durable` was still
  // the placeholder.
  const context: Mutable<TurnContext> = {
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    turn: {
      text: input.message,
      receivedAt: input.now.toISOString(),
      locale: input.locale,
      attachments: [],
    },
    episode: { turns: input.episode },
    flows: input.flows,
    durable: PLACEHOLDER_DURABLE,
    history: PLACEHOLDER_HISTORY,
    identity: level,
    // Present only once linkage is proven, and never model-supplied.
    patientId: level === "anonymous" ? null : identity.patientId,
    clinic: {
      name: identity.clinicName,
      timeZone: identity.clinicTimezone,
      locale: identity.clinicLocale,
      country: identity.clinicCountry ?? null,
      timeFormat: clinic?.time_format === "12h" ? "12h" : "24h",
    },
    style: input.style,
    now: input.now,
  };

  const durable: DurableFactsLoader = {
    // Each of these returns `Candidate`s. There is no method that returns a
    // committed value, which is the type-level half of I-5: a caller who wants
    // one has to go through an offer and the patient's own answer.
    treatingDoctors: once(async () =>
      level === "anonymous" ? [] : tools.readTreatingDoctors(context),
    ),
    // Matched on the patient's own `department_id`. The predicate this replaces
    // never referenced the department, so it admitted every department in the
    // clinic the moment the patient had a treating doctor — which made the
    // booking step's "known first" ordering a no-op and asserted
    // `previously_seen` about places the patient had never been.
    knownDepartments: once(async () =>
      level === "anonymous"
        ? ([] as readonly Candidate<string>[])
        : tools.readKnownDepartments(context),
    ),
    // Both of these disclose the patient's own record, so both refuse below
    // `verified` here as well as at the step's precondition. Two checks, on
    // purpose: the precondition is the rule, and this is the loader refusing to
    // be the way around it.
    activePackages: once(async () =>
      level === "verified" ? tools.readPatientPackages({ context }) : [],
    ),
    issuedDocuments: once(async () =>
      level === "verified" ? tools.readPatientDocuments({ context }) : [],
    ),
    appointments: once(async () => {
      if (level === "anonymous") return [] as readonly Candidate<string>[];
      const rows = await tools.readMyAppointments(context);
      return rows.map((row) => ({
        value: String(row.appointment_id ?? row.id ?? ""),
        label: String(row.scheduled_at ?? ""),
        source: "patient_appointments" as const,
      }));
    }),
    // The canonical name ClinicFlow stores, available only once identity is
    // established — which is exactly the brief's rule for greeting somebody by
    // name.
    canonicalName: once(async () =>
      level === "verified" ? (identity.patientDisplayName ?? null) : null,
    ),
  };

  /**
   * L5. Deliberately inert.
   *
   * Prior episodes are not retrievable on this surface yet, and returning an
   * empty list is the honest implementation of that: a flow that asks gets
   * nothing rather than getting the current episode relabelled as history. When
   * a real retrieval is added it returns {@link HistoricalExcerpt}s — labelled,
   * quoted data — and never anything shaped like a transcript, because a
   * transcript is what a model replays (I-6).
   */
  const history: HistoricalRetrieval = { search: async () => [] };

  context.durable = durable;
  context.history = history;
  return context;
}

/** Writable during assembly only; every consumer sees the readonly `TurnContext`. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * What `durable` and `history` hold for the few statements before the real
 * loaders are attached.
 *
 * Empty rather than `null`, so a future edit that manages to call one during
 * assembly gets "no durable facts" — the safe answer — instead of a crash on
 * the reply path.
 */
const PLACEHOLDER_DURABLE: DurableFactsLoader = {
  treatingDoctors: async () => [],
  knownDepartments: async () => [],
  activePackages: async () => [],
  issuedDocuments: async () => [],
  appointments: async () => [],
  canonicalName: async () => null,
};
const PLACEHOLDER_HISTORY: HistoricalRetrieval = { search: async () => [] };
