import "server-only";

import * as Sentry from "@sentry/nextjs";
import { createHash, randomUUID } from "node:crypto";
import { calculateUsageCostMicros, calculateWorstCaseCostMicros } from "@/lib/ai/platform/cost";
import { resolveManagedProvider } from "@/lib/ai/platform/managed-provider";
import {
  resolveAiProviderCredential,
  resolveByokFallbackCredential,
} from "@/lib/ai/platform/provider-connections";
import { transportForCredentialMode } from "@/lib/ai/platform/transport";
import { notifyAiUsageThresholds } from "@/lib/ai/usage-notifications";
import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import { prepareTenantProvider } from "@/lib/ai/platform/tenant-provider";
import type {
  AiCredentialMode,
  AiExecutionHandle,
  AiExecutionOutcome,
  AiObservedStep,
  AiPersona,
  AiProviderResolutionReason,
  AiSurface,
  AiTaskClass,
  AiUsageAttempt,
} from "@/lib/ai/platform/types";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { assertAiTurnAllowed } from "@/lib/ai/usage";
import { logAiProviderFallback, reconcileAiBudget, reserveAiBudget } from "@/lib/supabase/admin";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";
import { getEntitlements, hasAiProviderMode, hasFeature } from "@/lib/entitlements";
import { AI_LIMIT_KEYS } from "@/lib/ai/commercial-policy";
import {
  AI_ASSISTANT_FEATURE,
} from "@/lib/ai/authorization";

const RESERVATION_LEASE_SECONDS = 600;

function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable across a transport retry, without hashing or retaining message content.
 * A new logical send/regenerate action must use a new client message id: finalized
 * request ids are intentionally never reusable in the durable reservation ledger.
 */
export function createAiRequestId(input: {
  clinicId: string;
  actorId: string;
  conversationId: string;
  messageId: string;
}): string {
  return stableUuid(
    ["clinicflow-ai-v1", input.clinicId, input.actorId, input.conversationId, input.messageId].join(":"),
  );
}

/**
 * Conservative pre-provider guard: a tokenizer cannot produce more tokens
 * than the UTF-8 bytes supplied. JSON overhead intentionally makes this check
 * stricter, ensuring actual input stays inside the amount cost-reserved.
 */
export function assertAiInputWithinPolicy(messages: unknown, maxInputTokens: number): void {
  const serialized = JSON.stringify(messages);
  if (Buffer.byteLength(serialized, "utf8") > maxInputTokens) {
    throw new AiPolicyInputLimitError();
  }
}

export class AiPolicyInputLimitError extends Error {
  constructor() {
    super("AI input exceeds the certified task policy.");
    this.name = "AiPolicyInputLimitError";
  }
}

export function clampTaskPolicySteps(
  policy: ReturnType<typeof getTaskPolicy>,
  configuredLimit: number | undefined,
): ReturnType<typeof getTaskPolicy> {
  if (!Number.isInteger(configuredLimit) || configuredLimit === undefined || configuredLimit < 1) {
    return policy;
  }
  return { ...policy, maxSteps: Math.min(policy.maxSteps, configuredLimit) };
}

/**
 * Deterministic operational-intent detection for the task-class router.
 *
 * Keyword-based on purpose: the router decides a *budget and policy*, so it has
 * to be cheap, predictable, and inspectable in a test. An LLM classifier here
 * would mean a model call to decide how much model call to allow.
 *
 * Getting it wrong is safe in both directions — this selects a certified policy
 * from a fixed set, never an authorization. A missed operational turn simply
 * runs on the roomier administrative budget; a false positive runs a chatty turn
 * on a tighter one. Authorization, entitlement, and the tool mount are decided
 * elsewhere and are unaffected.
 */
const OPERATIONAL_INTENT_RE = new RegExp(
  [
    // English: aggregates, lists, reports, financial questions.
    "\\b(how many|how much|count|total|totals|average|rate|rates|trend|trends|compare|comparison)\\b",
    "\\b(list|show me|report|reports|statistics|stats|summary|breakdown|distribution)\\b",
    "\\b(revenue|invoice|invoices|outstanding|unpaid|deposit|deposits|billing|income)\\b",
    "\\b(no.?show|no.?shows|cancellation|cancellations|follow.?up|follow.?ups)\\b",
    // Arabic equivalents.
    "(كم عدد|كم|إجمالي|اجمالي|عدد|متوسط|نسبة|مقارنة|اتجاه)",
    "(قائمة|اعرض|أعرض|تقرير|تقارير|إحصائيات|احصائيات|ملخص|توزيع)",
    "(إيراد|ايراد|إيرادات|ايرادات|فاتورة|فواتير|مستحق|مستحقات|غير مدفوع|دفعة|دفعات)",
    "(عدم الحضور|إلغاء|الغاء|إلغاءات|متابعة|متابعات)",
  ].join("|"),
  "iu",
);

export function isOperationalQueryIntent(text: string | null | undefined): boolean {
  return typeof text === "string" && OPERATIONAL_INTENT_RE.test(text);
}

/**
 * Deterministic help-intent detection (P4.7A).
 *
 * Same keyword approach as the operational router, but held to a **stricter
 * standard**, because the two failure modes are not symmetric. Misrouting an
 * operational turn only changes its budget. Misrouting a turn to `staff_help`
 * also changes its *mount*: the help class is the first one narrow enough to
 * exclude every tool that reads clinic data, so a false positive would leave a
 * real data question with no tool able to answer it.
 *
 * Two guards make that unlikely, and make the residual risk one-directional:
 *
 *  1. The phrasing must look like a request for instructions — "how do I…",
 *     "where is…", "كيف أ…", "أين أجد…" — not merely mention a feature.
 *  2. The turn must not already read as an *aggregation or list* request. This
 *     is narrower than the full operational matcher on purpose. That matcher
 *     flags any domain noun — "invoice", "revenue", "follow-up" — so deferring
 *     to it wholesale would misroute "how do I issue an invoice", a textbook
 *     help question, back to the data class. What actually distinguishes a data
 *     turn is an aggregation or listing verb ("how many", "list", "show me",
 *     "compare", "total"), so only those override an instructional opener.
 *
 * So a missed help turn costs a little money and answers correctly (the help
 * tools are mounted in every class), while a false positive is filtered out by
 * guard 2 in exactly the cases where it would have hurt — "how many invoices are
 * outstanding" keeps its data tools; "how do I issue an invoice" becomes help.
 * That asymmetry is the design, not a happy accident.
 */
const HELP_INTENT_RE = new RegExp(
  [
    // English: asking to be taught or directed.
    "\\b(how (do|can|would) (i|we|you)|how to)\\b",
    "\\bwhere (is|are|do|can) (i|we|it|the|that)\\b",
    "\\b(walk me through|show me how|steps to|guide me|teach me)\\b",
    "\\b(how does .* work|what does .* (button|page|screen|setting) do)\\b",
    // Arabic: كيف/ازاي/وين/فين + طلب الشرح والخطوات.
    "(كيف (أ|ا|ن|ي)|كيفية|ازاي|إزاي)",
    "(اين|أين|وين|فين) (أجد|اجد|هو|هي|يمكن|أستطيع|استطيع)",
    "(اشرح لي|وضح لي|خطوات|كيف استخدم|كيف أستخدم|دلني|علمني)",
  ].join("|"),
  "iu",
);

/**
 * The subset of operational phrasing that overrides an instructional opener:
 * aggregation and listing, not domain nouns. "show me how" is excluded so it
 * stays a help phrase.
 */
const AGGREGATION_LEAD_RE = new RegExp(
  [
    "\\b(how many|how much|count|total|totals|average|rate|rates|trend|trends|compare|comparison|breakdown|distribution|statistics|stats)\\b",
    "\\b(list|report|reports)\\b",
    "\\bshow me (?!how)\\b",
    "(كم عدد|كم |إجمالي|اجمالي|عدد|متوسط|نسبة|مقارنة|اتجاه|توزيع|إحصائيات|احصائيات)",
    "(قائمة|اعرض|أعرض|تقرير|تقارير)",
  ].join("|"),
  "iu",
);

export function isHelpIntent(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  // Guard 2: an aggregation/list request keeps its data tools even when phrased
  // as a question. A bare domain noun does not — that is the difference between
  // this and the full operational matcher.
  if (AGGREGATION_LEAD_RE.test(text)) return false;
  return HELP_INTENT_RE.test(text);
}

/**
 * Guard 3 — the actionable-write override (action-routing regression fix).
 *
 * `isHelpIntent` above detects the *mood* of a sentence, not its content. That
 * was enough while `staff_help` only competed with data reads, because the help
 * tools are mounted in every class: a missed help turn still answered correctly,
 * just on a roomier budget. It stopped being enough once `staff_help` became the
 * one class narrow enough to unmount `execute_action` and `describe_action`.
 * From that point on, "how do I book Ahmed Ali with Dr. Sara on Sunday at
 * 10:00?" — an authorized, entitled, fully-specified booking request — lost the
 * entire registered write surface on nothing more than its sentence mood, and
 * degraded to a navigation hint. See
 * `docs/reports/AI_ASSISTANT_ACTION_ROUTING_REVIEW.md`.
 *
 * The override is deliberately conjunctive: an instructional opener leaves
 * `staff_help` only when the turn carries **both**
 *
 *   1. a write verb from the lexicon below, and
 *   2. a concrete operand — a clock time, a date or weekday, a file/record
 *      number, a named person (a capitalized non-sentence-initial Latin token or
 *      an Arabic honorific/patient marker), or a pronoun resolving against a
 *      live conversation entity context.
 *
 * Requiring both is the whole design. The verb alone would drag "how do I issue
 * an invoice?" and "كيف أصدر فاتورة؟" — textbook documentation questions — back
 * onto the expensive class and destroy the containment property `staff_help`
 * exists to provide. The operand alone would catch "where is Ahmed Ali's file?",
 * which is a read. Only their conjunction describes a booking request wearing a
 * question mark.
 *
 * Like every other signal here, this selects a **policy and budget**, never an
 * authorization. Overriding to `staff_administrative` mounts the same tools that
 * an imperatively-phrased turn from the same user already mounted; each action
 * still re-asserts role, entitlement, per-user permission, and page visibility
 * in `assertActionAccess`, and still requires the on-screen confirmation. A
 * false positive costs money; it can never widen what the caller may do.
 */
const WRITE_INTENT_RE = new RegExp(
  [
    // English — explicit forms rather than stems, so "issuing"/"rescheduling"
    // match without a suffix regex that would also match unrelated words.
    "\\b(book|books|booking|rebook|rebooking|schedule|schedules|scheduling|reschedule|reschedules|rescheduling)\\b",
    "\\b(create|creates|creating|add|adds|adding|register|registers|registering|enrol|enroll|enrolling)\\b",
    "\\b(issue|issues|issuing|bill|bills|billing|charge|charges|charging|collect|collects|collecting|refund|refunds|refunding|pay|pays|paying)\\b",
    "\\b(record|records|recording|log|logs|logging|update|updates|updating|edit|edits|editing|change|changes|changing|amend|amends|amending|assign|assigns|assigning)\\b",
    "\\b(cancel|cancels|cancelling|canceling|delete|deletes|deleting|remove|removes|removing)\\b",
    "\\b(mark|marks|marking|confirm|confirms|confirming|approve|approves|approving|check\\s*-?\\s*in|checking\\s+in)\\b",
    "\\b(send|sends|sending|write|writes|writing|prescribe|prescribes|prescribing|upload|uploads|uploading|attach|attaches|attaching|reprint|reprints|reprinting)\\b",
    // Arabic — stems, bounded so a stem cannot match inside a longer word
    // ("معدل" must not fire on "عدل"), while the ordinary attached prefixes
    // (و/ف/ل/ب/ك, ال) and object suffixes still do.
    arabicStems([
      "احجز", "أحجز", "حجز", "اجدول", "أجدول", "جدول",
      "أنشئ", "انشئ", "إنشاء", "أضف", "اضف", "إضافة", "سجّل", "سجل", "تسجيل",
      "أصدر", "اصدر", "إصدار", "افوتر", "حصّل", "حصل",
      "حدّث", "حدث", "تحديث", "عدّل", "عدل", "تعديل",
      "ألغِ", "ألغ", "الغ", "إلغاء", "احذف", "أحذف", "حذف",
      "عيّن", "عين", "أرسل", "ارسل", "إرسال",
      "اكتب", "أكتب", "كتابة", "اطبع", "أطبع", "أكّد", "أكد", "تأكيد",
      "ارفع", "أرفع", "رفع", "اصرف", "أصرف", "صرف",
    ]),
  ].join("|"),
  "iu",
);

/**
 * A stem list bounded by Arabic-letter lookarounds, tolerating the attached
 * conjunction/preposition prefixes and object-pronoun suffixes that Arabic
 * writes as part of the word.
 */
function arabicStems(
  stems: readonly string[],
  // Optional imperfect/imperative inflection ("ألغ" → "ألغي") followed by an
  // optional attached object pronoun ("أحجز" → "أحجزه").
  suffix = "(?:ي|و|وا|ين)?(?:ه|ها|هم|هن|ني|نا|ك|كم)?",
): string {
  return `(?<![\\u0621-\\u064A])[وفلبك]?(?:ال)?(?:${stems.join("|")})${suffix}(?![\\u0621-\\u064A])`;
}

/**
 * A concrete operand the turn could act on, detected without a model call.
 * Case-insensitive half: times, dates, weekdays, record numbers, honorifics.
 */
const OPERAND_RE = new RegExp(
  [
    // Clock times and explicit hours.
    "\\b\\d{1,2}\\s*:\\s*\\d{2}\\b",
    "\\b\\d{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)\\b",
    "\\bat\\s+\\d{1,2}\\b",
    // Dates.
    "\\b\\d{4}-\\d{2}-\\d{2}\\b",
    "\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b",
    "\\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b",
    "\\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\\b",
    // File / record identifiers.
    "\\b(?:file|record|invoice|appointment|patient|folder)\\s*(?:no\\.?|number|#)\\s*\\d+",
    "#\\s*\\d+",
    // A named doctor.
    "\\bdr\\.?\\s+[\\p{L}]{2,}",
    "\\bdoctor\\s+[\\p{L}]{2,}",
    // Arabic date/time vocabulary.
    "(اليوم|غدا|غدًا|بكرة|بعد غد|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت|الساعة|صباحا|صباحًا|مساء|مساءً)",
    // Arabic honorific followed by a name (the dot/word form is required so a
    // bare "د" cannot match the first letter of an ordinary word).
    "(?:د\\.|دكتور|الدكتور|دكتورة|الدكتورة|أ\\.د)\\s*[\\u0621-\\u064A]{2,}",
    // Arabic subject markers naming a specific person or file.
    "(?:المريض|المريضة|للمريض|للمريضة|باسم|اسمه|اسمها|رقم الملف|ملف رقم)\\s*[\\u0621-\\u064A0-9]{2,}",
  ].join("|"),
  "iu",
);

/**
 * Words that are capitalized mid-sentence in ordinary product prose and are
 * therefore not evidence of a named person. Page and feature names dominate the
 * list because "the Appointments page" is exactly the phrasing a genuine
 * documentation question uses.
 */
const NON_NAME_CAPITALIZED = new Set([
  "i", "clinicflow", "whatsapp", "ai", "sms",
  "appointment", "appointments", "invoice", "invoices", "patient", "patients",
  "doctor", "doctors", "staff", "report", "reports", "setting", "settings",
  "dashboard", "calendar", "clinic", "clinics", "prescription", "prescriptions",
  "document", "documents", "billing", "payment", "payments", "followup",
  "followups", "help", "page", "pages", "screen", "system", "sick", "leave",
  "lab", "requests", "request", "note", "notes", "package", "packages",
  "inbox", "notification", "notifications", "profile", "account", "admin",
  "manager", "receptionist", "assistant", "queue", "schedule",
]);

/**
 * A capitalized Latin token that does not open its sentence — the cheapest
 * reliable proper-name signal in English text. Case-sensitive by necessity, so
 * it cannot live in the `i`-flagged operand regex above (`\p{Lu}` under `i`
 * matches lowercase too).
 */
const CAPITALIZED_TOKEN_RE = /\p{Lu}[\p{L}'’-]+/gu;

function hasProperNameOperand(text: string): boolean {
  for (const match of text.matchAll(CAPITALIZED_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (NON_NAME_CAPITALIZED.has(match[0].toLowerCase())) continue;
    // Sentence-initial capitalization carries no information.
    const before = text.slice(0, index).replace(/[\s"'“”(]+$/u, "");
    if (before === "" || /[.!?؟\n]$/u.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * A pronoun or deictic that only means something against the conversation's
 * active entity context. This is what makes the reported multi-turn transcript
 * work: patient and slot were resolved in earlier turns, and the final turn is
 * "how do I book him for that slot?" — no operand of its own, but a live one.
 *
 * Gating the active context behind an explicit reference (rather than treating
 * any live slot as an operand) is a deliberate tightening of the review's
 * §7.1(2): once a patient has been resolved, every later documentation question
 * in that conversation would otherwise be dragged off the cheap class, which is
 * exactly the containment loss the fix is supposed to avoid.
 */
const CONTEXT_REFERENCE_RE = new RegExp(
  [
    "\\b(him|her|hers|his|them|their|theirs|it|its)\\b",
    "\\b(this|that|the same|the) (patient|appointment|invoice|slot|booking|visit|record|one)\\b",
    "(له|لها|لهم|لهذا|لهذه|نفس|هذا المريض|هذه المريضة|هذا الموعد|ذلك الموعد|هذه الفاتورة|الموعد نفسه|المذكور|السابق)",
    // A write verb carrying an attached object pronoun — "كيف أحجزه؟".
    arabicStems(
      [
        "احجز", "أحجز", "سجل", "سجّل", "ألغ", "الغ", "عدل", "عدّل",
        "أرسل", "ارسل", "اكتب", "أكتب", "أصدر", "اصدر",
      ],
      "(?:ي|و|وا)?(?:ه|ها|هم|هن)",
    ),
  ].join("|"),
  "iu",
);

export function hasWriteIntentVerb(text: string | null | undefined): boolean {
  return typeof text === "string" && WRITE_INTENT_RE.test(text);
}

export function hasConcreteOperand(
  text: string | null | undefined,
  options: { hasActiveEntityContext?: boolean } = {},
): boolean {
  if (typeof text !== "string") return false;
  if (OPERAND_RE.test(text)) return true;
  if (hasProperNameOperand(text)) return true;
  return options.hasActiveEntityContext === true && CONTEXT_REFERENCE_RE.test(text);
}

/**
 * A supported write intent expressed with something concrete to act on — the
 * signal that an instructionally-phrased turn is a request, not a question.
 */
export function isActionableWriteRequest(
  text: string | null | undefined,
  options: { hasActiveEntityContext?: boolean } = {},
): boolean {
  return hasWriteIntentVerb(text) && hasConcreteOperand(text, options);
}

/**
 * Deterministic composite-intent detector. It selects the larger normal-agent
 * budget only; it never changes the caller's capability mount.
 */
const WORKFLOW_INTENT_RE = new RegExp(
  [
    "\\b(and then|then (?:send|show|find|run|check|summari[sz]e|create|book)|after that|in one go|multi.?step|workflow)\\b",
    "\\b(first .{0,120} then)\\b",
    "\\b(find|list|run|generate|check|show)\\b.{0,160}\\b(and|then)\\b.{0,40}\\b(summari[sz]e|compare|show|find|list|run|check|send|notify|create|book)\\b",
    "(ثم|وبعد ذلك|بعدها|دفعة واحدة|خطوات متعددة|سير عمل)",
    "(أولاً|اولا).{0,120}(ثم|بعدها)",
    "(ابحث|اعرض|أعرض|شغل|شغّل|أنشئ|انشئ).{0,160}(?:\\s+و\\s+|ثم).{0,40}(لخص|لخّص|قارن|اعرض|أعرض|ابحث|أرسل|ارسل|أبلغ|ابلغ)",
  ].join("|"),
  "iu",
);

export function isCompositeIntent(text: string | null | undefined): boolean {
  return typeof text === "string" && WORKFLOW_INTENT_RE.test(text);
}

/**
 * Resolves the certified task class for a staff turn.
 *
 * Doctors always route to the clinical class. Administrative personas route by
 * the *intent of the turn*, which is what §12 of the expansion proposal
 * describes ("`staff_operational_query` for lists/stats") — not by entitlement.
 *
 * Routing on entitlement instead, as this first did, had a consequence worth
 * spelling out: at the time, the catalog seeded `ai.staff_analytics` only on
 * the AI tier, so *every* administrative turn on an entitled clinic ran as
 * `staff_operational_query`. That made
 * `staff_administrative` unreachable in production and silently cut the budget
 * for turns that touch no analytics tool at all — a plain patient lookup, an
 * availability check, an open-ended question — from 8 steps / 1500 tokens to
 * 6 / 1200. The tighter budget is right for typed aggregates and bounded lists;
 * it was never justified for the general administrative persona, and applying
 * it there was a regression against the shipped P4B surface.
 *
 * Intent routing restores the administrative baseline for administrative turns
 * while keeping the cheaper class for the turns it was designed for. The
 * entitlement still matters — without it the analytics tools do not mount — but
 * it decides *capability*, not *budget*.
 */
export function staffTaskForRole(
  role: AuthedUser["role"],
  options: {
    analyticsEntitled?: boolean;
    messageText?: string | null;
    /**
     * Whether the conversation carries a live server-resolved entity slot
     * (P4.10 active context). Read only as an *operand* signal for the
     * actionable-write override — never as an authorization or a capability.
     */
    hasActiveEntityContext?: boolean;
  } = {},
): {
  task: AiTaskClass;
  persona: AiPersona;
} {
  const isClinicalRole = role === "doctor" || role === "assistant";
  const helpPhrasing = isHelpIntent(options.messageText);
  // Guard 3. An instructional opener is a documentation question only when the
  // turn does not also carry a supported write intent with something concrete
  // to act on. Evaluated here, inside the help branch, because that branch
  // returns before every other signal is consulted.
  const actionableWrite =
    helpPhrasing &&
    isActionableWriteRequest(options.messageText, {
      hasActiveEntityContext: options.hasActiveEntityContext,
    });

  // Help routing is checked before the persona split because "how do I use
  // this?" is the same question from every role, and answering it out of the
  // clinical budget is the exact waste P4.7 exists to stop. The persona still
  // differs — `staff_help` admits both, and the system prompt is still built
  // from the caller's real role.
  if (helpPhrasing && !actionableWrite) {
    return {
      task: "staff_help",
      persona: isClinicalRole ? "doctor" : "administrative_staff",
    };
  }

  if (isCompositeIntent(options.messageText)) {
    return {
      task: "staff_composite",
      persona: isClinicalRole ? "doctor" : "administrative_staff",
    };
  }

  if (isClinicalRole) {
    return { task: "staff_clinical_summary", persona: "doctor" };
  }

  // An overridden write request runs on the administrative baseline rather than
  // the tighter operational class: its domain noun ("invoice", "follow-up")
  // would otherwise match `isOperationalQueryIntent` and hand a preview →
  // confirm → execute turn the budget sized for a typed aggregate.
  if (actionableWrite) {
    return { task: "staff_administrative", persona: "administrative_staff" };
  }

  // The operational class is only meaningful when the operational tools can
  // actually mount, so the entitlement remains a precondition — but it is no
  // longer sufficient on its own.
  const operational =
    options.analyticsEntitled === true && isOperationalQueryIntent(options.messageText);

  return {
    task: operational ? "staff_operational_query" : "staff_administrative",
    persona: "administrative_staff",
  };
}

function isBudgetDenial(message: string | undefined): boolean {
  return message?.includes("AI_BUDGET_EXCEEDED") === true ||
    message?.includes("AI_BUDGET_CONCURRENCY_EXCEEDED") === true ||
    message?.includes("AI_FAIR_USE_LIMIT_EXCEEDED") === true ||
    message?.includes("USAGE_LIMIT_EXCEEDED") === true;
}

/**
 * The subset of denials that mean "ClinicFlow will not fund this turn" — as
 * opposed to "this clinic is asking for too much at once" or "this clinic is
 * past its abuse ceiling".
 *
 * The distinction is what makes the automatic managed→BYOK handover safe. Only
 * an exhausted MONETARY allowance or an exhausted ClinicFlow-funded request pool
 * may be answered by moving the turn onto the clinic's own key. A concurrency
 * denial must never be, because retrying it on another credential would defeat
 * the concurrency limit; a fair-use denial must never be, because that limit
 * exists precisely to bound BYOK.
 */
function isManagedAllowanceExhausted(message: string | undefined): boolean {
  if (!message) return false;
  if (message.includes("AI_BUDGET_CONCURRENCY_EXCEEDED")) return false;
  if (message.includes("AI_FAIR_USE_LIMIT_EXCEEDED")) return false;
  return message.includes("AI_BUDGET_EXCEEDED") || message.includes("USAGE_LIMIT_EXCEEDED");
}

function safeErrorClass(value: string | null | undefined): string | null {
  if (!value) return null;
  const allowed = new Set([
    "client_aborted",
    "input_limit_reached",
    "stream_failed",
    "request_failed",
    "provider_step_error",
    "provider_timeout",
  ]);
  return allowed.has(value) ? value : "execution_failed";
}

function stepStatus(finishReason: string): AiUsageAttempt["status"] {
  return finishReason === "error" ? "failed" : finishReason === "other" ? "aborted" : "success";
}

export async function prepareAiExecution(input: {
  user: Pick<AuthedUser, "id" | "clinicId">;
  requestId: string;
  task: AiTaskClass;
  persona: AiPersona;
  surface: AiSurface;
  now?: Date;
}): Promise<AiExecutionHandle> {
  const now = input.now ?? new Date();
  const certifiedTaskPolicy = getTaskPolicy(input.task, input.persona);
  const route = getCertifiedModelRoute(certifiedTaskPolicy);
  const credential = await resolveAiProviderCredential(input.user.clinicId);
  const entitlements = await getEntitlements(input.user.clinicId);
  const taskPolicy = clampTaskPolicySteps(
    certifiedTaskPolicy,
    entitlements.limits?.[AI_LIMIT_KEYS.turnStepsMax],
  );
  const isPatientSurface = input.surface === "patient_messaging";
  const surfaceAndTaskMatch = isPatientSurface
    ? input.persona === "patient" &&
      (input.task === "patient_booking" || input.task === "patient_faq")
    : input.persona !== "patient" &&
      !input.task.startsWith("patient_");
  if (
    !surfaceAndTaskMatch ||
    !hasFeature(entitlements, AI_ASSISTANT_FEATURE) ||
    !hasFeature(
      entitlements,
      isPatientSurface ? "ai.patient_suggest" : "ai.staff_assistant",
    ) ||
    (input.task === "patient_booking" &&
      !hasFeature(entitlements, "ai.scheduling")) ||
    !hasAiProviderMode(entitlements, credential.mode)
  ) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
  if (!taskPolicy.allowedCredentialModes.includes(credential.mode)) {
    throw new AiToolAuthorizationError("lookup_failed", "AI provider mode is not permitted.");
  }
  const attempts: AiUsageAttempt[] = [];
  let fallbackRootAttemptId: string | null = null;
  const providerRequest = {
    route,
    task: input.task,
    surface: input.surface,
    clinicId: input.user.clinicId,
    actorId: input.user.id,
    policyVersion: taskPolicy.version,
  } as const;

  const reservedCostMicros = calculateWorstCaseCostMicros(taskPolicy, route);
  const leaseToken = randomUUID();
  const periodStart = monthStart(now);

  type Reservation = Database["public"]["Functions"]["reserve_ai_budget"]["Returns"][number];
  type ReserveAttempt =
    | { ok: true; reservation: Reservation }
    | { ok: false; allowanceExhausted: boolean; error: AiToolAuthorizationError };

  /**
   * One reservation attempt in a single credential mode.
   *
   * Returns a denial rather than throwing it when the denial is one the ordered
   * resolution above may legitimately answer with a different credential. Every
   * other failure still throws, so nothing about the existing fail-closed
   * behavior is relaxed: an unreachable database, an unentitled clinic, or a
   * duplicate request id ends the turn exactly as before.
   */
  async function attemptReserve(mode: AiCredentialMode): Promise<ReserveAttempt> {
    let legacyLimit = 0;
    // The ai_messages request unit is ClinicFlow's FUNDED-request meter, so it
    // is claimed only by turns ClinicFlow funds. A strict-BYOK turn is bounded
    // instead by the platform fair-use ceiling and the concurrency limit, both
    // enforced inside the reservation transaction. This is the G3 split; see the
    // invariant documented on `AI_ALLOWANCE_INVARIANT` below.
    if (mode !== "byok_strict") {
      try {
        legacyLimit = (await assertAiTurnAllowed(input.user.clinicId, now)).limit;
      } catch (error) {
        if (
          error instanceof AiToolAuthorizationError &&
          error.reason === "usage_limit_reached"
        ) {
          return { ok: false, allowanceExhausted: true, error };
        }
        throw error;
      }
    }
    // Backward-compatible reservation hint only. The RPC resolves the
    // authoritative plan/override limit again inside its own transaction.
    const budgetLimitMicros = Math.max(1, legacyLimit * reservedCostMicros);
    try {
      const result = await reserveAiBudget({
        requestId: input.requestId,
        leaseToken,
        clinicId: input.user.clinicId,
        actorId: input.user.id,
        periodStart,
        surface: input.surface,
        persona: input.persona,
        task: input.task,
        transport: transportForCredentialMode(mode),
        expectedProvider: route.provider,
        expectedModel: route.modelId,
        modelAlias: route.alias,
        fallbackModelAliases: [...taskPolicy.fallbackModelAliases],
        policyVersion: taskPolicy.version,
        certificationVersion: route.certification.version,
        privacyPolicyVersion: taskPolicy.privacyPolicyVersion,
        reservedCostMicros,
        budgetLimitMicros,
        leaseSeconds: RESERVATION_LEASE_SECONDS,
        credentialMode: mode,
      });
      if (result.error) {
        if (isBudgetDenial(result.error.message)) {
          return {
            ok: false,
            allowanceExhausted: isManagedAllowanceExhausted(result.error.message),
            error: new AiToolAuthorizationError("usage_limit_reached"),
          };
        }
        throw result.error;
      }
      const reservation = result.data?.[0];
      if (!reservation?.acquired || !reservation.reservation_id) {
        throw new AiToolAuthorizationError(
          "lookup_failed",
          "This AI request has already been handled or is still in progress.",
        );
      }
      return { ok: true, reservation };
    } catch (error) {
      if (error instanceof AiToolAuthorizationError) throw error;
      Sentry.captureException(error, {
        tags: { area: "ai-budget-reservation" },
        extra: { clinicId: input.user.clinicId, task: input.task, credentialMode: mode },
      });
      throw new AiToolAuthorizationError(
        "lookup_failed",
        "AI usage is temporarily unavailable. Please try again.",
      );
    }
  }

  // ── Ordered provider resolution (G1) ────────────────────────────────────
  //
  // Before P12 an exhausted managed allowance was a dead end: the clinic admin
  // had to log in, open settings, re-authenticate and switch the provider mode
  // by hand before anyone could use AI again — mid-conversation, for a patient
  // on WhatsApp. Resolution is now ordered instead of configured:
  //
  //   allowance available            → ClinicFlow managed Anthropic
  //   allowance exhausted + BYOK key → the clinic's Anthropic key, directly
  //   allowance exhausted, no key    → a clean denial, plus an admin notice
  //
  // The order only ever moves spend AWAY from ClinicFlow. There is no path in
  // which a BYOK clinic is quietly served from the platform's key, and no path
  // that creates paid overage beyond the configured allowance.
  let effectiveMode: AiCredentialMode = credential.mode;
  let resolutionReason: AiProviderResolutionReason = "policy";
  let byokSecret = credential.mode === "managed" ? null : credential.secret;
  let byokProvider = credential.mode === "managed" ? "anthropic" : credential.provider;

  let attempt = await attemptReserve(credential.mode);
  if (!attempt.ok && attempt.allowanceExhausted && credential.mode !== "byok_strict") {
    // `hybrid` degrades to direct-only rather than being denied: its fallback leg
    // is the part that spends ClinicFlow's money, and that is exactly the part
    // there is no longer any allowance for.
    const fallbackReason: AiProviderResolutionReason =
      credential.mode === "hybrid" ? "hybrid_degraded_to_byok" : "auto_byok_fallback";
    const fallback =
      credential.mode === "hybrid"
        ? { provider: credential.provider, connectionId: credential.connectionId, secret: credential.secret }
        : await resolveByokFallbackCredential(input.user.clinicId);
    if (fallback) {
      const retried = await attemptReserve("byok_strict");
      if (retried.ok) {
        effectiveMode = "byok_strict";
        resolutionReason = fallbackReason;
        byokSecret = fallback.secret;
        byokProvider = fallback.provider;
        attempt = retried;
      }
    }
  }

  if (!attempt.ok) {
    // Exhausted and with nowhere safe to go. Deny cleanly, and make sure the
    // clinic's admins are told why — this is the one denial a clinic can
    // actually fix, and silence here is what turns it into a support ticket.
    if (attempt.allowanceExhausted) {
      await notifyAiUsageThresholds({
        clinicId: input.user.clinicId,
        now,
        reason: "denied_exhausted",
      });
    }
    throw attempt.error;
  }
  const reservation = attempt.reservation;

  const provider = effectiveMode === "managed"
    ? resolveManagedProvider().prepare(providerRequest)
    : prepareTenantProvider({
        mode: effectiveMode,
        secret: byokSecret ?? "",
        request: providerRequest,
        async onFallback(errorClass) {
          const audit = await logAiProviderFallback({
            clinicId: input.user.clinicId,
            actorId: input.user.id,
            requestId: input.requestId,
            provider: byokProvider,
            errorClass,
          });
          if (audit.error) throw audit.error;
          const attemptId = randomUUID();
          attempts.push({
            attempt_id: attemptId,
            attempt_sequence: attempts.length,
            fallback_parent_attempt_id: null,
            provider: route.provider,
            model: route.providerModelId,
            model_alias: route.alias,
            input_tokens: null,
            output_tokens: null,
            cached_input_tokens: null,
            cache_write_tokens: null,
            reasoning_tokens: null,
            latency_ms: null,
            status: "failed",
            error_class: errorClass,
            estimated_cost_micros: 0,
            final_cost_micros: 0,
          });
          fallbackRootAttemptId = attemptId;
        },
      });

  let finalized = false;
  let lastObservedAt = Date.now();
  let currentStepStartedAt: number | null = null;

  function beginStep(): void {
    if (finalized) return;
    currentStepStartedAt = Date.now();
  }

  function observeStep(step: AiObservedStep): void {
    if (finalized) return;
    const observedAt = Date.now();
    const latencyStartedAt = currentStepStartedAt ?? lastObservedAt;
    const cost = calculateUsageCostMicros(route.pricing, step.usage);
    attempts.push({
      attempt_id: randomUUID(),
      attempt_sequence: attempts.length,
      fallback_parent_attempt_id: fallbackRootAttemptId,
      provider: step.model.provider || route.provider,
      model: step.response.modelId || step.model.modelId || route.modelId,
      model_alias: route.alias,
      input_tokens: step.usage.inputTokens ?? null,
      output_tokens: step.usage.outputTokens ?? null,
      cached_input_tokens: step.usage.inputTokenDetails.cacheReadTokens ?? null,
      cache_write_tokens: step.usage.inputTokenDetails.cacheWriteTokens ?? null,
      reasoning_tokens: step.usage.outputTokenDetails.reasoningTokens ?? null,
      latency_ms: Math.max(0, observedAt - latencyStartedAt),
      status: stepStatus(step.finishReason),
      error_class: step.finishReason === "error" ? "provider_step_error" : null,
      estimated_cost_micros: cost,
      final_cost_micros: cost,
    });
    currentStepStartedAt = null;
    lastObservedAt = observedAt;
  }

  async function finalize(final: {
    outcome: AiExecutionOutcome;
    errorClass?: string | null;
  }): Promise<void> {
    if (finalized) return;
    finalized = true;
    const errorClass = safeErrorClass(final.errorClass);
    if (attempts.length === 0) {
      attempts.push({
        attempt_id: randomUUID(),
        attempt_sequence: 0,
        fallback_parent_attempt_id: null,
        provider: route.provider,
        model: route.modelId,
        model_alias: route.alias,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        latency_ms: Math.max(0, Date.now() - (currentStepStartedAt ?? lastObservedAt)),
        status: final.outcome,
        error_class: errorClass,
        estimated_cost_micros: 0,
        final_cost_micros: 0,
      });
    } else if (final.outcome !== "success") {
      const terminalSequence = Math.max(...attempts.map((attempt) => attempt.attempt_sequence)) + 1;
      attempts.push({
        attempt_id: randomUUID(),
        attempt_sequence: terminalSequence,
        fallback_parent_attempt_id: attempts.at(-1)?.attempt_id ?? null,
        provider: route.provider,
        model: route.modelId,
        model_alias: route.alias,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        latency_ms: null,
        status: final.outcome,
        error_class: errorClass,
        estimated_cost_micros: 0,
        final_cost_micros: 0,
      });
    }
    const actualCostMicros = attempts.reduce((sum, attempt) => sum + attempt.final_cost_micros, 0);
    const managedCostMicros = attempts.reduce((sum, executionAttempt) => {
      // The EFFECTIVE mode, not the configured one. A turn that fell back to the
      // clinic's own key spends none of ClinicFlow's allowance even though the
      // clinic's policy still says "managed" — and the database enforces exactly
      // that, so computing this from the configured mode would fail the
      // reconciliation closed rather than mis-bill it.
      if (effectiveMode === "byok_strict") return sum;
      // Mirror the database billing-disposition trigger exactly so this
      // application-supplied managed split equals the DB-derived managed_included
      // sum the reconcile wrapper re-derives (a mismatch fails closed). For
      // hybrid, only a successful post-fallback attempt is managed_included;
      // pre-fallback and failed attempts are direct/nonbillable and stay out of
      // ClinicFlow's managed pool.
      if (
        effectiveMode === "hybrid" &&
        (executionAttempt.fallback_parent_attempt_id === null ||
          executionAttempt.status !== "success")
      ) {
        return sum;
      }
      return sum + executionAttempt.final_cost_micros;
    }, 0);
    const reconciliation = {
      reservationId: reservation.reservation_id,
      leaseToken,
      outcome: final.outcome,
      attempts,
      actualCostMicros,
      managedCostMicros,
      errorClass,
    } as const;
    let result = await reconcileAiBudget(reconciliation);
    // The RPC is lease-bound and idempotent. One immediate retry covers a lost
    // response/transient PostgREST failure without risking duplicate events.
    if (result.error) result = await reconcileAiBudget(reconciliation);
    if (result.error) throw result.error;

    // Threshold notices are evaluated after the ledger is authoritative, so the
    // percentage a clinic admin is told matches the one the settings page shows.
    // Best-effort by construction: a notification failure must never fail a turn
    // that already succeeded, and the durable per-period claim means a retry
    // cannot double-notify.
    if (effectiveMode !== "byok_strict") {
      await notifyAiUsageThresholds({
        clinicId: input.user.clinicId,
        now: new Date(),
        reason: "reconciled",
      });
    }
  }

  return {
    ...provider,
    requestId: input.requestId,
    taskPolicy,
    route: { alias: route.alias },
    credentialMode: effectiveMode,
    resolutionReason,
    legacyUsage: {
      used: reservation.legacy_used,
      limit: reservation.legacy_limit,
      remaining: Math.max(0, reservation.legacy_limit - reservation.legacy_used),
    },
    beginStep,
    observeStep,
    finalize,
  };
}
