/**
 * The command contract — everything the language model is allowed to say.
 *
 * ## Why this file is the centre of the rebuild
 *
 * In the engine this replaces, the model's output *was* the action: it chose a
 * tool, the tool ran, and the tool wrote to the database. A misunderstanding
 * and a mutation were therefore the same event, which is why an unrecognised
 * Arabic phrase could book an appointment.
 *
 * Here the model produces **data**. A command is a proposal about what the
 * patient meant, in a closed vocabulary, validated against a schema before
 * anything looks at it. It carries no tool name, no table, no id the server did
 * not issue, and no authority. The deterministic flow engine decides what — if
 * anything — a command is permitted to do (I-4).
 *
 * ## The three rules that keep it a contract rather than a suggestion
 *
 *   1. **Closed.** `CommandSchema` is a discriminated union with no escape
 *      hatch. A `kind` the model invents fails validation.
 *   2. **Referential, not creative.** Anything that names a business entity
 *      names it by an id the *server* put in front of the patient this turn or
 *      last (`offerId`, `optionId`). The model never supplies a doctor id, a
 *      department id or a patient id, so it cannot select a record by
 *      hallucinating a key.
 *   3. **Fail-closed.** {@link parseCommands} turns anything it cannot validate
 *      into `ask_clarification`. There is no path from malformed model output
 *      to a business action (I-3).
 *
 * ## Why the vocabulary looks like Rasa CALM's
 *
 * Because it is a solved problem and novelty here has no value. The set below
 * is CALM's, with three additions this domain needs and CALM has no equivalent
 * for: `affirm_offer` and `reject_offer`, which are the boundary between a
 * server-created *candidate* and a committed slot value (I-5), and the negative
 * constraint that `reject_offer` records — "not that doctor" — which the old
 * engine had nowhere to store at all.
 */

import { z } from "zod";

/** Slots are named by the flow that owns them; the model never invents one. */
export const SLOT_NAMES = [
  "department",
  "doctor",
  "day",
  "time",
  "beneficiary",
  "beneficiary_name",
  "date_lower_bound",
  "part_of_day",
  "full_name",
  "full_name_latin",
  "national_id",
  "date_of_birth",
  "email",
  "gender",
  "phone",
  "blood_type",
  "service",
  "package",
  "document",
  "appointment",
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** The flows a command may name. Closed for the same reason slots are. */
export const FLOW_NAMES = [
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "register_patient",
  "answer_question",
  "retrieve_document",
  "package_inquiry",
  "patient_relationship_lookup",
] as const;
export type FlowName = (typeof FLOW_NAMES)[number];

/**
 * The read-only subjects `answer_question` can be about.
 *
 * A topic is not a tool. The flow decides which read serves a topic, so a new
 * data source is a change in one flow definition rather than in the contract
 * the model is prompted against.
 */
export const QUESTION_TOPICS = [
  "departments",
  "doctors",
  "services",
  "prices",
  "packages",
  "address",
  "phone",
  "website",
  "email",
  "opening_hours",
  "insurance",
  "clinic_other",
  "my_appointments",
  "my_packages",
  "my_documents",
  "privacy",
] as const;
export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

/**
 * Why the turn could not be resolved. Labels only — they reach the audit log,
 * and a free-text reason from a model is neither auditable nor safe.
 */
export const CLARIFICATION_REASONS = [
  "unspecified_request",
  "ambiguous_intent",
  "ambiguous_value",
  "missing_reference",
  "conflicting_information",
  "out_of_scope",
] as const;

export const SMALL_TALK_KINDS = [
  "greeting",
  "thanks",
  "acknowledgement",
  "farewell",
  "chitchat",
] as const;

export const HANDOFF_REASONS = [
  "patient_requested_human",
  "clinical_question",
  "complaint",
  "payment_dispute",
  "unsupported_request",
] as const;

/**
 * A value the patient supplied **in words**, as the model read them.
 *
 * Deliberately a string and never an id. The engine resolves it against the
 * clinic's own directory and against what was actually offered; if it resolves
 * to nothing, or to more than one thing, the turn becomes a clarification.
 * That resolution is the server's job and the model is not trusted with it,
 * which is what stops "Dr Ahmed" from silently selecting one of two Ahmeds.
 */
const spokenValue = z.string().trim().min(1).max(120);

/**
 * A server-issued handle. The only way a command may name a specific record.
 *
 * Offers and options are minted by the engine when it puts something in front
 * of the patient, and they are short-lived and single-conversation. A model
 * that invents one names nothing, and the engine answers with a clarification.
 */
const serverRef = z
  .string()
  .trim()
  .regex(/^[a-z]{3,12}_[0-9a-f]{8}$/, "not a server-issued reference");

export const CommandSchema = z.discriminatedUnion("kind", [
  /** Begin a flow. The only way any business flow may start (I-1, I-2). */
  z.object({
    kind: z.literal("start_flow"),
    flow: z.enum(FLOW_NAMES),
  }),
  /**
   * Fill a slot from what the patient just said.
   *
   * `value` is words. The engine resolves and validates it; a value it cannot
   * ground is not written.
   */
  z.object({
    kind: z.literal("set_slot"),
    slot: z.enum(SLOT_NAMES),
    value: spokenValue,
  }),
  /**
   * Overwrite a slot the patient has changed their mind about.
   *
   * Separate from `set_slot` because the engine's response differs: a
   * correction invalidates every slot and offer downstream of the one it
   * touches, which is what makes «لا قصدي بعد يوم ٩» drop the day, the time and
   * the slot list together rather than leaving a half-stale draft.
   */
  z.object({
    kind: z.literal("correct_slot"),
    slot: z.enum(SLOT_NAMES),
    value: spokenValue,
  }),
  /**
   * Accept something the server offered. The candidate/value boundary (I-5).
   *
   * This is how a prior doctor, a prior department or an owned package becomes
   * a committed slot — and the only how. Durable memory reaches a flow as an
   * offer; nothing but the patient's acceptance turns it into a decision.
   */
  z.object({
    kind: z.literal("affirm_offer"),
    offerId: serverRef,
  }),
  /**
   * Decline it, and record the constraint that implies.
   *
   * «لا دكتور تاني» is not merely "no". It says *not this one*, which the flow
   * must respect for the rest of its life. The old engine had no field for
   * that, so the same doctor kept coming back.
   */
  z.object({
    kind: z.literal("reject_offer"),
    offerId: serverRef,
  }),
  /** A read-only question. Never touches the flow stack by itself. */
  z.object({
    kind: z.literal("answer_question"),
    topic: z.enum(QUESTION_TOPICS),
    /** Optional narrowing, in the patient's words — "packages in dermatology". */
    scope: spokenValue.optional(),
  }),
  /**
   * Park the running flow to deal with something else.
   *
   * Emitted alongside the thing to deal with, so «طب بكام الكشف؟» mid-booking
   * is `[suspend_flow, answer_question(prices)]` — one turn, two commands, and
   * the booking's slots survive untouched.
   */
  z.object({ kind: z.literal("suspend_flow") }),
  /** Explicitly pick a suspended or parked flow back up (I-2). */
  z.object({
    kind: z.literal("resume_flow"),
    flow: z.enum(FLOW_NAMES),
  }),
  /** Abandon a flow. The engine releases its slots and any staged draft. */
  z.object({
    kind: z.literal("cancel_flow"),
    flow: z.enum(FLOW_NAMES).optional(),
  }),
  /**
   * The default, and the reason the whole contract is safe (I-3).
   *
   * Emitted when the turn is vague, when it is ambiguous, and — by
   * {@link parseCommands} rather than by the model — whenever anything at all
   * failed to validate. «عندي استفسار» is this command and nothing else.
   */
  z.object({
    kind: z.literal("ask_clarification"),
    reason: z.enum(CLARIFICATION_REASONS),
  }),
  /** Greetings, thanks, acknowledgement. No state moves. */
  z.object({
    kind: z.literal("small_talk"),
    talk: z.enum(SMALL_TALK_KINDS),
  }),
  /** Hand the thread to a person. */
  z.object({
    kind: z.literal("request_handoff"),
    reason: z.enum(HANDOFF_REASONS),
  }),
  /** The patient is finished. The engine decides what that means for the stack. */
  z.object({ kind: z.literal("end_conversation") }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandKind = Command["kind"];

/** The full vocabulary, for prompts, audit label sets and exhaustiveness tests. */
export const COMMAND_KINDS = [
  "start_flow",
  "set_slot",
  "correct_slot",
  "affirm_offer",
  "reject_offer",
  "answer_question",
  "suspend_flow",
  "resume_flow",
  "cancel_flow",
  "ask_clarification",
  "small_talk",
  "request_handoff",
  "end_conversation",
] as const satisfies readonly CommandKind[];

/**
 * How many commands one turn may carry.
 *
 * Several is normal — «عايز احجز لجهاد» is a `start_flow` and two `set_slot`s —
 * but a turn producing a dozen is a model that has lost the thread, and
 * truncating is safer than executing the tail of it.
 */
export const MAX_COMMANDS_PER_TURN = 6;

/** The safe answer to anything that could not be understood. */
export function clarification(
  reason: (typeof CLARIFICATION_REASONS)[number] = "unspecified_request",
): Command {
  return { kind: "ask_clarification", reason };
}

export type CommandParse = {
  commands: readonly Command[];
  /**
   * How the parse went, for the audit line. `ok` is a clean validation;
   * `partial` means some commands validated and some were dropped;
   * `rejected` means nothing validated and the clarification below is ours,
   * not the model's.
   */
  outcome: "ok" | "partial" | "rejected";
  /** How many entries failed validation. A number, never their content. */
  dropped: number;
};

/**
 * Validates raw model output into commands, or into a clarification.
 *
 * Every failure mode — not JSON, not an array, an unknown `kind`, a slot that
 * does not exist, an offer reference the model made up, an empty list — lands
 * on the same safe answer. That is the property the whole architecture rests
 * on: **there is no malformed output that reaches a business action** (I-3).
 *
 * Accepts either a bare array or `{ commands: [...] }`, because both are
 * shapes models reliably produce and rejecting one of them buys nothing.
 */
export function parseCommands(raw: unknown): CommandParse {
  const input = typeof raw === "string" ? safeJson(raw) : raw;
  const list = Array.isArray(input)
    ? input
    : Array.isArray((input as { commands?: unknown } | null)?.commands)
      ? (input as { commands: unknown[] }).commands
      : null;
  if (!list) {
    return { commands: [clarification()], outcome: "rejected", dropped: 0 };
  }

  const commands: Command[] = [];
  let dropped = 0;
  for (const entry of list.slice(0, MAX_COMMANDS_PER_TURN)) {
    const parsed = CommandSchema.safeParse(entry);
    if (parsed.success) commands.push(parsed.data);
    else dropped += 1;
  }
  dropped += Math.max(0, list.length - MAX_COMMANDS_PER_TURN);

  if (commands.length === 0) {
    return { commands: [clarification()], outcome: "rejected", dropped };
  }
  return {
    commands,
    outcome: dropped > 0 ? "partial" : "ok",
    dropped,
  };
}

/**
 * Pulls JSON out of model output, tolerating the wrappers models add.
 *
 * A fenced block or a sentence before the array is a formatting habit, not a
 * different intent, and failing the turn over one would send a patient to a
 * human for no reason. Anything genuinely unparseable still returns null, and
 * the caller's answer to null is a clarification.
 */
function safeJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const bracketed = /(\[[\s\S]*\]|\{[\s\S]*\})/.exec(trimmed);
  if (bracketed?.[1]) candidates.push(bracketed[1]);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next shape. Exhausting them all is a clarification, not a throw.
    }
  }
  return null;
}
