import "server-only";

import { z } from "zod";
import { CLINIC_REPORT_IDS } from "@/lib/ai/clinic-reports";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";

/**
 * Conversational entity context / session memory (P4.10A).
 *
 * Within one conversation the assistant keeps track of the entity under
 * discussion — "open Mohamed Hassan" -> "when was his last visit?" -> both refer
 * to the same patient — without re-asking. The context is a session-scoped slot
 * on the owner's `agent_conversations` row (see the P4.10A migration), read at
 * the start of every turn and used two ways:
 *
 *   1. as an **advisory prompt line** telling the model which entity is active
 *      (by internal id only — never a name, mirroring the reviewed page-context
 *      pattern in lib/ai/page-context.ts), and
 *   2. as a **server-side default parameter** for an entity-scoped tool when the
 *      model omits the id (`check_availability` and the retained report tools;
 *      the generic resource reads instead take the advisory id from the prompt
 *      line above as an ordinary registered filter).
 *
 * **Trust boundary.** An id in the active context is only ever a server-derived
 * one: it comes from a high-confidence entity resolution, an explicit user
 * choice, or a page-context launch — never from model free text. And it is
 * advisory only: every tool re-runs its full authorization (role, entitlement,
 * subscription, page visibility, RLS) on every call, so a stale or forged
 * context can only return what the same user could already fetch by naming the
 * entity explicitly, or nothing at all once access is lost.
 *
 * P4.10B enables every roadmap entity type on this same machinery and exposes
 * the stored label to the UI only. Prompt construction below deliberately reads
 * only entity_type + entity_id; display_label is never model context.
 */

/** Entity types that may occupy an active-context slot (P4.10 complete). */
export const ACTIVE_CONTEXT_ENTITY_TYPES = [
  "patient",
  "appointment",
  "invoice",
  "staff",
  "department",
  "report",
] as const;
export type ActiveContextEntityType = (typeof ACTIVE_CONTEXT_ENTITY_TYPES)[number];

/**
 * How a slot came to be set. Only server-trusted sources are allowed:
 *   - `resolution`   — a high-confidence single-match entity resolution (P4.6C).
 *   - `user_choice`  — the user explicitly picked a candidate (P4.10B UI).
 *   - `page_context` — the assistant was launched from an entity page (P4.8).
 * All three carry an id the server derived, never one the model asserted.
 */
export const ACTIVE_CONTEXT_SET_BY = ["resolution", "user_choice", "page_context"] as const;
export type ActiveContextSetBy = (typeof ACTIVE_CONTEXT_SET_BY)[number];

const MAX_LABEL_LENGTH = 200;
const UUID = z.string().uuid();

const activeEntitySchema = z
  .object({
    entity_type: z.enum(ACTIVE_CONTEXT_ENTITY_TYPES),
    entity_id: z.string().min(1).max(120),
    display_label: z.string().min(1).max(MAX_LABEL_LENGTH),
    set_at: z.string().datetime(),
    set_by: z.enum(ACTIVE_CONTEXT_SET_BY),
  })
  .strict()
  .superRefine((slot, ctx) => {
    const validId =
      slot.entity_type === "report"
        ? z.enum(CLINIC_REPORT_IDS).safeParse(slot.entity_id).success
        : UUID.safeParse(slot.entity_id).success;
    if (!validId) {
      ctx.addIssue({
        code: "custom",
        path: ["entity_id"],
        message: "Invalid entity id for active-context type.",
      });
    }
  });

export type ActiveEntityContext = z.infer<typeof activeEntitySchema>;

/** One optional slot per entity type. */
export type PendingActionConfirmation = {
  action_id: string;
  expires_at: string;
};

export type ActiveContext = Partial<Record<ActiveContextEntityType, ActiveEntityContext>>;
type PersistedActiveContext = ActiveContext & {
  /** Metadata only; the opaque token stays in the persisted UI tool part. */
  pending_confirmations?: PendingActionConfirmation[];
};

const pendingConfirmationSchema = z.object({
  action_id: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
  expires_at: z.string().datetime(),
}).strict();

/**
 * Parses the persisted `active_context` jsonb into a validated map.
 *
 * Deliberately lenient at the container level and strict per slot: an unknown
 * entity-type key, a slot for a key that does not match its own `entity_type`,
 * or a malformed/forward-version slot is dropped rather than throwing, so a
 * corrupted or newer-schema row degrades to "no active context for that type"
 * and never fails an otherwise valid turn. A validated id is still only trusted
 * because it was written by the server-side setter below.
 */
export function parseActiveContext(value: unknown): ActiveContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: PersistedActiveContext = {};
  for (const entityType of ACTIVE_CONTEXT_ENTITY_TYPES) {
    const slot = (value as Record<string, unknown>)[entityType];
    const parsed = activeEntitySchema.safeParse(slot);
    // The slot's own entity_type must agree with the key it is stored under, so
    // a "patient" payload cannot be smuggled in under a future key or vice versa.
    if (parsed.success && parsed.data.entity_type === entityType) {
      result[entityType] = parsed.data;
    }
  }
  const pending = z.array(pendingConfirmationSchema).max(10).safeParse(
    (value as Record<string, unknown>).pending_confirmations,
  );
  if (pending.success && pending.data.length > 0) {
    result.pending_confirmations = pending.data.filter((item) => Date.parse(item.expires_at) > Date.now());
  }
  return result;
}

export function pendingActionConfirmations(context: ActiveContext | null | undefined): PendingActionConfirmation[] {
  return (context as PersistedActiveContext | null | undefined)?.pending_confirmations ?? [];
}

export function withPendingActionConfirmations(
  current: ActiveContext,
  pending: readonly PendingActionConfirmation[],
): ActiveContext {
  const next = pending
    .filter((item) => pendingConfirmationSchema.safeParse(item).success && Date.parse(item.expires_at) > Date.now())
    .slice(-10);
  const { pending_confirmations: _previous, ...entities } = current as PersistedActiveContext;
  return (next.length > 0 ? { ...entities, pending_confirmations: next } : entities) as ActiveContext;
}

export function withoutPendingActionConfirmation(
  current: ActiveContext,
  completed: PendingActionConfirmation,
): ActiveContext {
  return withPendingActionConfirmations(
    current,
    pendingActionConfirmations(current).filter(
      (item) =>
        item.action_id !== completed.action_id ||
        item.expires_at !== completed.expires_at,
    ),
  );
}

export function readActiveEntityContext(
  context: ActiveContext | null | undefined,
  entityType: ActiveContextEntityType,
): ActiveEntityContext | null {
  return context?.[entityType] ?? null;
}

/** The active patient's id, or null. The only entity-scoped default in P4.10A. */
export function activePatientId(context: ActiveContext | null | undefined): string | null {
  return readActiveEntityContext(context, "patient")?.entity_id ?? null;
}

/**
 * Whether any entity slot is occupied.
 *
 * Read by the task-class router as an *operand* signal only: it is what lets
 * "how do I book him for that slot?" be recognized as the final turn of a
 * booking rather than a documentation question. It reports presence, never an
 * id, never a label, and grants nothing — every tool and every action still
 * re-authorizes independently. `pending_confirmations` is metadata, not an
 * entity, so it is excluded by construction.
 */
export function hasActiveEntitySlot(context: ActiveContext | null | undefined): boolean {
  return ACTIVE_CONTEXT_ENTITY_TYPES.some((entityType) => Boolean(context?.[entityType]));
}

export function activeEntityId(
  context: ActiveContext | null | undefined,
  entityType: ActiveContextEntityType,
): string | null {
  return readActiveEntityContext(context, entityType)?.entity_id ?? null;
}

/**
 * A server-derived proposal to set/switch an active-context slot, produced by a
 * tool during a turn and applied once at persistence time.
 */
export type ActiveContextProposal = {
  entityType: ActiveContextEntityType;
  entityId: string;
  displayLabel: string;
  setBy: ActiveContextSetBy;
};

/**
 * Collects at most one active-context proposal per turn.
 *
 * Tools cannot write the context directly: the conversation row may not exist
 * yet on a first turn (it is created only when the turn is persisted), and
 * writing mid-turn would break the "keep the first turn virtual until it
 * completes" invariant that stops an aborted turn from leaving an empty
 * conversation behind. Instead a tool *proposes* a resolved entity here and the
 * persistence layer applies it to the row it is already writing. Last write in a
 * turn wins, so a later explicit switch supersedes an earlier resolution.
 */
export class ConversationContextRecorder {
  #proposals = new Map<ActiveContextEntityType, ActiveContextProposal>();

  propose(
    entityType: ActiveContextEntityType,
    entityId: string,
    displayLabel: string,
    setBy: ActiveContextSetBy = "resolution",
  ): void {
    const label = displayLabel.trim().slice(0, MAX_LABEL_LENGTH);
    if (!label) return;
    this.#proposals.set(entityType, {
      entityType,
      entityId,
      displayLabel: label,
      setBy,
    });
  }

  proposePatient(
    entityId: string,
    displayLabel: string,
    setBy: ActiveContextSetBy = "resolution",
  ): void {
    this.propose("patient", entityId, displayLabel, setBy);
  }

  /** P4.10A compatibility accessor: the latest proposal across all types. */
  take(): ActiveContextProposal | null {
    return this.takeAll().at(-1) ?? null;
  }

  /**
   * At most one proposal per entity type, with the latest resolution for that
   * type winning. Different types may be recorded in one turn (for example a
   * resolved doctor plus the one appointment returned for that doctor).
   */
  takeAll(): ActiveContextProposal[] {
    return [...this.#proposals.values()];
  }
}

/**
 * Applies a proposal onto an existing context map, returning a new map. One slot
 * per entity type: a new proposal for a type replaces that type's slot (a
 * natural context switch) and leaves other types untouched.
 */
export function applyProposal(
  current: ActiveContext,
  proposal: ActiveContextProposal,
  now: Date = new Date(),
): ActiveContext {
  const slot = activeEntitySchema.safeParse({
    entity_type: proposal.entityType,
    entity_id: proposal.entityId,
    display_label: proposal.displayLabel,
    set_at: now.toISOString(),
    set_by: proposal.setBy,
  });
  // A proposal that fails validation (e.g. a non-uuid id) is a server-side bug,
  // not a user state: drop it rather than persisting a slot the reader would
  // then discard anyway.
  if (!slot.success) return current;
  return { ...current, [proposal.entityType]: slot.data };
}

export function applyProposals(
  current: ActiveContext,
  proposals: readonly ActiveContextProposal[],
  now: Date = new Date(),
): ActiveContext {
  return proposals.reduce(
    (context, proposal) => applyProposal(context, proposal, now),
    current,
  );
}

export function clearActiveEntityContext(
  current: ActiveContext,
  entityType: ActiveContextEntityType,
): ActiveContext {
  if (!current[entityType]) return current;
  const next = { ...current };
  delete next[entityType];
  return next;
}

/**
 * The advisory system-prompt line describing the active entity context.
 *
 * Like the page-context prompt, this references the entity by **internal id
 * only** — never the stored display label — so no tenant-authored name enters
 * the model's system instruction, and it explicitly states that the context
 * grants no access and that ids are never shown in the answer. It is empty when
 * there is no active context.
 */
export function buildActiveContextPrompt(
  context: ActiveContext | null | undefined,
  locale: PromptLocale,
): string {
  const slots = ACTIVE_CONTEXT_ENTITY_TYPES.flatMap((entityType) => {
    const slot = readActiveEntityContext(context, entityType);
    return slot ? [{ entityType, entityId: slot.entity_id }] : [];
  });
  const pending = pendingActionConfirmations(context);
  if (slots.length === 0 && pending.length === 0) return "";

  const argumentNames: Record<ActiveContextEntityType, string> = {
    patient: "patient_id",
    appointment: "appointment_id",
    invoice: "invoice_id",
    staff: "doctor/staff filter",
    department: "department filter",
    report: "report",
  };
  const english = slots
    .map(
      ({ entityType, entityId }) =>
        `- active ${entityType}: internal id "${entityId}" (identity for ${argumentNames[entityType]})`,
    )
    .join("\n");
  const arabicType: Record<ActiveContextEntityType, string> = {
    patient: "المريض",
    appointment: "الموعد",
    invoice: "الفاتورة",
    staff: "الموظف",
    department: "القسم",
    report: "التقرير",
  };
  const arabic = slots
    .map(
      ({ entityType, entityId }) =>
        `- ${arabicType[entityType]} النشط: المعرّف الداخلي "${entityId}" (هوية للوسيط ${argumentNames[entityType]})`,
    )
    .join("\n");

  if (locale === "ar") {
    return `\n\nسياق المحادثة النشط:\n${arabic}${pending.length ? `\nيوجد ${pending.length} إجراء/إجراءات بانتظار تأكيد المستخدم على الشاشة. لا تنفذها ولا تطلب رمز تأكيد.` : ""}\nاستخدم القيمة النشطة فقط عندما يشير المستخدم إلى الكيان نفسه أو يستخدم ضميرًا دون تسمية كيان جديد. في أدوات القوائم، فعّل وسيط use_active الخاص بنوع الكيان المقصود فقط؛ لا تفعّله للاستعلامات العامة أو التجميعية، ولا تنسخ المعرّف النشط إلى وسيط المعرّف الصريح. إذا سمّى المستخدم كيانًا جديدًا، فحلّه عبر أداة مصرح بها أولًا ولا تفترض استمرار السابق. هذا السياق لا يمنح أي صلاحية؛ يعاد التحقق من كل أداة على حِدة، ولا تعرض أي معرّف داخلي في الإجابة.`;
  }
  return `\n\nActive conversation context:\n${english}${pending.length ? `\n${pending.length} action preview(s) await the user's on-screen confirmation. Do not execute them, request a token, or claim they completed.` : ""}\nUse an active value only when the user refers to that same entity or uses a pronoun without naming a new one. For list tools, set only the use_active flag for the entity type the user explicitly means; leave every use_active flag false or omitted for broad or aggregate requests, and do not copy an active id into an explicit id argument. If the user names a new entity, resolve it through an authorized tool first and do not assume the previous one still applies. This context grants no access; every tool re-authorizes independently, and never display an internal id in the answer.`;
}
