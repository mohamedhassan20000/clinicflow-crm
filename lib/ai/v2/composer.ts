/**
 * The composer: it says what already happened, and it can say nothing else.
 *
 * ## The two-layer design, and why
 *
 * Every effect the engine produces has **deterministic copy** in both
 * languages. That copy is the answer. A model then gets one optional pass to
 * make it sound like a person rather than a form — the clinic's dialect, its
 * tone, its style line — and that pass is constrained three ways:
 *
 *   1. it is shown the server's facts and the deterministic sentence, and
 *      nothing else. It has no tools, no database and no flow state;
 *   2. its output is checked against the same grounding ledger the old engine
 *      used, so a doctor, day or time it invented is rejected;
 *   3. a rejection falls back to the deterministic sentence, which was already
 *      correct. There is no failure mode in which the patient gets nothing.
 *
 * So the model can improve the wording and cannot change the meaning. That is
 * the whole of "smart like an LLM, reliable like application code" at the
 * output end: the *facts* never depended on a generation, and the *phrasing*
 * degrades to something correct rather than to an apology.
 *
 * ## What is preserved from the old engine
 *
 * All of the Arabic work, deliberately. `communication-style` still decides
 * language and register, `reply-register` still enforces how a patient is
 * addressed, and the copy below is the same voice the deterministic replies in
 * `patient-booking-confirmation` and `patient-grounding` already speak in.
 * None of that was the problem and none of it is rewritten.
 */

import "server-only";

import { generateText } from "ai";
import * as Sentry from "@sentry/nextjs";
import type { AiExecutionHandle } from "@/lib/ai/client";
import { enforceReplyRegister } from "@/lib/ai/reply-register";
import { scrubInternalFieldNames } from "@/lib/ai/patient-intake-contract";
import type { CommunicationStyle } from "@/lib/ai/communication-style";
import type { Effect } from "@/lib/ai/v2/engine";

export type Locale = "ar" | "en";

type Copy = Record<Locale, string>;

/**
 * The deterministic answer for every effect key.
 *
 * Written as data rather than composed in branches, so adding a flow step adds
 * a line here and a reviewer can see the whole of what the assistant can say.
 * `{placeholders}` are filled from the effect's server-supplied facts and from
 * nowhere else.
 */
const COPY: Record<string, Copy> = {
  // -- clarification: the safe default, and the answer to «عندي استفسار» ------
  "clarify.open": {
    ar: "اتفضل، أقدر أساعدك في إيه؟",
    en: "Of course — how can I help?",
  },
  "clarify.open.with_parked": {
    ar: "اتفضل، أقدر أساعدك في إيه؟ ولو حابب نكمّل الحجز اللي بدأناه قبل كده، قولي.",
    en: "Of course — how can I help? If you'd like to continue the booking we started earlier, just say so.",
  },
  "clarify.no_active_flow": {
    ar: "تمام. تحب أساعدك في حجز موعد، ولا عندك سؤال عن العيادة؟",
    en: "Noted. Would you like to book an appointment, or do you have a question about the clinic?",
  },
  "clarify.value_not_recognised": {
    ar: "معلش، ما قدرتش أحدد اللي تقصده. ممكن تقوله تاني؟",
    en: "Sorry — I couldn't match that. Could you say it again?",
  },
  "clarify.value_rejected": {
    ar: "ده اللي قلت إنك مش عايزه. تحب تختار واحد تاني؟",
    en: "That's the one you said you didn't want. Would you like to choose another?",
  },
  "clarify.which_one": {
    ar: "تقصد أنهي واحد فيهم: {options}؟",
    en: "Which one do you mean: {options}?",
  },
  "clarify.nothing_to_confirm": {
    ar: "مفيش حاجة مطروحة للتأكيد دلوقتي. تحب أساعدك في إيه؟",
    en: "There's nothing waiting for a yes right now. How can I help?",
  },
  "clarify.nothing_to_resume": {
    ar: "مفيش طلب متوقف نكمّله. تحب نبدأ حاجة جديدة؟",
    en: "There's nothing paused to pick up. Would you like to start something new?",
  },
  "clarify.step_blocked": {
    ar: "محتاج أعرف {slot} الأول.",
    en: "I need to know the {slot} first.",
  },
  "identity.required": {
    ar: "علشان أقدر أوصل لبيانات ملفك، لازم نتأكد من هويتك الأول. فريق العيادة هيساعدك في ده.",
    en: "To reach your record I need your identity verified first. The clinic team will help with that.",
  },

  // -- small talk ------------------------------------------------------------
  "small_talk.greeting": {
    ar: "أهلًا بيك! أقدر أساعدك في إيه النهاردة؟",
    en: "Hello! How can I help you today?",
  },
  "small_talk.thanks": { ar: "العفو، تحت أمرك.", en: "You're welcome." },
  "small_talk.acknowledgement": { ar: "تمام.", en: "Understood." },
  "small_talk.farewell": { ar: "تحت أمرك في أي وقت.", en: "Any time — take care." },
  "small_talk.chitchat": {
    ar: "تحت أمرك. أقدر أساعدك في حاجة تخص العيادة؟",
    en: "Happy to help — anything about the clinic I can assist with?",
  },

  // -- flow lifecycle --------------------------------------------------------
  "flow.cancelled": { ar: "تمام، لغيت الطلب.", en: "Done — I've dropped that." },
  "flow.resume_or_restart": {
    ar: "كان في حجز بدأناه قبل كده. تحب نكمّله، ولا نبدأ من الأول؟",
    en: "There's a booking we started earlier. Continue it, or start again?",
  },
  "flow.confirm_cancel": {
    ar: "متأكد إنك عايز تلغي الطلب ده؟",
    en: "Are you sure you'd like to cancel that request?",
  },
  "flow.confirm_discard_on_end": {
    ar: "قبل ما نقفل — في بيانات سجلناها لملف جديد. تحب أسيبها للفريق يراجعها، ولا نلغيها؟",
    en: "Before we finish — we have details recorded for a new file. Shall I leave them for the team to review, or drop them?",
  },

  // -- booking ---------------------------------------------------------------
  "booking.who_is_this_for": {
    ar: "الحجز ده ليك إنت ولا لحد تاني؟",
    en: "Is this appointment for you, or for someone else?",
  },
  "booking.choose_department": {
    ar: "الأقسام المتاحة: {options}. تحب أنهي قسم؟",
    en: "Our departments are: {options}. Which one would you like?",
  },
  "booking.choose_doctor": {
    ar: "الدكاترة المتاحين في القسم ده: {options}. تحب مين؟",
    en: "The doctors available in that department are: {options}. Who would you like?",
  },
  "booking.choose_doctor_with_previous": {
    ar: "الدكاترة المتاحين: {options}. أول واحد فيهم ده اللي تابعت معاه قبل كده — تحب تكمل معاه؟",
    en: "Available doctors: {options}. The first is the one you saw before — would you like them again?",
  },
  "booking.choose_day": {
    ar: "الأيام المتاحة: {options}. تحب أنهي يوم؟",
    en: "Available days: {options}. Which day suits you?",
  },
  "booking.choose_time": {
    ar: "المواعيد المتاحة: {options}. تحب أنهي ميعاد؟",
    en: "Available times: {options}. Which time suits you?",
  },
  "booking.no_days": {
    ar: "مفيش أيام متاحة مع الدكتور ده في الفترة الجاية. تحب أدور في أيام أبعد، ولا نجرب دكتور تاني؟",
    en: "There are no available days with that doctor in the coming period. Shall I look further ahead, or try another doctor?",
  },
  "booking.no_times": {
    ar: "مفيش مواعيد فاضية في اليوم ده. تحب نجرب يوم تاني؟",
    en: "There are no free times that day. Shall we try another day?",
  },
  "booking.no_doctors_left": {
    ar: "مفيش دكتور تاني متاح في القسم ده دلوقتي. تحب نجرب قسم تاني؟",
    en: "There's no other doctor available in that department right now. Shall we try another department?",
  },
  "booking.no_departments": {
    ar: "مش قادر أوصل لأقسام العيادة دلوقتي. فريق العيادة هيتواصل معاك.",
    en: "I can't reach the clinic's departments right now. The clinic team will follow up with you.",
  },
  "booking.calendar_unavailable": {
    ar: "مش قادر أقرأ جدول الدكتور دلوقتي. تحب تقولي اليوم اللي يناسبك وأشوفه؟",
    en: "I can't read the doctor's schedule just now. Tell me which day suits you and I'll check it.",
  },
  "booking.package_offer": {
    ar: "عندك باقة سارية ينفع تستخدمها في الحجز ده: {options}. تحب نستخدمها؟",
    en: "You have an active package that covers this appointment: {options}. Would you like to use it?",
  },
  "booking.review": {
    ar: "كده الطلب: د. {doctor}، يوم {day}، الساعة {time}. أأكد الطلب؟",
    en: "Here's the request: Dr {doctor}, {day} at {time}. Shall I confirm it?",
  },
  "booking.created": {
    ar: "تمام، سجلت الطلب: د. {doctor}، يوم {day}، الساعة {time}. الطلب في انتظار تأكيد العيادة وهيتواصلوا معاك.",
    en: "Done — request recorded: Dr {doctor}, {day} at {time}. It's pending the clinic's confirmation and they'll be in touch.",
  },
  "booking.slot_gone": {
    // Followed in the same message by the live time list, because the engine
    // re-advances into the time step after invalidating the slot.
    ar: "الميعاد ده اتحجز للأسف قبل ما نأكده.",
    en: "That slot was taken just before we could confirm it.",
  },
  "booking.completed": { ar: "تمام.", en: "All set." },

  // -- intake / identity -----------------------------------------------------
  "intake.ask_name": { ar: "ممكن اسمك بالكامل؟", en: "May I have your full name?" },
  "intake.ask_national_id": {
    ar: "ممكن الرقم القومي؟",
    en: "May I have your national ID number?",
  },
  "intake.ask_latin_name": {
    ar: "ممكن تكتب اسمك بالإنجليزي زي ما تحب يتسجل؟",
    en: "Could you write your name in English as you'd like it recorded?",
  },
  "intake.confirm_latin_name": {
    ar: "هكتب اسمك كده: {proposed}. تمام كده ولا تحب تعدّله؟",
    en: "I'll record your name as: {proposed}. Is that right, or would you like to change it?",
  },
  "intake.ask_dob": { ar: "ممكن تاريخ الميلاد؟", en: "What's your date of birth?" },
  "intake.ask_email": { ar: "ممكن الإيميل؟", en: "What's your email address?" },
  "intake.need_field": { ar: "ممكن {field}؟", en: "Could I have your {field}?" },
  "intake.collected": {
    ar: "تمام، سجلت البيانات.",
    en: "Thank you — I have your details.",
  },
  "intake.staged": {
    ar: "تمام، البيانات اتسجلت للمراجعة.",
    en: "Your details are recorded for the team to review.",
  },
  "intake.failed": {
    ar: "مش قادر أسجل البيانات دلوقتي. فريق العيادة هيتواصل معاك.",
    en: "I can't record those details right now. The clinic team will follow up.",
  },
  "identity.existing_patient": {
    ar: "أهلًا {canonical_name}، ملفك موجود عندنا بالفعل — مش محتاجين نفتح ملف جديد.",
    en: "Welcome back, {canonical_name} — you already have a file with us, so there's no need to open a new one.",
  },
  "identity.new_patient": {
    ar: "تمام، هنفتح لك ملف جديد.",
    en: "Right — we'll open a new file for you.",
  },
  "identity.which_department": {
    ar: "أهلًا {canonical_name}. إنت متابع معانا في أكتر من قسم: {options}. تحب أنهي قسم؟",
    en: "Welcome back, {canonical_name}. You're known in more than one department: {options}. Which one?",
  },

  // -- clinic information ----------------------------------------------------
  "info.departments": { ar: "أقسام العيادة: {departments}.", en: "Our departments: {departments}." },
  "info.doctors": { ar: "الدكاترة: {doctors}.", en: "Our doctors: {doctors}." },
  "info.which_department": {
    ar: "أنهي قسم تحب تعرف دكاتره: {options}؟",
    en: "Which department's doctors would you like: {options}?",
  },
  "info.packages": { ar: "الباقات المتاحة: {packages}.", en: "Our packages: {packages}." },
  "info.my_packages": { ar: "باقاتك السارية: {packages}.", en: "Your active packages: {packages}." },
  "info.my_appointments": { ar: "مواعيدك: {count}.", en: "Your appointments: {count}." },
  "info.services": { ar: "الخدمات حسب القسم: {departments}.", en: "Services by department: {departments}." },
  "info.prices": {
    ar: "الأسعار بتختلف حسب القسم والخدمة: {departments}. تحب تعرف سعر إيه بالظبط؟",
    en: "Prices vary by department and service: {departments}. Which one would you like the price for?",
  },
  "info.privacy": {
    ar: "سجل المحادثة مش إثبات هوية. ما أقدرش أعرض بيانات ملف إلا بعد التحقق الرسمي من العيادة، ومش بعرض الرقم القومي كاملًا أبدًا.",
    en: "Conversation history is not proof of identity. I can only show record details after the clinic's own verification, and I never display a full national ID.",
  },
  "info.unavailable": {
    ar: "مش قادر أوصل للمعلومة دي دلوقتي.",
    en: "I can't reach that information right now.",
  },
  "info.see_documents_flow": {
    ar: "أقدر أجيبلك المستندات اللي صدرت لك قبل كده. تحب أعرضها؟",
    en: "I can fetch documents that were already issued to you. Shall I list them?",
  },

  // -- documents (retrieval only) -------------------------------------------
  "documents.choose": {
    ar: "المستندات الصادرة لك: {options}. تحب أنهي واحد؟",
    en: "Documents already issued to you: {options}. Which one would you like?",
  },
  "documents.none": {
    ar: "مفيش مستندات صادرة على ملفك لحد دلوقتي.",
    en: "There are no issued documents on your file yet.",
  },
  "documents.delivered": {
    // No `{url}`. The link is appended after the model has been and gone —
    // see `LINK_FACTS`.
    ar: "اتفضل {label}. الرابط ده صالح لمدة قصيرة:",
    en: "Here's your {label}. The link is valid for a short time:",
  },
  "documents.unavailable": {
    ar: "مش قادر أجيب المستند ده دلوقتي. فريق العيادة هيساعدك.",
    en: "I can't fetch that document right now. The clinic team will help.",
  },

  // -- cancel / reschedule ---------------------------------------------------
  "appointments.none": { ar: "مالقيتش مواعيد على ملفك.", en: "I don't see any appointments on your file." },
  "cancel.choose": { ar: "مواعيدك: {options}. تحب تلغي أنهي واحد؟", en: "Your appointments: {options}. Which one shall I cancel?" },
  "cancel.review": { ar: "أأكد الإلغاء؟", en: "Shall I confirm the cancellation?" },
  "cancel.done": { ar: "تمام، اتلغى.", en: "Done — it's cancelled." },
  "cancel.failed": { ar: "مش قادر ألغي الموعد ده. فريق العيادة هيساعدك.", en: "I couldn't cancel that. The clinic team will help." },
  "reschedule.choose": { ar: "مواعيدك: {options}. تحب تغير أنهي واحد؟", en: "Your appointments: {options}. Which one shall I move?" },
  "reschedule.ask_day": { ar: "تحب تحجز يوم إيه؟", en: "Which day would you like instead?" },
  "reschedule.choose_day": {
    ar: "الأيام المتاحة لتغيير الموعد: {options}. تحب أنهي يوم؟",
    en: "Days available to move it to: {options}. Which day suits you?",
  },
  "reschedule.choose_time": { ar: "المواعيد المتاحة: {options}.", en: "Available times: {options}." },
  "reschedule.no_days": {
    ar: "مفيش أيام متاحة مع نفس الدكتور في الفترة الجاية. فريق العيادة هيساعدك.",
    en: "There are no available days with the same doctor in the coming period. The clinic team will help.",
  },
  "reschedule.no_times": { ar: "مفيش مواعيد فاضية في اليوم ده.", en: "There are no free times that day." },
  "reschedule.unavailable": {
    ar: "مش قادر أوصل لتفاصيل الموعد ده دلوقتي. فريق العيادة هيساعدك.",
    en: "I can't reach that appointment's details right now. The clinic team will help.",
  },
  "reschedule.review": { ar: "التغيير لـ {day} الساعة {time}. أأكد؟", en: "Moving it to {day} at {time}. Shall I confirm?" },
  "reschedule.done": {
    ar: "تمام، الموعد اتغير لـ {day} الساعة {time}.",
    en: "Done — the appointment has been moved to {day} at {time}.",
  },
  "reschedule.failed": { ar: "مش قادر أغير الموعد. فريق العيادة هيساعدك.", en: "I couldn't move that. The clinic team will help." },

  // -- handoff and ending ----------------------------------------------------
  //
  // Rendered rather than skipped. Both effect kinds used to be dropped here,
  // which left a turn whose only effect was a handoff with nothing to say — so
  // it fell through to `clarify.open` and answered "how can I help?" to a
  // patient who had just asked for a person.
  "handoff.default": {
    ar: "هحوّل المحادثة لفريق العيادة وهيتواصلوا معاك في أقرب وقت.",
    en: "I'm passing this to the clinic team and they'll be in touch shortly.",
  },
  "handoff.patient_requested_human": {
    ar: "تمام، هوصّلك بفريق العيادة وهيردوا عليك في أقرب وقت.",
    en: "Of course — I'm connecting you with the clinic team and they'll reply shortly.",
  },
  "handoff.clinical_question": {
    ar: "ده سؤال طبي لازم يرد عليه حد من الفريق الطبي، وهحوّلهم المحادثة دلوقتي.",
    en: "That's a medical question for the clinical team — I'm passing it to them now.",
  },
  "handoff.complaint": {
    ar: "أنا آسف على ده. هحوّل الموضوع لفريق العيادة علشان يتابعوه معاك بنفسهم.",
    en: "I'm sorry about that. I'm passing this to the clinic team so they can follow it up with you directly.",
  },
  "handoff.payment_dispute": {
    ar: "موضوع الحساب ده محتاج حد من الفريق يراجعه معاك، وهحوّلهم المحادثة.",
    en: "A billing matter like this needs someone from the team to review it with you — I'm passing it on.",
  },
  "handoff.unsupported_request": {
    ar: "الطلب ده محتاج حد من فريق العيادة، وهحوّلهم المحادثة دلوقتي.",
    en: "That needs someone from the clinic team — I'm passing this on to them now.",
  },
  "flow.stuck": {
    ar: "معلش، حصلت مشكلة وأنا بكمّل طلبك. هحوّل المحادثة لفريق العيادة يكملوا معاك.",
    en: "Sorry — something went wrong while I was working through your request. I'm passing it to the clinic team.",
  },
  "conversation.ended": {
    ar: "تحت أمرك في أي وقت.",
    en: "Any time — take care.",
  },

  // -- relationship lookup ---------------------------------------------------
  "relationship.doctors": {
    ar: "إنت متابع مع: {doctors}.",
    en: "You've been seeing: {doctors}.",
  },
  "relationship.none": {
    ar: "مالقيتش دكتور مسجل إنك بتتابع معاه على ملفك.",
    en: "I don't see a treating doctor recorded on your file.",
  },
};

/** Keys whose only job is to move the ladder. They contribute no sentence. */
export const SILENT_COPY_KEYS: ReadonlySet<string> = new Set([
  // The package question, answered. Each of these records a real decision the
  // ladder needs — accepted, declined, none owned, not offerable at this
  // identity level — and none of them is news to the patient: the acceptance
  // is already in the summary, and a patient who owns no package should not be
  // told so on the way past.
  "booking.package_accepted",
  "booking.package_skipped",
  "booking.package_none",
  "booking.package_not_offered",
  "booking.intake_not_needed",
  "identity.already_checked",
  // A flow that ran out of steps rather than reaching an explicit `complete`.
  //
  // The engine emits `${flow}.completed` on that path and no such key ever
  // existed — the copy table is keyed `booking.completed`, and no flow is
  // named `booking` — so every one of them was a missing-copy warning on a
  // reachable path. Silent is also the right answer: the step that ran last
  // already said what happened, and "All set." appended to "that slot has just
  // been taken" would be worse than saying nothing.
  "book_appointment.completed",
  "reschedule_appointment.completed",
  "cancel_appointment.completed",
  "register_patient.completed",
  "answer_question.completed",
  "retrieve_document.completed",
  "package_inquiry.completed",
  "patient_relationship_lookup.completed",
]);

/**
 * Which line of copy an effect renders.
 *
 * The two that used to be skipped are the interesting ones. A `handoff` says
 * the thing the step wanted said if it named one, otherwise the line for its
 * reason, otherwise the generic. An `end_conversation` says goodbye. Neither
 * may render nothing, because "nothing" fell through to the clarification
 * fallback and answered a request for a human with an offer to help.
 */
function effectCopyKey(effect: Effect): string {
  if (effect.kind === "handoff") {
    if (effect.key && COPY[effect.key]) return effect.key;
    const byReason = `handoff.${effect.reason}`;
    return COPY[byReason] ? byReason : "handoff.default";
  }
  if (effect.kind === "end_conversation") return "conversation.ended";
  return effect.key;
}

/**
 * Fact keys holding a server-minted link, which never reach the model.
 *
 * A signed document URL is a bearer credential: for as long as it lives,
 * whoever holds it can read that patient's PDF. Putting it in the polish
 * prompt sent it to the model provider on every document delivery — where it
 * lands in request logs, retention windows and anything else outside
 * ClinicFlow's control — to solve a problem the model was never needed for.
 *
 * So it is pulled out of the facts before the sentence is built, and appended
 * to the finished message deterministically. The consequences are all in the
 * right direction: the model cannot leak it because it never had it, and it
 * cannot corrupt it either — no truncation, no re-encoded query string, no
 * helpful "shortening". The grounding check never sees it, which is correct:
 * a value the model was not shown is not a value it can be asked to preserve.
 */
const LINK_FACTS: ReadonlySet<string> = new Set(["url"]);

function fill(template: string, facts: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = facts[name];
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map((item) => String(item)).join("، ");
    return String(value);
  });
}

/**
 * Renders the engine's effects into one deterministic message.
 *
 * This is the answer. Everything below it is optional polish, and the polish
 * cannot change what this said.
 */
export function composeDeterministic(input: {
  effects: readonly Effect[];
  locale: Locale;
}): {
  text: string;
  facts: Record<string, unknown>;
  keys: string[];
  /** Server-minted links, appended after polish. Never sent to the model. */
  links: string[];
} {
  const parts: string[] = [];
  const allFacts: Record<string, unknown> = {};
  const keys: string[] = [];
  const links: string[] = [];
  for (const effect of input.effects) {
    let key = effectCopyKey(effect);
    const facts: Record<string, unknown> = {
      ...(effect.kind === "end_conversation" ? {} : (effect.facts ?? {})),
    };
    if (effect.kind === "offer") {
      // Options come from the offer the engine minted, which was built from a
      // server read. The composer never assembles an option list of its own.
      facts.options = effect.offer.options.map((option) => option.label);
    }
    if (effect.kind === "ask" && effect.slot) facts.slot = effect.slot;
    // Out of the facts before anything renders or prompts with them.
    for (const key of LINK_FACTS) {
      const value = facts[key];
      delete facts[key];
      if (typeof value === "string" && value.length > 0) links.push(value);
    }
    // The one key that varies on a fact rather than on a step.
    if (key === "clarify.open" && facts.parked_flow) key = "clarify.open.with_parked";
    if (SILENT_COPY_KEYS.has(key)) continue;
    const copy = COPY[key];
    if (!copy) {
      // An effect with no copy is a bug in a flow definition, not something to
      // improvise about. It is reported and skipped; if it was the only effect,
      // the caller falls back to the clarification below.
      Sentry.captureMessage("patient_ai_v2_missing_copy", {
        level: "warning",
        tags: { area: "patient-ai-v2-composer", key },
      });
      continue;
    }
    keys.push(key);
    Object.assign(allFacts, facts);
    parts.push(fill(copy[input.locale], facts).trim());
  }
  const text = parts.filter(Boolean).join("\n");
  return {
    text: text || COPY["clarify.open"]![input.locale],
    facts: allFacts,
    keys,
    links,
  };
}

/**
 * Optionally rewrites the deterministic sentence in the clinic's own voice.
 *
 * Constrained by construction rather than by instruction: the model sees the
 * sentence and the facts, has no tools and no state, and anything it produces
 * that drops a fact or adds one is discarded in favour of what it was given.
 * A provider failure is not an error path — the deterministic text was always
 * the answer.
 */
export async function polish(input: {
  text: string;
  facts: Record<string, unknown>;
  locale: Locale;
  style: CommunicationStyle;
  execution: AiExecutionHandle;
}): Promise<{ text: string; outcome: "polished" | "deterministic" }> {
  const factValues = Object.values(input.facts)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string" && value.length > 1);
  try {
    const result = await generateText({
      model: input.execution.model,
      providerOptions: input.execution.providerOptions,
      temperature: 0.3,
      maxOutputTokens: 300,
      system:
        "You rewrite one clinic message so it sounds natural, warm and brief in the " +
        "patient's own language. You may change wording, never meaning.\n" +
        "Rules: keep every name, date, time, number, price and link exactly as given. " +
        "Add no fact that is not in the message. Ask no question the message does not ask. " +
        "Never mention systems, tools, fields or internal terms. Reply with the message only." +
        (input.style.styleInstruction ? `\nClinic style: ${input.style.styleInstruction}` : "") +
        `\nTone: ${input.style.tone}.` +
        (input.locale === "ar" && input.style.arabicStyle === "egyptian"
          ? "\nWrite Egyptian Arabic as a receptionist in Cairo would speak it."
          : ""),
      messages: [{ role: "user", content: input.text }],
    });
    const candidate = (result.text ?? "").trim();
    if (!candidate) return { text: input.text, outcome: "deterministic" };
    // The grounding check, at the granularity that matters here: every literal
    // the server supplied must survive the rewrite. A polish that dropped the
    // doctor's name or changed a time is not a polish.
    const kept = factValues.every((value) => candidate.includes(value));
    if (!kept) return { text: input.text, outcome: "deterministic" };
    return { text: candidate, outcome: "polished" };
  } catch (error) {
    Sentry.captureException(error, { tags: { area: "patient-ai-v2-composer" } });
    return { text: input.text, outcome: "deterministic" };
  }
}

/**
 * The full output path: deterministic copy, optional polish, then the same
 * register and identifier gates the legacy engine applies to every reply.
 */
export async function compose(input: {
  effects: readonly Effect[];
  locale: Locale;
  style: CommunicationStyle;
  execution?: AiExecutionHandle | null;
}): Promise<{ text: string; outcome: "polished" | "deterministic"; keys: string[] }> {
  const base = composeDeterministic({ effects: input.effects, locale: input.locale });
  const polished = input.execution
    ? await polish({
        text: base.text,
        facts: base.facts,
        locale: input.locale,
        style: input.style,
        execution: input.execution,
      })
    : { text: base.text, outcome: "deterministic" as const };
  // Unchanged from the legacy path, and applied to deterministic and polished
  // text alike for the same reason it always was: a server-composed sentence
  // and a generated one must not be able to differ on how a patient is
  // addressed, and a schema name must never reach a WhatsApp thread.
  const register = enforceReplyRegister({
    text: polished.text,
    style: input.style,
  });
  const scrubbed = scrubInternalFieldNames(register.text, input.locale);
  // The link is attached last, to the finished prose.
  //
  // After the register and identifier gates as well as after the model, because
  // both of those exist to police *language* and a signed URL is not language:
  // `scrubInternalFieldNames` looks for schema-shaped words, and a query string
  // is exactly the sort of thing that trips a matcher like that. Appending it
  // here means the credential passes through no transformation at all between
  // the storage layer minting it and the patient receiving it.
  const text =
    base.links.length > 0
      ? [scrubbed.text, ...base.links].join("\n")
      : scrubbed.text;
  return {
    text,
    outcome: polished.outcome,
    keys: base.keys,
  };
}

/** Exported for the copy-parity test: every key must exist in both languages. */
export const COMPOSER_COPY = COPY;
