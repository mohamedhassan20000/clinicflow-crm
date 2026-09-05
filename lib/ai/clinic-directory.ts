/**
 * Clinic-wide department directory scope.
 *
 * A booking target answers "which department is selected for this booking?".
 * This module answers the separate question "which departments does this
 * clinic currently have?".  It is deliberately pure: receipt validation,
 * enforcement, and patient copy depend only on their arguments.
 *
 * ## Where intent actually comes from (P11I-R)
 *
 * The model is the intent classifier. `list_clinic_departments` is mounted for
 * every patient task and is stage-independent, so any wording, in any
 * language, with any typo, can be answered by the model choosing to read the
 * directory. What this module owns is *what the server does with that choice*:
 *
 *   1. **Receipt-triggered authority.** When the complete directory receipt is
 *      in the turn ledger, that receipt owns the department list in the reply.
 *      The trigger is the model's own semantic decision, not the patient's
 *      phrasing, so it holds for wording nobody enumerated.
 *   2. **A receipt-free completeness guard.** No reply may assert that the
 *      clinic's department list is closed ("only", "all", "no others", "غير
 *      متاحة") unless a complete authoritative receipt backs it. This is an
 *      output guard, allow-by-default: it never decides what the patient
 *      meant, it only refuses an unfounded claim about the directory.
 *   3. **A structural fast path**, `isClinicDirectoryQuestion`, whose sole job
 *      is to let the server *force* the read early on the shapes it can prove.
 *      It is an optimisation, never the safety boundary: a miss degrades to
 *      (1) and (2), which are wording-independent. Nothing may be added to it
 *      to make a test pass — the tests are examples, not the lexicon.
 */

import { localizeEntityLabels } from "@/lib/ai/entity-labels";
import type { GroundingLedger } from "@/lib/ai/patient-grounding";

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (pattern: string): RegExp =>
  new RegExp(`${L}(?:${pattern})${R}`, "iu");

/**
 * Question shapes the server can prove without the model.
 *
 * Deliberately narrow and deliberately incomplete. Widening this table is not
 * how new wording gets supported — see the module header. Every entry here is
 * a shape (question word + generic concept), never a clinic, department,
 * specialty, doctor, or alias.
 */
const DIRECTORY_QUESTION_PATTERNS: readonly RegExp[] = [
  // English: complete-list and explicit alternative/challenge shapes.
  /\b(?:what|which)\s+(?:clinic\s+)?(?:departments?|specialt(?:y|ies))\b/i,
  /\b(?:list|show|tell\s+me)\b[^?.!\n]{0,35}\b(?:departments?|specialt(?:y|ies))\b/i,
  /\b(?:departments?|specialt(?:y|ies))\b[^?.!\n]{0,35}\b(?:available|offered|do\s+you\s+have|are\s+there)\b/i,
  /\b(?:other|more|additional)\s+(?:clinic\s+)?(?:departments?|specialt(?:y|ies))\b/i,
  /\b(?:are\s+there|do\s+you\s+have|any)\b[^?.!\n]{0,30}\b(?:other\s+)?(?:departments?|specialt(?:y|ies))\b/i,

  // Arabic. Unicode lookarounds are required because `\b` has no boundary
  // between Arabic letters. No specialty name appears here; only question
  // shapes and the generic concepts "department" / "specialty".
  word(
    "(?:ايه|إيه|ما|ماهي|ما هي|اي|أي|انهي|أنهي)\\s+(?:هي\\s+)?(?:ال)?(?:اقسام|أقسام|تخصصات)",
  ),
  word(
    "(?:ال)?(?:اقسام|أقسام|تخصصات)\\s+(?:الموجودة|الموجوده|المتاحة|المتاحه|عندكم|عندكو|اللي\\s+عندكم)",
  ),
  word(
    "(?:في|فيه|هل\\s+فيه|عندكم|عندكو)\\s+(?:ايه|إيه|اي|أي)?\\s*(?:اقسام|أقسام|تخصصات)",
  ),
  word(
    "(?:مفيش|هل\\s+فيه|فيه|في)\\s+(?:اقسام|أقسام|تخصصات)\\s+(?:تانية|تانيه|اخرى|أخرى|غيرها|غير\\s+كده)",
  ),
  word(
    "(?:اقسام|أقسام|تخصصات)\\s+(?:تانية|تانيه|اخرى|أخرى|إضافية|اضافية|غيرها|غير\\s+كده)",
  ),
];

/**
 * True for clinic-wide directory question shapes the server can prove.
 *
 * A `false` result means "not provable here", **not** "not a directory
 * question". Callers must treat it as a forcing hint only; correctness for
 * unproven wording is owned by `enforceClinicDirectoryReply`.
 */
export function isClinicDirectoryQuestion(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  return DIRECTORY_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

export type ClinicDirectoryDepartment = { id: string; name: string };

type ClinicDirectoryReceipt = {
  scope: "clinic_directory";
  complete: true;
  departments: ClinicDirectoryDepartment[];
  department_count: number;
};

function parseDirectoryReceipt(value: unknown): ClinicDirectoryReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.scope !== "clinic_directory" || row.complete !== true) return null;
  if (!Array.isArray(row.departments)) return null;
  const departments: ClinicDirectoryDepartment[] = [];
  const seen = new Set<string>();
  for (const item of row.departments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const department = item as Record<string, unknown>;
    if (typeof department.id !== "string" || typeof department.name !== "string") {
      return null;
    }
    const id = department.id.trim();
    const name = department.name.trim();
    if (!id || !name || seen.has(id)) return null;
    seen.add(id);
    departments.push({ id, name });
  }
  if (row.department_count !== departments.length) return null;
  return {
    scope: "clinic_directory",
    complete: true,
    departments,
    department_count: departments.length,
  };
}

export function buildClinicDirectoryReply(input: {
  locale: "ar" | "en";
  departments: readonly ClinicDirectoryDepartment[];
}): string {
  const names = localizeEntityLabels(
    input.departments.map((department) => department.name),
    input.locale,
  );
  if (names.length === 0) {
    return input.locale === "ar"
      ? "معلش، مفيش أقسام نشطة ظاهرة في دليل العيادة حاليًا."
      : "Sorry — there are no active departments in the clinic directory right now.";
  }
  const list = names.map((name) => `- ${name}`).join("\n");
  return input.locale === "ar"
    ? `الأقسام النشطة الموجودة في العيادة هي:\n${list}`
    : `The clinic's active departments are:\n${list}`;
}

export type ClinicDirectoryEnforcement = {
  text: string;
  outcome:
    | "passthrough"
    /** A complete receipt backed the turn and owns the department list. */
    | "authoritative"
    /** A directory read was required this turn and no valid receipt came back. */
    | "unavailable"
    /** The draft closed the department list with no receipt entitling it to. */
    | "unfounded_claim";
  departmentCount: number | null;
};

// ---------------------------------------------------------------------------
// Requirement: a closed-list claim needs a complete receipt
// ---------------------------------------------------------------------------

/**
 * The generic concept, in both languages. No specialty name, ever.
 *
 * `عيادات` is included because a clinic's departments are colloquially its
 * clinics; it is still a concept word, not an alias for any one department.
 */
const DEPARTMENT_CONCEPT = new RegExp(
  `(?:\\bdepartments?\\b|\\bspecialt(?:y|ies)\\b|${L}(?:ال)?(?:قسم|اقسام|أقسام|تخصص|تخصصات|عيادات)${R})`,
  "iu",
);

/**
 * Exclusivity markers that close a list wherever they sit in the sentence.
 *
 * Ambiguous high-frequency words are deliberately absent: Egyptian `بس` is
 * usually "but", and a bare `كل` is handled by the adjacency rule below.
 */
const EXCLUSIVITY_MARKERS = new RegExp(
  "(?:\\bonly\\b|\\bsole(?:ly)?\\b|\\bno\\s+other\\b|\\bnone\\s+other\\b|" +
    "\\bnothing\\s+else\\b|\\bnot\\s+available\\b|\\bwe\\s+don'?t\\s+have\\b|" +
    "\\bthere\\s+(?:are|is)\\s+no\\b|" +
    "الوحيد|الوحيده|الوحيدة|فقط|لا\\s+غير|مفيش\\s+غير|مفيش\\s+تاني|مافيش\\s+غير|مافيش\\s+تاني|" +
    "لا\\s+يوجد|لا\\s+توجد|ليس\\s+لدينا|غير\\s+متاح|غير\\s+متاحة|غير\\s+متاحه|" +
    "مش\\s+متاح|مش\\s+متاحة|مش\\s+متاحه|مش\\s+موجود)",
  "iu",
);

/**
 * Totalisers, which only close a list when they attach to the concept itself
 * ("all departments"), not when they merely appear in the same sentence.
 */
const TOTALISER_ADJACENT = new RegExp(
  `(?:\\b(?:all|every|each)\\s+(?:the\\s+|our\\s+|active\\s+|available\\s+)?(?:clinic\\s+)?(?:departments?|specialt(?:y|ies))\\b` +
    `|${L}(?:كل|جميع|كافة)\\s+(?:ال)?(?:اقسام|أقسام|تخصصات|عيادات)${R})`,
  "iu",
);

/**
 * True when the draft tells the patient that the clinic's department list is
 * closed — that one department is the only one, that there are no others, or
 * that it is naming all of them.
 *
 * Allow-by-default and sentence-scoped: an unrelated exclusivity claim ("the
 * only doctor free tomorrow") does not fire, because the concept word is not
 * in the same sentence. This never classifies the patient's message and never
 * decides what the patient wanted; it only inspects a claim we are about to
 * make on the clinic's behalf.
 */
export function assertsClosedDepartmentList(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  for (const sentence of text.split(/[.!?؟\n]+/)) {
    if (!sentence.trim()) continue;
    if (!DEPARTMENT_CONCEPT.test(sentence)) continue;
    if (EXCLUSIVITY_MARKERS.test(sentence)) return true;
    if (TOTALISER_ADJACENT.test(sentence)) return true;
  }
  return false;
}

/**
 * The last word on a reply that touches the clinic's department directory.
 *
 * Three wording-independent rules, in order:
 *
 *   1. A complete receipt in the turn ledger owns the department list. The
 *      model calling `list_clinic_departments` *is* the intent signal, so this
 *      fires for paraphrases, dialects, code-switching and typos alike.
 *   2. A turn the server proved needed the read, that produced no valid
 *      receipt, is answered honestly rather than from booking state.
 *   3. Otherwise the draft passes through — unless it closes the department
 *      list without a receipt entitling it to, which is refused.
 *
 * Rule 1 replaces a true selected department being promoted into "the clinic's
 * only department". Rule 3 is why that promotion is impossible even when no
 * layer above recognised the question.
 */
export function enforceClinicDirectoryReply(input: {
  locale: "ar" | "en";
  latestPatientText?: string | null;
  text: string;
  ledger: GroundingLedger;
}): ClinicDirectoryEnforcement {
  const receipt = parseDirectoryReceipt(
    input.ledger.resultFor("list_clinic_departments"),
  );
  const provenDirectoryShape = isClinicDirectoryQuestion(input.latestPatientText);
  const toolsSeen = input.ledger.toolsSeen();
  // The directory read was the whole turn, so its receipt is the whole answer.
  // When it ran alongside other reads the turn was answering more than the
  // directory, and replacing the reply wholesale would drop that other work;
  // rule 3 still holds the completeness line there.
  const directoryOwnsTurn =
    toolsSeen.length === 1 && toolsSeen[0] === "list_clinic_departments";

  // A closed-list claim *is* a directory answer, however the turn was routed,
  // so a receipt on the turn outranks it rather than merely permitting it.
  if (
    receipt &&
    (directoryOwnsTurn ||
      provenDirectoryShape ||
      assertsClosedDepartmentList(input.text))
  ) {
    return {
      text: buildClinicDirectoryReply({
        locale: input.locale,
        departments: receipt.departments,
      }),
      outcome: "authoritative",
      departmentCount: receipt.department_count,
    };
  }

  if (provenDirectoryShape && !receipt) {
    return {
      text: directoryUnavailableText(input.locale),
      outcome: "unavailable",
      departmentCount: null,
    };
  }

  // Wording-independent backstop. Nothing above needed to understand the
  // patient's phrasing for this to hold: a closed-list claim about departments
  // requires a complete authoritative directory receipt, full stop.
  if (!receipt && assertsClosedDepartmentList(input.text)) {
    return {
      text: directoryUnavailableText(input.locale),
      outcome: "unfounded_claim",
      departmentCount: null,
    };
  }

  return { text: input.text, outcome: "passthrough", departmentCount: null };
}

function directoryUnavailableText(locale: "ar" | "en"): string {
  return locale === "ar"
    ? "معلش، مش قادر أقرأ دليل أقسام العيادة دلوقتي. تقدر تحاول تاني بعد شوية أو تتواصل مع موظفي العيادة."
    : "Sorry — I cannot read the clinic department directory right now. Please try again shortly or contact clinic staff.";
}
