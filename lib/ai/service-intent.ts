/**
 * Item #2 — "is this patient asking what we do and what it costs?", asked once.
 *
 * ## The defect this exists for
 *
 * Two modules already answered a version of this question and neither knew
 * about the other: `SERVICE` in `patient-turn-intent.ts`, which decides the
 * turn topic, and the price/service patterns in `clinic-information-intent.ts`,
 * which decide whether a booking tool may be withheld. Both were keyword lists
 * grown one manual-QA report at a time, and both had the same hole: they
 * recognised the *noun* ("خدمات", "أسعار", "services") and not the *question*.
 *
 * So "بتقدموا إيه؟" — one of the most common ways an Egyptian patient opens a
 * conversation — matched nothing at all. `classifyPatientTurn` returned
 * `topic: "other"` with `informationalOnly: false`, `resolveBookingAuthority`
 * saw a thread with no collected data and pinned `prepare_booking` at the
 * `department` rung, and a question about what the clinic offers was answered
 * with the opening move of a booking funnel. Meanwhile "ممكن أعرف الخدمات
 * والأسعار؟" hit the noun and reached the services tool. Same intent, two
 * paths, and the difference was which words the patient happened to choose.
 *
 * This module is that decision, stated once, and both callers now read it.
 *
 * ## The two rules it keeps
 *
 * 1. **No clinic vocabulary.** Not one department, specialty, service or price
 *    appears here. It reads question shapes over generic commercial concepts —
 *    what do you offer, what does it cost — so a clinic that added a department
 *    this morning behaves exactly like one that has had it for a decade. The
 *    actual roster and the actual numbers come from the database, every time.
 *
 * 2. **A booking frame is not this module's business.** `isServiceInquiry`
 *    answers only "is the services/prices concept present?". Whether a booking
 *    verb outranks it stays where it already was, in
 *    `clinic-information-intent.ts`, which checks its booking patterns first and
 *    is the only caller that needs that asymmetry. Putting the booking check
 *    here too would mean two places could disagree about it — the exact failure
 *    being removed.
 */

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (pattern: string): RegExp => new RegExp(`${L}(?:${pattern})${R}`, "iu");

/**
 * The concept named outright: services, prices, cost, fees.
 *
 * These are the shapes both predecessors already had, kept verbatim so nothing
 * that was recognised before stops being recognised now.
 */
const SERVICE_CONCEPT: readonly RegExp[] = [
  word("خدمات|الخدمات|خدمة|الخدمة|خدماتكم|خدماتكو"),
  word("سعر|السعر|أسعار|اسعار|الأسعار|الاسعار|أسعاركم|اسعاركم|بكام|كام|تكلفة|التكلفة|تكاليف"),
  /\b(?:services?|prices?|pricing|price\s*list|cost|costs|fee|fees|charges?|tariffs?|rates?)\b/i,
  /\bhow\s+much\b/i,
];

/**
 * The concept asked *about the clinic* without naming it: "what do you offer?",
 * "بتقدموا إيه؟", "بتعملوا إيه؟", "عندكم إيه؟".
 *
 * This is the half neither predecessor had, and the half manual QA tripped on.
 * Deliberately requires the second-person clinic frame — a bare "إيه؟" is not a
 * services question and never reaches here.
 */
const OFFERING_SHAPE: readonly RegExp[] = [
  // «بتقدموا إيه» / «بتعملوا إيه» / «بتشتغلوا في إيه» — verb first, then the
  // interrogative, in either order, because both are said.
  new RegExp(
    `${L}(?:بتقدمو|بتقدموا|بتقدم|تقدمو|تقدموا|بتعملو|بتعملوا|بتعمل|بتشتغلو|بتشتغلوا|بتوفرو|بتوفروا|بتقدّمو|بتقدّموا)${R}` +
      `[\\s\\S]{0,20}${L}(?:ايه|إيه|إيهي|ايهي|ماذا|ما)${R}` +
      `|${L}(?:ايه|إيه|ماذا)${R}[\\s\\S]{0,20}${L}(?:بتقدمو|بتقدموا|بتعملو|بتعملوا|بتوفرو|بتوفروا)${R}`,
    "iu",
  ),
  // «عندكم إيه» / «فيه عندكم إيه» — what have you got.
  new RegExp(
    `${L}(?:عندكم|عندكو|لديكم|عندكن)${R}[\\s\\S]{0,12}${L}(?:ايه|إيه|ماذا|ما)${R}` +
      `|${L}(?:ايه|إيه|ماذا)${R}[\\s\\S]{0,12}${L}(?:عندكم|عندكو|لديكم)${R}`,
    "iu",
  ),
  /\bwhat\s+(?:do|can)\s+you\s+(?:offer|do|provide)\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:available|on\s+offer)\b/i,
];

/**
 * Is this message asking what the clinic offers, or what it charges?
 *
 * `true` is used only to *route* — to the services tool, and to withhold a
 * forced booking tool. It never unlocks a write, never names a service and
 * never produces a price; every number the patient sees comes from the clinic's
 * own configuration on the turn.
 */
export function isServiceInquiry(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  return (
    SERVICE_CONCEPT.some((pattern) => pattern.test(text)) ||
    OFFERING_SHAPE.some((pattern) => pattern.test(text))
  );
}

/**
 * The scope a patient named for a services question, when they named one.
 *
 * `"all"` for "كلهم" / "كل الأقسام" / "all departments" and their ordinary
 * variants; `null` for everything else, *including* a department name — naming
 * a department is a job for the clinic's own directory resolver
 * (`resolveNamedEntity`), which is the only thing that may decide which
 * department a word means. This function must never learn a department name.
 */
export function readServiceScope(
  value: string | null | undefined,
): "all" | null {
  const text = (value ?? "").trim().toLocaleLowerCase();
  if (!text) return null;
  const everyWord =
    /(?:^|\s)(?:كلهم|كلها|كلهن|الكل|جميعها|جميعهم)(?:\s|$|[.!؟?])|^(?:all|everything|both)$/u;
  if (everyWord.test(text)) return "all";
  const everyDepartment = new RegExp(
    `(?:all|every|each|كل|جميع|كافة)[\\s\\S]{0,24}(?:departments?|specialt(?:y|ies)|الأقسام|الاقسام|العيادات)` +
      `|(?:departments?|الأقسام|الاقسام|العيادات)[\\s\\S]{0,24}(?:all|every|each|كل|جميع|كافة)`,
    "iu",
  );
  return everyDepartment.test(text) ? "all" : null;
}
