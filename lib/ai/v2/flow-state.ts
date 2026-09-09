/**
 * Conversation flow state: the thing the old engine did not have.
 *
 * ## What was missing
 *
 * The engine this replaces had no representation of **no flow is active**.
 * `nextBookingStep()` returned a booking rung for every conversation that had
 * ever existed, so "which step of the booking are we on?" always had an answer
 * even for a thread whose patient had only said hello. Every downstream
 * decision — the tool mount, the forced tool, the prompt briefing — was
 * derived from that answer. There was nowhere to say "nothing is happening",
 * so nothing ever was.
 *
 * A {@link FlowState} with an empty stack says exactly that, and it is the
 * ordinary case rather than an edge one.
 *
 * ## The four properties this file exists to guarantee
 *
 *   * **I-2** — a frame carries `lastAdvancedAt` and its flow declares a
 *     `maxIdle`. Past it the frame is `parked`, and {@link activeFrame} does not
 *     return a parked frame. Nothing resumes because a message arrived.
 *   * **I-5** — a slot value carries its {@link SlotProvenance}. A durable fact
 *     enters as a {@link Candidate} inside an {@link Offer} and can only become
 *     a slot through `spoken` or `affirmed` provenance. There is no constructor
 *     that writes a slot straight from memory.
 *   * **Corrections** — `dependsOn` in the flow definition makes invalidation a
 *     property of the data. Correcting the day drops the time and the slot
 *     offers because the definition says the time depends on the day, not
 *     because somebody remembered to write that branch.
 *   * **Negative constraints** — `rejected` on a frame records "not this one",
 *     which the old model had nowhere to put.
 *
 * Everything here is pure. No I/O, no clock beyond the one it is handed, no
 * model. `engine.ts` is the only writer (I-8); `store.ts` is the only
 * persister.
 */

import type { FlowName, QuestionTopic, SlotName } from "@/lib/ai/v2/commands";

// ---------------------------------------------------------------------------
// Slots and their provenance
// ---------------------------------------------------------------------------

/**
 * How a slot came to hold its value. The heart of I-5.
 *
 *   * `spoken` — the patient said it this turn and the server resolved it
 *     against the clinic's own data.
 *   * `affirmed` — the patient accepted something the server offered.
 *   * `derived` — the server computed it from another committed slot (the
 *     department implied by a chosen doctor, say). Never from durable memory.
 *
 * There is deliberately no `remembered` member. A value out of the patient's
 * history is a {@link Candidate}, not a slot, and the type system is where that
 * distinction is enforced rather than in a reviewer's memory.
 */
export type SlotProvenance = "spoken" | "affirmed" | "derived";

export type Slot = {
  /** The canonical value: an id for an entity, `YYYY-MM-DD`, minutes, or text. */
  readonly value: string | number;
  /** What to call it in a reply. Never used to match anything. */
  readonly label?: string;
  readonly provenance: SlotProvenance;
  readonly at: string;
};

export type Slots = Partial<Record<SlotName, Slot>>;

/** True when the slot holds a value the patient is answerable for. */
export function isCommitted(slot: Slot | undefined): slot is Slot {
  return slot !== undefined;
}

/**
 * A durable or computed fact a flow may *offer*, and may not assume.
 *
 * A prior doctor, a prior department, an owned package, a previously issued
 * document and a matching patient file all arrive as one of these. The engine
 * mints an {@link Offer} to put them in front of the patient; only
 * `affirm_offer` turns one into a {@link Slot}.
 */
export type Candidate<T> = {
  readonly value: T;
  readonly label: string;
  /**
   * Other clinic-authored names for the same thing, for *matching* only.
   *
   * A department the clinic stored as "Dermatology" and gave the Arabic display
   * name «الجلدية» must be reachable by both, in either language — but only one
   * of them may be shown, and that is `label`. Aliases never reach a message,
   * never reach an offer's options, and never become a second candidate; they
   * widen what the resolver will accept and nothing else. See
   * `NamedEntity.aliases`.
   */
  readonly aliases?: readonly string[];
  /** Where it came from, for the audit line and for the composer's wording. */
  readonly source:
    | "patient_history"
    | "clinic_directory"
    | "patient_packages"
    | "patient_documents"
    | "patient_appointments"
    | "identity_match";
};

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/**
 * Something the server put in front of the patient, waiting for an answer.
 *
 * An offer is the only referent `affirm_offer` and `reject_offer` accept, and
 * its `id` is server-minted, so a model cannot accept something that was never
 * shown. It is also what makes «اه» readable: the interpreter is told which
 * offer is open, so a bare yes has exactly one meaning and needs no lexicon of
 * affirmation words.
 */
export type Offer = {
  readonly id: string;
  /** The slot an acceptance fills. Null for offers that are not about a slot. */
  readonly slot: SlotName | null;
  readonly options: readonly OfferOption[];
  /**
   * The option a bare "yes" accepts, when the question asked one.
   *
   * Set only by a step whose copy actually poses a yes/no about a specific
   * option — "your usual doctor is Dr X; would you like them again?" — which
   * is a real and common shape: a list is shown *and* one of its members is
   * asked about. Without this, «اه» against such a message had to be refused
   * as ambiguous, which is both wrong and infuriating.
   *
   * Null on a plain list, where a yes genuinely means nothing and asking which
   * one is the correct answer. The distinction lives here rather than in the
   * engine because only the step that wrote the question knows whether it
   * posed one.
   */
  readonly primaryOptionId: string | null;
  /** Which flow owns it. An offer never outlives its frame. */
  readonly flow: FlowName;
  readonly kind: OfferKind;
  readonly at: string;
};

export type OfferOption = {
  readonly id: string;
  readonly value: string | number;
  readonly label: string;
  readonly source: Candidate<unknown>["source"];
};

/**
 * What accepting an offer *means*, which is not always "fill a slot".
 *
 * `summary` is the final booking review: accepting it is the write consent, and
 * it is a distinct kind precisely so that consent cannot be confused with
 * choosing a value. `package_use` is the same idea for session consumption —
 * accepting it is what permits a decrement, and nothing else does.
 */
export type OfferKind =
  | "slot_value"
  | "summary"
  | "package_use"
  | "identity_match"
  | "document_choice"
  | "resume_flow";

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * A frame's lifecycle. `parked` is the member the old engine lacked.
 *
 *   * `active` — on top of the stack, this turn is about it.
 *   * `suspended` — a side question pushed something above it. Its slots are
 *     intact and it resumes when the interruption finishes.
 *   * `parked` — silent past its `maxIdle`. Still readable, so the assistant
 *     can *offer* to pick it up, but it cannot act and cannot resume itself.
 *   * `completed` / `cancelled` — terminal, kept only until the turn ends.
 */
export type FrameStatus =
  | "active"
  | "suspended"
  | "parked"
  | "completed"
  | "cancelled";

export type FlowFrame = {
  readonly flow: FlowName;
  readonly status: FrameStatus;
  readonly slots: Slots;
  /**
   * Values the patient has ruled out, per slot.
   *
   * «لا دكتور تاني» writes the rejected doctor's id here, and the doctor step
   * filters against it for the rest of the frame's life. The old engine had no
   * such field, so a rejected doctor was re-offered on the next read.
   */
  readonly rejected: Partial<Record<SlotName, readonly string[]>>;
  /** The open offer, if the server is waiting on an answer. At most one. */
  readonly offer: Offer | null;
  /** The topic a `answer_question` frame is about. Null for other flows. */
  readonly topic: QuestionTopic | null;
  /**
   * Server-side bookkeeping this flow needs between turns, as opaque scalars.
   *
   * Deliberately narrow: ids the server issued and booleans it set. Never
   * patient text, never anything the model wrote, never a decision — a flow
   * that wants a decision recomputes it from slots, so two turns cannot
   * disagree about what is true.
   */
  readonly memo: Readonly<Record<string, string | number | boolean>>;
  readonly startedAt: string;
  /** The silence clock. Only a command that moved this frame updates it. */
  readonly lastAdvancedAt: string;
};

export type FlowState = {
  /**
   * Innermost last. Empty is the ordinary resting state and means exactly what
   * it says: nothing is happening, and no turn may be answered as though
   * something were.
   */
  readonly stack: readonly FlowFrame[];
  /** Schema version, so a shape change is a migration rather than a surprise. */
  readonly version: 1;
};

export const EMPTY_FLOW_STATE: FlowState = { stack: [], version: 1 };

// ---------------------------------------------------------------------------
// Reading the stack
// ---------------------------------------------------------------------------

/** How long each flow may sit untouched before it parks (I-2). */
export const FLOW_MAX_IDLE_MS: Readonly<Record<FlowName, number>> = {
  // Long enough for any real pause inside one booking on WhatsApp — a patient
  // checking a calendar, taking a call — and far shorter than the gap that let
  // an abandoned booking answer a message weeks later.
  book_appointment: 30 * 60 * 1000,
  reschedule_appointment: 30 * 60 * 1000,
  cancel_appointment: 15 * 60 * 1000,
  // Registration holds half of somebody's identity. It expires sooner, because
  // a stale half-file is worse than a repeated question.
  register_patient: 20 * 60 * 1000,
  // Read-only flows hold nothing worth resuming; they expire quickly and cost
  // nothing when they do.
  answer_question: 5 * 60 * 1000,
  package_inquiry: 10 * 60 * 1000,
  patient_relationship_lookup: 10 * 60 * 1000,
  // A document choice is a list of the patient's own records. Short-lived on
  // purpose: it should not be answerable an hour later from a stale list.
  retrieve_document: 10 * 60 * 1000,
};

/** Has this frame been silent past its flow's limit? */
export function isFrameStale(frame: FlowFrame, now: Date): boolean {
  if (frame.status === "completed" || frame.status === "cancelled") return false;
  const at = Date.parse(frame.lastAdvancedAt);
  // An unreadable timestamp is treated as stale. Unlike the legacy containment
  // — which had to tolerate records written before it existed — every frame
  // here was written by this engine, so a missing stamp is corruption and the
  // safe reading of corruption is "do not let it act".
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= FLOW_MAX_IDLE_MS[frame.flow];
}

/**
 * Applies the idle rule to the whole stack.
 *
 * Called at the top of every turn, before the interpreter is even built, so
 * that a stale frame is invisible to everything downstream: it is not in the
 * context the model sees, it cannot satisfy a tool precondition, and it cannot
 * be the "active flow" a command continues. The frame survives as `parked` so
 * the assistant can still *offer* to resume it, which is a better answer than
 * silently forgetting a booking somebody was halfway through.
 */
export function parkStaleFrames(state: FlowState, now: Date): FlowState {
  let changed = false;
  const stack = state.stack.map((frame) => {
    if (frame.status === "parked" || !isFrameStale(frame, now)) return frame;
    changed = true;
    // The offer goes with it. A slot list from half an hour ago is not a menu
    // any more, and leaving it would let a bare "اه" accept something the
    // patient can no longer see.
    return { ...frame, status: "parked" as const, offer: null };
  });
  return changed ? { ...state, stack } : state;
}

/**
 * The frame this turn may act on, or null.
 *
 * Null for an empty stack **and** for a stack whose frames are all parked —
 * which is the same answer, deliberately. A parked booking is not something
 * this turn is doing; it is something the patient may be invited to pick up.
 */
export function activeFrame(state: FlowState): FlowFrame | null {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const frame = state.stack[index]!;
    if (frame.status === "active") return frame;
  }
  return null;
}

/** The topmost suspended frame — what a finished interruption returns to. */
export function suspendedFrame(state: FlowState): FlowFrame | null {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const frame = state.stack[index]!;
    if (frame.status === "suspended") return frame;
  }
  return null;
}

/** A parked frame of this flow, if there is one to offer a resume of. */
export function parkedFrame(
  state: FlowState,
  flow?: FlowName,
): FlowFrame | null {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const frame = state.stack[index]!;
    if (frame.status !== "parked") continue;
    if (flow && frame.flow !== flow) continue;
    return frame;
  }
  return null;
}

export function findFrame(state: FlowState, flow: FlowName): FlowFrame | null {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const frame = state.stack[index]!;
    if (frame.flow === flow && frame.status !== "completed" && frame.status !== "cancelled") {
      return frame;
    }
  }
  return null;
}

/** The open offer this turn's `affirm_offer` / `reject_offer` may name. */
export function openOffer(state: FlowState, offerId: string): {
  frame: FlowFrame;
  offer: Offer;
} | null {
  for (const frame of state.stack) {
    // A parked frame's offer was withdrawn by `parkStaleFrames`, so this
    // implicitly refuses to accept an offer nobody can still see.
    if (frame.status === "parked") continue;
    if (frame.offer && frame.offer.id === offerId) {
      return { frame, offer: frame.offer };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing the stack — used only by the engine
// ---------------------------------------------------------------------------

export function newFrame(input: {
  flow: FlowName;
  at: string;
  topic?: QuestionTopic | null;
  slots?: Slots;
}): FlowFrame {
  return {
    flow: input.flow,
    status: "active",
    slots: input.slots ?? {},
    rejected: {},
    offer: null,
    topic: input.topic ?? null,
    memo: {},
    startedAt: input.at,
    lastAdvancedAt: input.at,
  };
}

/** Replaces one frame in the stack, preserving order. Pure. */
export function replaceFrame(
  state: FlowState,
  target: FlowFrame,
  next: FlowFrame,
): FlowState {
  const stack = state.stack.map((frame) => (frame === target ? next : frame));
  return { ...state, stack };
}

export function pushFrame(state: FlowState, frame: FlowFrame): FlowState {
  return { ...state, stack: [...state.stack, frame] };
}

/**
 * Drops terminal frames, and bounds the stack.
 *
 * Completed and cancelled frames exist only so the composer can say what
 * happened; nothing carries them into the next turn. The depth bound is a
 * safety valve rather than a product rule — a conversation nesting five
 * interruptions has gone wrong somewhere, and dropping the oldest is better
 * than growing a record without limit.
 */
export const MAX_STACK_DEPTH = 4;

export function compactStack(state: FlowState): FlowState {
  const live = state.stack.filter(
    (frame) => frame.status !== "completed" && frame.status !== "cancelled",
  );
  const bounded = live.length > MAX_STACK_DEPTH ? live.slice(-MAX_STACK_DEPTH) : live;
  return { ...state, stack: bounded };
}

/**
 * Commits a value to a slot, with its provenance recorded.
 *
 * The only way a slot is written. `provenance` is a required argument rather
 * than a default so that every call site has to state where the value came
 * from — which is what makes a durable fact impossible to commit by accident.
 */
export function setSlot(
  frame: FlowFrame,
  slot: SlotName,
  value: Slot,
): FlowFrame {
  return {
    ...frame,
    slots: { ...frame.slots, [slot]: value },
    lastAdvancedAt: value.at,
  };
}

/**
 * Clears a slot and everything that depended on it.
 *
 * `dependents` comes from the flow definition, so the cascade is data. This is
 * what makes «لا قصدي بعد يوم ٩» drop the day, the time and the offered slots
 * together: the definition says the time depends on the day, and the day's
 * offer belongs to the frame that just changed underneath it.
 */
export function clearSlots(
  frame: FlowFrame,
  slots: readonly SlotName[],
): FlowFrame {
  if (slots.length === 0) return frame;
  const next: Slots = { ...frame.slots };
  for (const slot of slots) delete next[slot];
  return { ...frame, slots: next, offer: null };
}

/** Records a value the patient has ruled out for a slot. */
export function rejectValue(
  frame: FlowFrame,
  slot: SlotName,
  value: string,
): FlowFrame {
  const held = frame.rejected[slot] ?? [];
  if (held.includes(value)) return frame;
  return {
    ...frame,
    rejected: { ...frame.rejected, [slot]: [...held, value] },
  };
}

export function isRejected(
  frame: FlowFrame,
  slot: SlotName,
  value: string,
): boolean {
  return (frame.rejected[slot] ?? []).includes(value);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Rebuilds flow state from storage against a closed shape.
 *
 * Same discipline as `parseBookingStageState`: anything unrecognised is
 * dropped rather than trusted, and an unreadable record produces the empty
 * state rather than a partial one. A conversation whose stored flow state is
 * corrupt is a conversation with no active flow, which is the safe reading.
 */
export function parseFlowState(value: unknown): FlowState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_FLOW_STATE;
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.stack)) return EMPTY_FLOW_STATE;
  const stack: FlowFrame[] = [];
  for (const entry of raw.stack.slice(0, MAX_STACK_DEPTH)) {
    const frame = parseFrame(entry);
    if (frame) stack.push(frame);
  }
  return { stack, version: 1 };
}

const FLOW_SET = new Set<string>([
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "register_patient",
  "answer_question",
  "retrieve_document",
  "package_inquiry",
  "patient_relationship_lookup",
]);
const STATUS_SET = new Set<string>([
  "active",
  "suspended",
  "parked",
  "completed",
  "cancelled",
]);
const PROVENANCE_SET = new Set<string>(["spoken", "affirmed", "derived"]);

function parseFrame(value: unknown): FlowFrame | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.flow !== "string" || !FLOW_SET.has(raw.flow)) return null;
  if (typeof raw.status !== "string" || !STATUS_SET.has(raw.status)) return null;
  const startedAt = isoOrNull(raw.startedAt);
  const lastAdvancedAt = isoOrNull(raw.lastAdvancedAt);
  if (!startedAt || !lastAdvancedAt) return null;
  return {
    flow: raw.flow as FlowName,
    status: raw.status as FrameStatus,
    slots: parseSlots(raw.slots),
    rejected: parseRejected(raw.rejected),
    offer: parseOffer(raw.offer, raw.flow as FlowName),
    topic: typeof raw.topic === "string" ? (raw.topic as QuestionTopic) : null,
    memo: parseMemo(raw.memo),
    startedAt,
    lastAdvancedAt,
  };
}

function parseSlots(value: unknown): Slots {
  if (!value || typeof value !== "object") return {};
  const out: Slots = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const provenance = typeof raw.provenance === "string" ? raw.provenance : "";
    // A slot with no readable provenance is discarded rather than defaulted.
    // Defaulting it would invent the very fact I-5 depends on.
    if (!PROVENANCE_SET.has(provenance)) continue;
    if (typeof raw.value !== "string" && typeof raw.value !== "number") continue;
    const at = isoOrNull(raw.at);
    if (!at) continue;
    out[key as SlotName] = {
      value: raw.value,
      ...(typeof raw.label === "string" ? { label: raw.label.slice(0, 120) } : {}),
      provenance: provenance as SlotProvenance,
      at,
    };
  }
  return out;
}

function parseRejected(value: unknown): FlowFrame["rejected"] {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    const values = entry
      .filter((item): item is string => typeof item === "string")
      .slice(0, 12);
    if (values.length > 0) out[key] = values;
  }
  return out as FlowFrame["rejected"];
}

function parseOffer(value: unknown, flow: FlowName): Offer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^[a-z]{3,12}_[0-9a-f]{8}$/.test(raw.id)) {
    return null;
  }
  const at = isoOrNull(raw.at);
  if (!at) return null;
  if (!Array.isArray(raw.options)) return null;
  const options: OfferOption[] = [];
  for (const entry of raw.options.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const option = entry as Record<string, unknown>;
    if (typeof option.id !== "string") continue;
    if (typeof option.value !== "string" && typeof option.value !== "number") continue;
    if (typeof option.label !== "string") continue;
    options.push({
      id: option.id,
      value: option.value,
      label: option.label.slice(0, 160),
      source: (typeof option.source === "string"
        ? option.source
        : "clinic_directory") as OfferOption["source"],
    });
  }
  if (options.length === 0) return null;
  return {
    id: raw.id,
    slot: typeof raw.slot === "string" ? (raw.slot as SlotName) : null,
    options,
    primaryOptionId:
      typeof raw.primaryOptionId === "string" &&
      options.some((option) => option.id === raw.primaryOptionId)
        ? raw.primaryOptionId
        : null,
    flow,
    kind: (typeof raw.kind === "string" ? raw.kind : "slot_value") as OfferKind,
    at,
  };
}

function parseMemo(value: unknown): FlowFrame["memo"] {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      // Bounded: a memo is ids and flags, never a transcript.
      out[key.slice(0, 40)] =
        typeof entry === "string" ? entry.slice(0, 200) : entry;
    }
  }
  return out;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function serializeFlowState(state: FlowState): Record<string, unknown> {
  return {
    version: 1,
    stack: state.stack.map((frame) => ({
      flow: frame.flow,
      status: frame.status,
      slots: frame.slots,
      rejected: frame.rejected,
      offer: frame.offer,
      topic: frame.topic,
      memo: frame.memo,
      startedAt: frame.startedAt,
      lastAdvancedAt: frame.lastAdvancedAt,
    })),
  };
}
