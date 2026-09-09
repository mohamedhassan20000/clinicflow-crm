/**
 * Deterministic human-escalation detection for the patient WhatsApp agent
 * (§6.2, §6.5). Runs on the raw inbound message *before* any model call, so
 * emergencies, explicit human-handoff requests, and complaints never depend on
 * the LLM behaving. The model is a second line of defense (the patient prompt
 * refuses medical advice), never the first.
 *
 * This is intentionally keyword-based and cheap: getting it wrong is safe in
 * one direction (a missed keyword still runs the ordinary agent, which refuses
 * and can be escalated on low confidence) and useful in the other (a matched
 * emergency word routes straight to the canned safety response with no model in
 * the loop). Patient text is untrusted; matching a substring never grants any
 * capability — it only selects a canned response and flags the conversation.
 *
 * ## P11C — the asymmetry that shapes the medical class
 *
 * The sentence above ("getting it wrong is safe in one direction") was true of
 * emergencies and false of everything else, and the difference cost a real
 * booking. A patient wrote:
 *
 *     بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي
 *     ("shall we continue? I want to book physical therapy for my son")
 *
 * `MEDICAL_PATTERNS` contained the bare noun `علاج` — "treatment" — which is
 * also half of what this clinic calls a department. The thread was handed to a
 * human before the agent ran, on a message that was a *booking request for a
 * third party*, which is a fully supported path. The same word had already done
 * the same thing sixteen hours earlier on the bare message "علاج طبيعي", which
 * is where that conversation's escalation latch came from in the first place.
 *
 * A false escalation is **not** recoverable in the direction the old comment
 * assumed. `runPatientInboundAiReply` returns `already_escalated` for every
 * subsequent message until a staff member presses "return to AI" in the inbox.
 * A *missed* pre-model escalation, by contrast, still meets the agent, whose
 * prompt refuses clinical advice and whose low-confidence path escalates.
 * Pre-model detection is fail-fast with an irreversible consequence; the model
 * layer is fail-safe. So this file fires only on signals that are unambiguous
 * without knowing anything about the clinic.
 *
 * The structural rule that follows, and the invariant the regression rests on:
 *
 *   **A clinical noun is a topic. Escalation is about the *ask*.**
 *
 * `علاج`, `treatment`, `دواء`, `symptom`, `جرعة` name subjects. Naming a subject
 * is what a patient does when choosing a department, asking a price, or booking.
 * Only a request for a *judgment* — "should I take", "what's wrong with me",
 * "شخص حالتي" — is a medical escalation on its own. A topic escalates solely
 * when an advice frame is wrapped around it and no logistics frame is, and never
 * when the word is part of what this clinic calls one of its own departments.
 *
 * Nothing here names a department, a specialty, a service or a doctor. The
 * clinic vocabulary is supplied by the caller from live `departments` rows and
 * is used only to *withhold* a signal, never to produce one — and never for the
 * emergency or human-request classes, which are read from the raw text so that
 * a clinic which happens to name a department "Emergency" cannot blind them.
 */

import {
  buildClinicVocabulary,
  maskClinicVocabulary,
} from "@/lib/ai/entity-resolution";

export type PatientEscalationReason =
  | "emergency"
  | "human_requested"
  | "medical"
  | "complaint"
  | "low_confidence"
  | "agent_error";

export type PatientEscalationDetection = {
  escalate: boolean;
  reason: PatientEscalationReason | null;
  /** Emergencies get the safety canned response with the local emergency number. */
  emergency: boolean;
};

// Life-safety terms. Ordered priority: an emergency always wins over any other
// signal in the same message.
const EMERGENCY_PATTERNS: readonly RegExp[] = [
  /\b(emergency|ambulance|urgent(ly)?|life[-\s]?threatening)\b/i,
  /\b(chest\s*pain|can'?t\s*breathe|not\s*breathing|difficulty\s*breathing|shortness\s*of\s*breath)\b/i,
  /\b(heart\s*attack|stroke|seizure|unconscious|fainted|overdose|poison(ing)?)\b/i,
  /\b(severe\s*bleeding|bleeding\s*heavily|hemorrhage|suicid(e|al)|kill\s*myself|self[-\s]?harm)\b/i,
  /(طوار[ئي]|إسعاف|اسعاف|إسعافات|نجدة|خطر\s*على\s*الحياة)/,
  /(ألم\s*في\s*الصدر|الم\s*في\s*الصدر|ما\s*أقدر\s*أتنفس|صعوبة\s*في\s*التنفس|ضيق\s*تنفس|لا\s*أستطيع\s*التنفس)/,
  /(نوبة\s*قلبية|سكتة|تشنج|إغماء|اغماء|فاقد\s*الوعي|جرعة\s*زائدة|تسمم)/,
  /(نزيف\s*(شديد|حاد|غزير)|انتحار|أنتحر|اؤذي\s*نفسي|إيذاء\s*النفس)/,
];

// Explicit request to reach a human. Handled as a plain handoff, no safety copy.
//
// Unambiguous on its own: a verb of *contact* aimed at a person, or a noun that
// can only mean clinic staff. Never suppressed by anything.
/**
 * F-5 — the Arabic transfer/contact frames, kept apart so the person-noun
 * alternation is written once.
 *
 * The gap the acceptance pass found was one missing spelling: the old list
 * matched `أحد` and `احد` but not the bare `حد`, which is the *only* way an
 * Egyptian actually writes it — "وصلني بحد من العيادة", "حولني لحد". The noun
 * therefore carries its own boundary rather than being dropped into the
 * alternation raw: `حد` is a substring of `محدد`, `واحد` and `الحدود`, and
 * "اتحدث عن موعد محدد" must not read as a handoff request. `PERSON_NOUN` allows
 * only the prepositional prefixes a patient actually types (بـ / لـ / و) and
 * refuses any Arabic letter on either side.
 *
 * `العيادة` and `الاستقبال` are in the noun set for the same reason `the clinic`
 * is in the English one: "وصلني بالعيادة" is a request to reach the people at
 * the clinic, and the transfer verb in front of it is what makes that
 * unambiguous. A bare mention of the clinic is not matched by anything here.
 */
const AR_LETTER = "\\u0621-\\u064A\\u0670-\\u06D3";
const PERSON_NOUN =
  `(?<![${AR_LETTER}])[بلو]?(?:موظف|موظفة|شخص|بشري|إنسان|انسان|أحد|احد|حد|` +
  `الاستقبال|استقبال|العيادة|عيادة|فريق|حضرتك)(?![${AR_LETTER}])`;
const TRANSFER_VERB =
  "كلم|أكلم|اكلم|اتكلم|أتكلم|أتحدث|اتحدث|تحويلي|حولني|حوّلني|حولوني|وصلني|وصّلني|" +
  "وصلوني|ربطني|اربطني|ادّيني|اديني|رجعني|سلمني";

const ARABIC_HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:${TRANSFER_VERB})\\s*.{0,20}${PERSON_NOUN}`, "u"),
  /(موظف\s*(حقيقي|بشري)|خدمة\s*العملاء|مع\s*موظف|مع\s*انسان|مع\s*إنسان)/,
  // "someone answer me / put a person on this" — a person as the *subject* of a
  // contact verb, which no booking sentence ever produces.
  /(حد|أحد|احد|موظف|شخص|انسان|إنسان)\s*(يرد|يكلمني|يكلمنى|يتواصل|يساعدني|يساعدنى|يتكلم)/,
  // P12B — "I want to *speak to* a person", with the person as the object of a
  // speaking verb. Previously this shape reached only the weak class, so
  // «عايز أكلم موظف» was an escalation *by default* rather than by rule and
  // any suppression added to the weak class would have taken it with it. As a
  // strong pattern it is unconditional, which is what makes it safe to teach
  // the weak class about beneficiaries below.
  /(?:أكلم|اكلم|اتكلم|أتكلم|احكي|أحكي|اتواصل|أتواصل)\s*(?:مع\s*)?(?:ال)?(?:موظف|موظفة|شخص|حد|أحد|احد|انسان|إنسان|بشري|استقبال|ريسبشن)/u,
];

const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(speak|talk|chat|connect)\s*(to|with)?\s*(a\s*)?(human|person|agent|staff|receptionist|representative|someone|real\s*person|somebody)\b/i,
  /\b(human|real\s*person|live\s*agent|customer\s*service)\b/i,
  // F-5 — "connect me to someone" and its transfer-verb family, in English.
  // `put me through`, `transfer me`, `get me` all take a person as their object
  // in exactly the same way `connect me to` does, and a clinic noun ("the
  // clinic", "reception", "the front desk") is as much a request for a human as
  // the word "human" is: no booking sentence asks to be *put through* to
  // anything.
  /\b(?:put\s*me\s*(?:through|in\s*touch)|transfer\s*me|patch\s*me\s*(?:through|in)|connect\s*me|hand\s*me\s*(?:over|off))\b[^.\n?]{0,30}\b(?:someone|somebody|a\s*person|a\s*human|staff|reception(?:ist)?|front\s*desk|the\s*clinic|clinic\s*team|an?\s*agent)\b/i,
  /\b(?:i\s*(?:want|need)\s*(?:to\s*)?(?:speak|talk)\s*(?:to|with)|can\s*i\s*(?:speak|talk)\s*(?:to|with))\b[^.\n?]{0,30}\b(?:reception(?:ist)?|front\s*desk|the\s*clinic|clinic\s*team|somebody|someone)\b/i,
  ...ARABIC_HUMAN_REQUEST_PATTERNS,
];

/**
 * P11C — "I want … a person", which is a handoff request in most sentences and
 * a *third-party booking* in the rest.
 *
 * `عايز احجز لشخص تاني` ("I want to book for another person") matched the old
 * unconditional version of this pattern through the bare noun `شخص`, and
 * `لشخص تاني` is one of the exact continuation phrases third-party booking is
 * supposed to accept. `عايز حد يرد عليا` is genuinely a handoff and is caught by
 * `HUMAN_REQUEST_PATTERNS` above; what is left here is the shape that cannot
 * tell the two apart from the noun alone, so it defers to the logistics frame
 * exactly as a bare clinical topic does. Same rule, second application: a
 * generic noun is not an ask.
 */
const HUMAN_REQUEST_WEAK_PATTERNS: readonly RegExp[] = [
  /(أريد|اريد|ابغى|أبغى|بدي|عايز|عاوز|ممكن)\s*.{0,20}(موظف|شخص|إنسان|انسان|بشري|أحد|احد|حد)/,
];

/**
 * P12B — the beneficiary frame, and the second reason a generic person-noun is
 * not an ask.
 *
 * The weak pattern above defers to {@link LOGISTICS_FRAME_PATTERNS}, and that
 * was enough while every third-party sentence carried a booking word. Manual QA
 * produced the sentences that do not: «ممكن لشخص تاني» and «عايز لحد تاني» are
 * *answers to the assistant's own question* — «الحجز ده ليك إنت ولا لحد تاني؟»
 * — and a two-word answer carries no logistics word at all. «عايز أعمل ملف
 * لشخص تاني» and «عايز اسجل بيانات شخص تاني» are the same shape one step
 * further on. Every one of them matched `عايز` + `شخص|حد` with nothing to
 * suppress it, so a patient answering a question the assistant had just asked
 * was escalated to a human before the engine ever saw the turn.
 *
 * The fix is the same rule applied a third time rather than a keyword
 * exception: a generic person-noun is not an ask when the sentence supplies a
 * frame that explains it. `لـ` + a person is the *beneficiary* frame — a person
 * something is being done **for**, not a person to be talked **to** — and it is
 * exactly the preposition that separates «احجز **لـ**شخص تاني» from «كلمني
 * **مع** شخص». Kinship terms are here for the same reason and with no
 * preposition required: «أخويا» names who the appointment is for and can never
 * name a receptionist.
 *
 * This suppresses only the weak class. `HUMAN_REQUEST_PATTERNS` — «وصلني بحد»,
 * «عايز حد يرد عليا», «مع موظف», "speak to a human" — is matched first, is
 * unguarded, and is untouched: a person as the object of a transfer verb or the
 * subject of a contact verb stays an escalation whatever else is in the
 * sentence.
 */
const BENEFICIARY_FRAME_PATTERNS: readonly RegExp[] = [
  // "for <a person>" — the preposition is the whole signal, in either spelling
  // of the noun, with or without the definite article.
  // `\b` is ASCII-only in JavaScript and never matches beside an Arabic letter,
  // so the boundary is written out: start of string or a space/punctuation.
  /(?:^|[\s،,.!؟?])ل\s?(?:ال)?(?:حد|أحد|احد|شخص|إنسان|انسان|واحد|واحدة|مريض|مريضة)/u,
  // "another person" / "someone else" as a bare noun phrase — the answer to
  // «الحجز ده ليك إنت ولا لحد تاني؟» written without the preposition. Safe to
  // suppress because a person somebody wants to *talk to* now reaches the
  // strong class through the speaking-verb pattern above.
  /(?:^|[\s،,.!؟?])(?:ال)?(?:حد|أحد|احد|شخص|واحد|واحدة|مريض|مريضة)\s+(?:تاني|تانية|تانى|آخر|اخر|أخرى|اخرى)/u,
  // Kinship and relation nouns. Whoever this is, it is not clinic staff.
  /(أخويا|اخويا|أختي|اختي|ابني|إبني|بنتي|مراتي|زوجتي|جوزي|زوجي|والدي|والدتي|أبويا|ابويا|أمي|امي|صاحبي|صاحبتي|قريبي|حماتي|جدي|جدتي)/u,
  // English equivalents of both.
  /\bfor\s+(?:someone|somebody|another\s+person|a\s+friend|my\s+(?:son|daughter|wife|husband|mother|father|brother|sister|friend|relative))\b/i,
];

// ---------------------------------------------------------------------------
// The medical class, in three parts (P11C)
// ---------------------------------------------------------------------------

/**
 * Requests for a clinical *judgment*. These escalate on their own, in any
 * context, and are never suppressed by clinic vocabulary or by a booking.
 *
 * Every entry here is a patient asking somebody to decide something about their
 * body — not a patient naming a subject. That is the whole membership test.
 */
const CLINICAL_JUDGMENT_PATTERNS: readonly RegExp[] = [
  /\b(diagnos(e|is|ed)\s*(me|my|this|it)|please\s*diagnos(e|is))\b/i,
  /\b(should\s*i\s*(take|stop|use|start|continue|keep|switch|double|skip))\b/i,
  /\b(what('?s|\s*is)\s*wrong\s*with\s*me|what\s*do\s*i\s*have|am\s*i\s*(ok|okay|dying|sick))\b/i,
  /\bis\s*(it|this|that|he|she|they)\s*(serious|dangerous|normal|contagious|life[-\s]?threatening)\b/i,
  /\b(what|which|how\s*much|how\s*many)\s+(\w+\s+){0,3}?(dose|dosage|medication|medicine|pills?|tablets?|prescription|antibiotics?)\b/i,
  /(شخص\s*حالتي|شخصلي|هل\s*(هذا|هي|ده|دي)\s*خطير)/,
  /(هل\s*آخذ|هل\s*اخذ|هل\s*أتوقف|هل\s*اتوقف|اوقف\s*الدوا|أوقف\s*الدوا)/,
  /(ايش\s*فيني|إيش\s*فيني|ايه\s*اللي\s*فيا|إيه\s*اللي\s*فيا|ايش\s*مرضي|إيش\s*مرضي|ما\s*هو\s*مرضي|انا\s*مرضي\s*ايه)/,
];

/**
 * Clinical *topics*. A topic is a subject a patient may name for any number of
 * innocent reasons — booking it, pricing it, asking where it is — so a topic on
 * its own is never an escalation. It is one of two required ingredients.
 */
const CLINICAL_TOPIC_PATTERNS: readonly RegExp[] = [
  /\b(diagnos(e|is|ed)|prescrib(e|ption)|dosage|dose|medication|medicine|symptoms?|treatment|therapy)\b/i,
  /(تشخيص|وصفة|وصفه|جرعة|جرعه|دواء|الدواء|ادوية|أدوية|أعراض|اعراض|علاج|العلاج)/,
];

/**
 * The other required ingredient: the patient is asking for something to be
 * decided, or reporting their own condition.
 *
 * Shape only. There is not one clinical word, department, specialty or service
 * name in this list, which is what keeps the classifier department-agnostic.
 */
const ADVICE_FRAME_PATTERNS: readonly RegExp[] = [
  /\b(what|which|why|how|should|shall|could|is\s*it|are\s*they|do\s*i|does\s*it|will\s*it)\b/i,
  /(^|[\s،,.!؟?])(ايه|إيه|أيه|ايش|إيش|شو|هل|ليه|لماذا|ازاي|إزاي|كيف|ماذا|ما\s*هو|ماهو)([\s،,.!؟?]|$)/,
  /\b(i\s*(have|feel|am|got|took|need)|my\s+\p{L}+\s+(hurts?|aches?))\b/iu,
  /(^|[\s،,.!؟?])(عندي|عندى|بعاني|باعاني|بعانى|بيوجعني|بيوجعنى|وجعني|حاسس|حاسه|حاسة|تعبان|تعبانة|تعبانه|مريض|مريضة|واخد|باخد|بشرب)([\s،,.!؟?]|$)/,
];

/**
 * The disqualifier: this message is about arranging or pricing a visit.
 *
 * A logistics frame cannot suppress `CLINICAL_JUDGMENT_PATTERNS` — "I want to
 * book, and also should I stop my tablets?" still escalates — it only stops a
 * bare topic word from being read as an ask. Booking, pricing and opening hours
 * are the three things a patient names a department in order to do.
 */
const LOGISTICS_FRAME_PATTERNS: readonly RegExp[] = [
  /\b(book|booking|appointment|appointments|schedule|rescheduling|reschedule|reserve|reservation|slot|slots|availab(le|ility)|price|prices|cost|costs|fee|fees|how\s*much|open|opening|hours)\b/i,
  /(احجز|أحجز|اححز|حجز|حجزت|نحجز|يحجز|موعد|مواعيد|ميعاد|معاد|سعر|أسعار|اسعار|تكلفة|بكام|كام|متاح|متاحين|المتاحين|مفتوح|مواعيدكم|نكمل|أكمل|اكمل)/,
  // P12B — opening a file is arranging a visit. «عايز اسجل بيانات شخص تاني» is
  // the intake step of a third-party booking and carries no booking word of its
  // own, so without this it read as a request for a person.
  /\b(register|registration|sign\s*up|new\s*(patient\s*)?file|open\s*a\s*file|details)\b/i,
  /(اسجل|أسجل|تسجيل|التسجيل|بياناته|بياناتها|بيانات|ملف|الملف|استمارة)/,
];

// Dissatisfaction / complaints — routed to a human for a considered response.
const COMPLAINT_PATTERNS: readonly RegExp[] = [
  /\b(complaint|complain|terrible|awful|worst|unacceptable|refund|sue|lawyer|malpractice|negligen(t|ce)|angry|furious)\b/i,
  /(شكوى|أشتكي|اشتكي|سيئ\s*جدا|أسوأ|غير\s*مقبول|استرجاع\s*(المبلغ|الفلوس)|أقاضي|محامي|إهمال|اهمال|زعلان|غاضب)/,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * What the caller knows about the clinic that this file must not assume.
 *
 * `clinicDepartmentNames` is the live `departments.name` list, exactly as the
 * clinic stored it — no filtering, no canonicalisation, no allow-list. It is
 * consumed only through {@link buildClinicVocabulary}, only to *withhold* the
 * topic-derived medical signal, and never for the emergency or human-request
 * classes. Omitting it changes nothing except that a department whose name
 * happens to be a clinical noun loses one layer of protection; the topic/ask
 * split above still stands on its own.
 */
export type PatientEscalationContext = {
  clinicDepartmentNames?: readonly (string | null | undefined)[];
};

/**
 * Is this message asking the assistant to exercise clinical judgment?
 *
 * Two independent ways to be true, and the split is the point:
 *
 *   1. an explicit judgment request, read from the **raw** text, always;
 *   2. a clinical topic *plus* an advice frame *minus* a logistics frame, read
 *      from the text with this clinic's own department vocabulary blanked out.
 *
 * (2) is why "عايز احجز لابني علاج طبيعي" is a booking: `علاج` and `طبيعي` are
 * this clinic's department, so they are not topics here at all — and even at a
 * clinic with no such department, `احجز` is a logistics frame and there is no
 * advice frame anywhere in the sentence. Two independent reasons, neither of
 * which mentions physical therapy.
 */
function isClinicalJudgmentRequest(
  raw: string,
  vocabulary: ReadonlySet<string>,
): boolean {
  if (matchesAny(raw, CLINICAL_JUDGMENT_PATTERNS)) return true;
  const text = maskClinicVocabulary(raw, vocabulary);
  if (!matchesAny(text, CLINICAL_TOPIC_PATTERNS)) return false;
  if (!matchesAny(text, ADVICE_FRAME_PATTERNS)) return false;
  return !matchesAny(raw, LOGISTICS_FRAME_PATTERNS);
}

/**
 * Classifies an inbound patient message. Priority order is deliberate:
 * emergency > explicit human request > medical > complaint. Anything else
 * returns `escalate: false` and the ordinary agent handles it.
 *
 * Emergency and human-request are matched against the raw message and are
 * reached before any masking exists, so no clinic-supplied value can weaken
 * them. That ordering is load-bearing, not incidental.
 */
export function detectPatientEscalation(
  text: string | null | undefined,
  context: PatientEscalationContext = {},
): PatientEscalationDetection {
  const value = typeof text === "string" ? text : "";
  if (matchesAny(value, EMERGENCY_PATTERNS)) {
    return { escalate: true, reason: "emergency", emergency: true };
  }
  if (matchesAny(value, HUMAN_REQUEST_PATTERNS)) {
    return { escalate: true, reason: "human_requested", emergency: false };
  }
  if (
    matchesAny(value, HUMAN_REQUEST_WEAK_PATTERNS) &&
    !matchesAny(value, LOGISTICS_FRAME_PATTERNS) &&
    // A person something is being done *for* is a beneficiary, not a
    // switchboard request. See `BENEFICIARY_FRAME_PATTERNS`.
    !matchesAny(value, BENEFICIARY_FRAME_PATTERNS)
  ) {
    return { escalate: true, reason: "human_requested", emergency: false };
  }
  const vocabulary = buildClinicVocabulary(context.clinicDepartmentNames ?? []);
  if (isClinicalJudgmentRequest(value, vocabulary)) {
    return { escalate: true, reason: "medical", emergency: false };
  }
  if (matchesAny(value, COMPLAINT_PATTERNS)) {
    return { escalate: true, reason: "complaint", emergency: false };
  }
  return { escalate: false, reason: null, emergency: false };
}

// Local emergency numbers by ISO-3166 alpha-2 country (§6.5). The clinic's
// `country` selects it; anything unmapped falls back to the GSM/EU default 112,
// which routes to emergency services across the GCC and most of the world.
const EMERGENCY_NUMBERS: Record<string, string> = {
  KW: "112",
  SA: "997",
  AE: "999",
  QA: "999",
  BH: "999",
  OM: "9999",
  EG: "123",
  JO: "911",
  LB: "112",
  IQ: "122",
  TR: "112",
  US: "911",
  GB: "999",
};

export function emergencyNumberForCountry(country: string | null | undefined): string {
  const code = (country ?? "").trim().toUpperCase();
  return EMERGENCY_NUMBERS[code] ?? "112";
}
