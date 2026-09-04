/**
 * F-1 — the closed world for services, prices and insurers.
 *
 * ## The defect
 *
 * `checkDoctorGrounding` enforces a closed world for **doctors**, and for
 * doctors only. `enforcePatientFactReply` does render services and insurance
 * deterministically — but only when `list_department_services` /
 * `list_clinic_insurance` actually ran on that turn. A turn where the model
 * answers a price question *without* calling the tool had no gate at all, and
 * the acceptance pass watched this reach the patient unchanged:
 *
 *     "Botox Package بـ2499 جنيه، وباقة التقشير بـ777 جنيه. وطبعًا بنقبل Bupa Global."
 *
 * None of those services, prices or insurers exists in the clinic's
 * configuration. A price is the worst of the three: it is quoted, screenshotted
 * and treated as a commitment, and unlike a doctor's name the patient has no
 * way to notice it is wrong. Insurance acceptance is the same class of claim.
 *
 * ## The rule, which is the doctor rule
 *
 * A reply may quote a price, or state that the clinic does or does not work
 * with an insurer, **only from a ledger entry**. Same two readings as rule (3)
 * of `checkDoctorGrounding`:
 *
 *   * with **no** receipt for the relevant tool, *any* such claim is unbacked
 *     by construction — there is no true way to answer "how much?" without
 *     reading what the clinic charges;
 *   * with a receipt, every quoted price must be one the receipt contained.
 *
 * ## What it deliberately does not do
 *
 * It does not try to recognise an invented *service name* as invented. Naming a
 * service is only a commercial claim when it carries a price or an acceptance,
 * and both of those are caught above — so the invented name goes with the
 * replaced sentence rather than needing a name-shape heuristic that would have
 * to be right about arbitrary noun phrases in two languages.
 *
 * It also says nothing about a reply that merely *mentions* money or insurance
 * without asserting anything: «تحب أعرفلك أسعار أنهي قسم؟» and «تقدر تتواصل مع
 * العيادة لتأكيد التأمين» are questions and deferrals, not claims, and
 * replacing them would be a regression for no gain.
 *
 * Pure. No database, no clock, no `server-only`.
 */

export type CommercialViolationSource =
  /** A price quoted with no services receipt behind it at all. */
  | "unbacked_price"
  /** A price quoted that the receipt does not contain. */
  | "unlisted_price"
  /** An insurer accepted or refused with no insurance receipt behind it. */
  | "unbacked_insurer";

export type CommercialViolation = {
  mention: string;
  source: CommercialViolationSource;
};

export type CommercialGroundingCheck = {
  grounded: boolean;
  violations: readonly CommercialViolation[];
};

/**
 * Spans that are numbers but are never prices, removed before anything is read.
 *
 * ISO dates, clock times, phone numbers and the clinic's emergency number all
 * carry three-to-five digit runs, and every one of them appears in copy this
 * product composes itself.
 */
const NON_PRICE_SPANS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/g,
  /\d{1,2}\s*[:.]\s*\d{2}/g,
  /[+]\d[\d\s()-]{6,}/g,
  /\b\d{6,}\b/g,
];

/** Currency the clinics this product serves actually quote in, plus the symbols. */
const CURRENCY =
  "(?:جنيه(?:ًا|ا)?|ج\\.?م|جم|ريال(?:ات)?|درهم|دينار|دولار|يورو|" +
  "egp|le|sar|aed|kwd|qar|bhd|omr|usd|eur|gbp|\\$|£|€)";

/** Frames that make the number next to them a price rather than a quantity. */
const PRICE_FRAME =
  "(?:سعر|السعر|بسعر|أسعار|اسعار|تكلفة|التكلفة|بتكلفة|رسوم|الرسوم|بمبلغ|" +
  "price|cost|costs|fee|fees|charge|charges|for)";

/**
 * The numbers this reply is quoting as money.
 *
 * Adjacency is required in both directions and is deliberately tight: a number
 * touching a currency word ("400 جنيه", "EGP 400"), or a number introduced by a
 * price frame ("السعر 400", "بـ400"). A bare number with none of that is not a
 * price, which is what keeps this off the booking receipt, the opening hours
 * and the clinic's own phone number.
 */
export function quotedPrices(text: string): number[] {
  let scrubbed = text;
  for (const span of NON_PRICE_SPANS) scrubbed = scrubbed.replace(span, " ");
  // Anchored on both sides: without `(?!\\d)` the grouped alternative matched
  // the first three digits of "2499" and reported a price of 249.
  const number =
    "(?<!\\d)(\\d{1,3}(?:[,\\s]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)(?!\\d)";
  const patterns = [
    new RegExp(`${number}\\s*${CURRENCY}`, "giu"),
    new RegExp(`${CURRENCY}\\s*${number}`, "giu"),
    new RegExp(`${PRICE_FRAME}[^\\d\\n]{0,12}${number}`, "giu"),
    // "بـ400" / "ب 400" — the Arabic price preposition, which is how a price is
    // most often actually written and carries no currency word of its own.
    new RegExp(`(?:^|[\\s،,(])بـ?\\s?${number}`, "gu"),
  ];
  const found = new Set<number>();
  for (const pattern of patterns) {
    for (const match of scrubbed.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const value = Number(raw.replace(/[,\s]/g, ""));
      // Sub-hundred numbers are counts far more often than prices ("٣ أيام",
      // "خصم ١٠"), and no clinic in this product's markets prices a service
      // below one currency unit's worth of noise.
      if (Number.isFinite(value) && value >= 100) found.add(value);
    }
  }
  return [...found];
}

/**
 * Does this reply assert that the clinic does, or does not, work with an
 * insurer?
 *
 * An *assertion*, not a mention. The frames below are all transitive: they take
 * an insurer as their object. A reply that says the clinic's insurance list
 * exists, or offers to check it, matches none of them.
 */
const INSURANCE_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:بنقبل|بيقبل|بنتعامل\s*مع|نتعامل\s*مع|متعاقد(?:ين)?\s*مع|بنشتغل\s*مع|مقبول(?:ة|ه)?\s*عندنا|بتغطي|يغطي|تغطي|مغطى)/u,
  /(?:مش|غير|لا)\s*(?:بنقبل|نقبل|بنتعامل|متعاقدين)/u,
  /\b(?:we|the\s+clinic)\s+(?:do|does)?\s*(?:not\s+)?(?:accepts?|takes?|works?\s+with|covers?)\b/i,
  /\b(?:is|are)\s+(?:not\s+)?(?:accepted|covered|in[-\s]network)\b/i,
  /\b(?:we\s+are\s+(?:not\s+)?(?:contracted|in[-\s]network)\s+with)\b/i,
];

export function hasInsuranceAcceptanceClaim(text: string): boolean {
  return INSURANCE_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function checkCommercialGrounding(input: {
  text: string;
  /** Prices the server returned this turn. */
  allowedPrices: readonly number[];
  /** Whether a services/pricing tool returned this turn. */
  sawServices: boolean;
  /** Whether the insurance tool returned this turn. */
  sawInsurers: boolean;
}): CommercialGroundingCheck {
  const text = (input.text ?? "").trim();
  if (!text) return { grounded: true, violations: [] };
  const violations: CommercialViolation[] = [];

  const allowed = new Set(input.allowedPrices.filter((n) => Number.isFinite(n)));
  for (const price of quotedPrices(text)) {
    if (allowed.has(price)) continue;
    violations.push({
      mention: String(price),
      source: input.sawServices ? "unlisted_price" : "unbacked_price",
    });
  }

  if (!input.sawInsurers && hasInsuranceAcceptanceClaim(text)) {
    violations.push({ mention: "insurance", source: "unbacked_insurer" });
  }

  return { grounded: violations.length === 0, violations };
}

/**
 * The true sentence for a turn whose commercial claim could not be backed.
 *
 * It does not guess a price, does not name a service and does not name an
 * insurer — there is nothing authoritative available to name — and it ends on
 * the question that gets the patient an answer on the next turn, which is the
 * whole difference between a correction and a dead end.
 */
export function buildDeterministicCommercialReply(input: {
  locale: "ar" | "en";
  kind: "price" | "insurance";
}): string {
  const ar = input.locale === "ar";
  if (input.kind === "insurance") {
    return ar
      ? "شركات التأمين اللي العيادة متعاقدة معاها متسجلة في إعدادات العيادة، ومحتاج أراجعها قبل ما أأكدلك حاجة. تحب أشوفلك القايمة؟"
      : "The insurers this clinic works with are held in the clinic's own settings, and I need to check them before I confirm anything. Would you like me to look up the list?";
  }
  return ar
    ? "الأسعار بتتقرا من إعدادات العيادة، ومحتاج أراجعها قبل ما أقولك رقم. تحب تعرف خدمات وأسعار أنهي قسم؟"
    : "Prices are read from the clinic's own settings, and I need to check them before I quote you a number. Which department's services and prices would you like?";
}

/** The correction handed to the model for its one regeneration attempt. */
export function buildCommercialCorrection(input: {
  locale: "ar" | "en";
  violations: readonly CommercialViolation[];
}): string {
  const kinds = new Set(input.violations.map((item) => item.source));
  const ar = input.locale === "ar";
  const parts: string[] = [];
  if (kinds.has("unbacked_price") || kinds.has("unlisted_price")) {
    parts.push(
      ar
        ? "ردّك ذكر سعرًا لم تُعِده أداة العيادة في هذا الدور."
        : "Your reply quoted a price no clinic tool returned on this turn.",
    );
  }
  if (kinds.has("unbacked_insurer")) {
    parts.push(
      ar
        ? "وذكر قبول أو رفض شركة تأمين بدون قراءة قائمة العيادة."
        : "It stated that an insurer is or is not accepted without reading the clinic's list.",
    );
  }
  parts.push(
    ar
      ? "أعد صياغة الرد بدون أي سعر وبدون تأكيد أي شركة تأمين، واسأل المريض عن القسم اللي يحب يعرف خدماته."
      : "Rewrite the reply with no price and no insurer confirmation, and ask which department's services they want.",
  );
  return parts.join(" ");
}
