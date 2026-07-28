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
 */

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
const HUMAN_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(speak|talk|chat|connect)\s*(to|with)?\s*(a\s*)?(human|person|agent|staff|receptionist|representative|someone|real\s*person)\b/i,
  /\b(human|real\s*person|live\s*agent|customer\s*service)\b/i,
  /(أريد|ابغى|أبغى|بدي|عايز|عاوز|ممكن)\s*.{0,20}(موظف|شخص|إنسان|انسان|بشري|أحد|احد|حد)/,
  /(كلم|أكلم|اكلم|أتحدث|اتحدث|تحويلي|حولني|وصلني)\s*.{0,20}(موظف|شخص|بشري|أحد|احد|استقبال)/,
  /(موظف\s*(حقيقي|بشري)|خدمة\s*العملاء|مع\s*موظف)/,
];

// Clinical questions the assistant must not answer — routed to staff. Kept
// coarse; the prompt is the real refusal layer, this just makes the handoff
// deterministic when a patient clearly asks for medical judgment.
const MEDICAL_PATTERNS: readonly RegExp[] = [
  /\b(diagnos(e|is|ed)|prescrib(e|ption)|dosage|dose|medication|symptom|treatment|is\s*it\s*(serious|dangerous|normal))\b/i,
  /\b(should\s*i\s*(take|stop|use)|what('?s|\s*is)\s*wrong\s*with\s*me)\b/i,
  /(تشخيص|شخص\s*حالتي|وصفة|جرعة|دواء|أعراض|اعراض|علاج|هل\s*(هذا|هي)\s*خطير)/,
  /(هل\s*آخذ|هل\s*أتوقف|ايش\s*فيني|إيش\s*مرضي|ما\s*هو\s*مرضي)/,
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
 * Classifies an inbound patient message. Priority order is deliberate:
 * emergency > explicit human request > medical > complaint. Anything else
 * returns `escalate: false` and the ordinary agent handles it.
 */
export function detectPatientEscalation(
  text: string | null | undefined,
): PatientEscalationDetection {
  const value = typeof text === "string" ? text : "";
  if (matchesAny(value, EMERGENCY_PATTERNS)) {
    return { escalate: true, reason: "emergency", emergency: true };
  }
  if (matchesAny(value, HUMAN_REQUEST_PATTERNS)) {
    return { escalate: true, reason: "human_requested", emergency: false };
  }
  if (matchesAny(value, MEDICAL_PATTERNS)) {
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
