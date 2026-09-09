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
import {
  buildStyleNoteForRewrite,
  type CommunicationStyle,
} from "@/lib/ai/communication-style";
import { SECTION_SEPARATOR, renderOptions } from "@/lib/ai/v2/present";
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
  // The same failure, said usefully, when the server knows what it was asking
  // for.
  //
  // ## What was wrong with the generic line alone
  //
  // «ما قدرتش أحدد اللي تقصده» tells the patient that something went wrong and
  // nothing about how to get out of it. It is the right answer when the engine
  // genuinely cannot tell what it needs — an unreadable message with no
  // question standing open — and it stays the answer there. But a value that
  // fails to resolve while the intake is standing on *one specific slot* is not
  // that case: the server knows exactly which field it asked for, and saying so
  // turns an apology into a question the patient can answer.
  //
  // ## Why it is copy and not generation
  //
  // Because it is an explanation, not a guess. Each line below says what the
  // field is and, where a format is genuinely ambiguous, shows one example of
  // the shape — nothing here supplies, completes or infers a *value*. The
  // resolver still declined, nothing is committed, and the clarification-loop
  // breaker behind it is unchanged: a second failure still re-runs the step and
  // shows the choices again rather than repeating any of this.
  //
  // Selected by slot in `composeDeterministic`, with the generic line as the
  // fallback for every slot that has no entry — so a new slot degrades to the
  // old behaviour instead of to a missing-copy warning.
  "clarify.value_not_recognised.full_name": {
    ar: "مش فاهم قصدك بالضبط. أنا محتاج الاسم الكامل للمريض، ممكن تكتبه مرة تانية؟",
    en: "Sorry, I didn't quite follow. I need the patient's full name — could you write it again?",
  },
  "clarify.value_not_recognised.full_name_latin": {
    ar: "مش فاهم قصدك بالضبط. محتاج الاسم بالإنجليزي زي ما هيتكتب في الملف، ممكن تكتبه تاني؟",
    en: "Sorry, I didn't quite follow. I need the name in English as it should appear on the file — could you write it again?",
  },
  "clarify.value_not_recognised.national_id": {
    ar: "مش فاهم الرقم ده. ممكن تبعت الرقم المدني/الرقم القومي للمريض مرة تانية؟",
    en: "I couldn't read that number. Could you send the patient's national/civil ID again?",
  },
  "clarify.value_not_recognised.date_of_birth": {
    ar: "مش فاهم التاريخ. ممكن تكتب تاريخ ميلاد المريض، مثلاً 12/03/2015؟",
    en: "I couldn't read that date. Could you write the patient's date of birth — for example 12/03/2015?",
  },
  "clarify.value_not_recognised.email": {
    ar: "مش فاهم قصدك. ممكن تبعت إيميل المريض؟",
    en: "Sorry, I didn't follow. Could you send the patient's email address?",
  },
  // Only for a third-party intake, where «استخدم إيميلي» actually resolves.
  // Offering it on a sender's own file would suggest a phrase that does
  // nothing — see the email branch of `resolveIntakeField`.
  "clarify.value_not_recognised.email.other": {
    ar: "مش فاهم قصدك. ممكن تبعت إيميل المريض، أو تقول «استخدم إيميلي» لو عايز تستخدم إيميلك؟",
    en: "Sorry, I didn't follow. Could you send the patient's email address — or say \"use my email\" if you'd like to use yours?",
  },
  // The phone question is only ever asked for a third party, so there is one
  // line and it always carries the offer.
  "clarify.value_not_recognised.phone": {
    ar: "مش فاهم قصدك. ممكن تبعت رقم المريض، أو تقول «استخدم رقمي» لو عايز تستخدم رقمك؟",
    en: "Sorry, I didn't follow. Could you send the patient's phone number — or say \"use my number\" if you'd like to use yours?",
  },
  "clarify.value_not_recognised.blood_type": {
    ar: "مش فاهم قصدك. أنا بسأل عن فصيلة دم المريض، زي O+ أو A- أو AB+. ولو مش عارفها، قول «مش عارف» وهنكمّل عادي.",
    en: "Sorry, I didn't follow. I'm asking for the patient's blood type — O+, A-, AB+ and so on. If you don't know it, just say \"not sure\" and we'll carry on.",
  },
  "clarify.value_rejected": {
    ar: "ده اللي قلت إنك مش عايزه. تحب تختار واحد تاني؟",
    en: "That's the one you said you didn't want. Would you like to choose another?",
  },
  "clarify.which_one": {
    ar: "تقصد أنهي واحد فيهم؟{options}",
    en: "Which one do you mean?{options}",
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
  // «عايز أغير» with no field named. Two shapes, and which one is used is
  // decided by the frame rather than by the copy: a booking that holds two or
  // more editable values names them, and one that holds a single value asks the
  // open question instead of offering a list of one.
  "clarify.what_to_change": {
    ar: "معلش، تقصد تعدّل إيه بالظبط؟{fields}",
    en: "Sorry — what exactly would you like to change?{fields}",
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
  // The four choice questions, written as a heading, a list and a prompt.
  //
  // `{options}` is rendered by `renderOptions`, which numbers anything with
  // three or more entries onto its own lines and leaves a shorter set inline —
  // so the copy does not have to know which it is getting and a two-doctor
  // department still reads as a sentence. The sentence around the placeholder
  // is written so that both shapes are grammatical.
  "booking.choose_department": {
    ar: "الأقسام النشطة الموجودة في العيادة:{options}\nتحب أنهي قسم؟",
    en: "Our departments:{options}\nWhich one would you like?",
  },
  "booking.choose_doctor": {
    ar: "الدكاترة المتاحين في القسم:{options}\nتحب تحجز مع مين؟",
    en: "Available doctors:{options}\nWhich doctor would you prefer?",
  },
  "booking.choose_doctor_with_previous": {
    ar: "الدكاترة المتاحين:{options}\nأول واحد فيهم ده اللي تابعت معاه قبل كده — تحب تكمل معاه؟",
    en: "Available doctors:{options}\nThe first is the one you saw before — would you like them again?",
  },
  "booking.choose_day": {
    ar: "الأيام المتاحة:{options}\nأنهي يوم يناسبك؟",
    en: "Available days:{options}\nWhich day suits you?",
  },
  "booking.choose_time": {
    ar: "المواعيد المتاحة:{options}\nاختار الوقت المناسب.",
    en: "Available times:{options}\nWhich time suits you?",
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
  // The summary, as a heading, a block of labelled lines and a question.
  //
  // `{summary}` is rendered by `renderSummary` and arrives finished. Three
  // things changed here and each was a manual-QA defect:
  //
  //   * the fields were crammed onto one line — «{doctor}، {day}، الساعة
  //     {time}» — which is the hardest possible shape to check before
  //     consenting to a write, and carried no patient, department, service or
  //     price at all;
  //   * the patient was missing entirely, so a sender confirming an
  //     appointment for a friend had nothing on screen saying whose it was;
  //   * «أأكد الطلب؟» is not how anybody asks this. «تحب تأكد الطلب؟» is the
  //     same question in the register the rest of these lines are written in.
  //
  // No separator rules anywhere. The blank line between the block and the
  // question is the only separation the message needs, and a row of dashes on
  // WhatsApp reads as something having gone wrong.
  "booking.review": {
    ar: "راجع تفاصيل طلب الحجز:\n\n{summary}\n\nتحب تأكد الطلب؟",
    en: "Please review your booking request:\n\n{summary}\n\nShall I confirm it?",
  },
  "booking.created": {
    ar: "تمام، سجلت طلب الحجز:\n\n{summary}\n\nالطلب في انتظار تأكيد العيادة وهيتواصلوا معاك.",
    en: "Done — your booking request is recorded:\n\n{summary}\n\nIt's pending the clinic's confirmation and they'll be in touch.",
  },
  // A second confirmation of a request that is already in.
  //
  // Not an error and not a slot conflict: the clinic allows one pending request
  // at a time, so the database refused a duplicate and nothing was created. The
  // patient is told what they already have rather than being sent back to pick
  // another time for an appointment that was never lost.
  "booking.already_requested": {
    ar: "طلب الحجز ده مسجل عندنا بالفعل:\n\n{summary}\n\nفريق العيادة هيتواصل معاك لتأكيده.",
    en: "That booking request is already recorded:\n\n{summary}\n\nThe clinic team will be in touch to confirm it.",
  },
  // Too soon to book online. The clinic's own number, from settings — never a
  // number written into copy.
  "booking.lead_time": {
    ar: "الحجز أونلاين لازم يكون بموعد أبعد شوية. لو محتاج موعد أقرب من كده، تقدر تتواصل مع العيادة مباشرة على {clinic_phone} وهيساعدوك.",
    en: "Online booking needs a date a little further ahead. If you need something sooner, please call the clinic directly on {clinic_phone} and they'll help.",
  },
  "booking.lead_time_no_phone": {
    ar: "الحجز أونلاين لازم يكون بموعد أبعد شوية. لو محتاج موعد أقرب من كده، فريق العيادة هيقدر يساعدك.",
    en: "Online booking needs a date a little further ahead. If you need something sooner, the clinic team can help you directly.",
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
  // The English spelling of a name given in Arabic.
  //
  // The Arabic name is shown beside the proposal deliberately: the patient is
  // being asked about a *rendering of what they just wrote*, and a question
  // that shows only the rendering asks them to remember what they typed. The
  // proposal is never filed without one of these being answered — see
  // `latinNameOutcome`.
  "intake.ask_latin_name": {
    ar: "ممكن تكتب اسمك بالإنجليزي زي ما تحب يتسجل؟",
    en: "Could you write your name in English as you'd like it recorded?",
  },
  "intake.ask_latin_name.other": {
    ar: "ممكن تكتب اسم المريض بالإنجليزي زي ما تحب يتسجل؟",
    en: "Could you write the patient's name in English as you'd like it recorded?",
  },
  "intake.confirm_latin_name": {
    ar: "تمام، الاسم بالعربي: {typed}\n\nالاسم بالإنجليزي:\n{proposed}\n\nهل الاسم بالإنجليزي صحيح؟ لو حابب تعدّله اكتبه بالإنجليزي.",
    en: "Noted — the name in Arabic is: {typed}\n\nIn English:\n{proposed}\n\nIs the English spelling right? If you'd like it different, just write it in English.",
  },
  "intake.confirm_latin_name.other": {
    ar: "تمام، اسم المريض بالعربي: {typed}\n\nالاسم بالإنجليزي:\n{proposed}\n\nهل الاسم بالإنجليزي صحيح؟ لو حابب تعدّله اكتبه بالإنجليزي.",
    en: "Noted — the patient's name in Arabic is: {typed}\n\nIn English:\n{proposed}\n\nIs the English spelling right? If you'd like it different, just write it in English.",
  },
  "intake.ask_dob": { ar: "ممكن تاريخ الميلاد؟", en: "What's your date of birth?" },
  "intake.ask_email": { ar: "ممكن الإيميل؟", en: "What's your email address?" },
  "intake.need_field": { ar: "ممكن {field}؟", en: "Could I have your {field}?" },
  // The same four questions, asked about somebody else. A booking for another
  // person that says "ممكن اسمك؟" is asking the wrong person for the wrong
  // name, which is how third-party details ended up read as the sender's.
  "intake.ask_name.other": {
    ar: "ممكن اسم المريض بالكامل؟",
    en: "May I have the patient's full name?",
  },
  "intake.ask_national_id.other": {
    ar: "ممكن الرقم القومي بتاعه؟",
    en: "May I have their national ID number?",
  },
  "intake.ask_dob.other": {
    ar: "ممكن تاريخ ميلاده؟",
    en: "What's their date of birth?",
  },
  "intake.ask_email.other": {
    ar: "ممكن الإيميل بتاعه؟",
    en: "What's their email address?",
  },
  // The patient's own number, asked for explicitly.
  //
  // Without this question the staging RPC filled the field from the
  // conversation's own WhatsApp address, so every file the assistant opened for
  // a third party carried the *sender's* number. The question is the fix; the
  // refusal in `tools.stageIntake` is what makes the fallback unreachable.
  "intake.ask_phone": {
    ar: "ممكن رقم تليفونك؟",
    en: "What's your phone number?",
  },
  "intake.ask_phone.other": {
    ar: "ممكن رقم تليفون المريض؟",
    en: "What's the patient's phone number?",
  },
  // Optional, and the message says so. A patient who does not know, or would
  // rather not say, is not asked twice — see `resolveIntakeField`.
  "intake.ask_blood_type": {
    ar: "هل تعرف فصيلة دمك؟ دي اختيارية، وتقدر تقول «مش عارف» أو «تخطي».",
    en: "Do you know your blood type? It's optional — you can say \"skip\" or \"not sure\".",
  },
  "intake.ask_blood_type.other": {
    ar: "هل تعرف فصيلة دم المريض؟ دي اختيارية، وتقدر تقول «مش عارف» أو «تخطي».",
    en: "Do you know the patient's blood type? It's optional — you can say \"skip\" or \"not sure\".",
  },
  "intake.staged_other": {
    ar: "تمام، سجلت بيانات المريض للمراجعة من فريق العيادة.",
    en: "Thank you — the patient's details are recorded for the clinic team to review.",
  },
  "intake.existing_file": {
    ar: "تمام، لقيت ملف مسجل بالبيانات دي بالفعل، فمش محتاجين نفتح ملف جديد.",
    en: "I found an existing file with those details, so there's no need to open a new one.",
  },
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
  "info.departments": {
    ar: "الأقسام النشطة الموجودة في العيادة:{departments}",
    en: "Our departments:{departments}",
  },
  "info.doctors": { ar: "الدكاترة:{doctors}", en: "Our doctors:{doctors}" },
  "info.which_department": {
    ar: "أنهي قسم تحب تعرف دكاتره؟{options}",
    en: "Which department's doctors would you like?{options}",
  },
  // `{packages}` arrives as a finished block from `renderPackageGroups`: a
  // department heading, one package per line, the price on the same line as the
  // package it belongs to, and a blank line between departments. The same shape
  // the service catalog uses, deliberately — a patient reading both in one
  // message should not have to learn two layouts.
  "info.packages": {
    ar: "الباكيدجات المتاحة:\n\n{packages}",
    en: "Our packages:\n\n{packages}",
  },
  "info.packages_none": {
    ar: "مفيش باكيدجات مسجلة عندنا دلوقتي. فريق العيادة هيقدر يساعدك.",
    en: "There are no packages configured right now. The clinic team can help.",
  },
  // One package, as the clinic configured it. Session count, price and the
  // clinic's own note — and nothing else, because the contents of a package
  // exist in this system only if a person typed them into that note.
  "info.package_detail": { ar: "{package}", en: "{package}" },
  // A package this clinic does not have. Said plainly, then what it does have.
  "info.package_unknown": {
    ar: "الباكيدج ده مش موجود عندنا. دي الباكيدجات المتاحة:\n\n{packages}",
    en: "We don't have that package. Here are the ones we do offer:\n\n{packages}",
  },
  "info.my_packages": {
    ar: "باقاتك السارية:{packages}",
    en: "Your active packages:{packages}",
  },
  "info.my_appointments": { ar: "مواعيدك: {count}.", en: "Your appointments: {count}." },
  // `{services}` arrives as a finished block from `renderServiceGroups`: a
  // department heading, one service per line, the price on the same line as the
  // service it belongs to, and a blank line between departments. A catalog of
  // twelve services in one comma-separated paragraph is unreadable on WhatsApp
  // and detaches every price from the thing it is the price of.
  "info.services": {
    ar: "الخدمات والأسعار:\n\n{services}",
    en: "Our services and prices:\n\n{services}",
  },
  "info.services_none": {
    ar: "مفيش خدمات مسجلة عندنا بالسعر دلوقتي. فريق العيادة هيقدر يساعدك.",
    en: "There are no services with prices configured right now. The clinic team can help.",
  },

  // The clinic's stored contact settings.
  //
  // Every key below was reachable and unrendered. `answer_question`'s step
  // emitted `info.address`, `info.phone`, `info.website`, `info.email` and
  // `info.opening_hours`; none of them existed here; `composeDeterministic`
  // logged a warning, skipped the effect, and — with nothing else in the turn —
  // returned `clarify.open`. That is why «طيب والعنوان ورقم التليفون؟» inside a
  // live episode came back as «اتفضل، أقدر أساعدك في إيه؟».
  //
  // `{value}` is rendered by the flow step, not assembled here, so this table
  // stays what it is: sentences with holes in them.
  // Heading, then the value on its own line — the same section shape the lists
  // above use. An address, a phone number and a URL are all things a patient
  // copies out of the message, and a trailing full stop after one is something
  // they copy with it.
  "info.address": { ar: "عنوان العيادة:\n{value}", en: "Our address:\n{value}" },
  "info.phone": { ar: "رقم التليفون:\n{value}", en: "Our phone number:\n{value}" },
  "info.website": { ar: "موقعنا الإلكتروني:\n{value}", en: "Our website:\n{value}" },
  "info.email": { ar: "الإيميل:\n{value}", en: "Our email address:\n{value}" },
  "info.opening_hours": {
    ar: "مواعيد العمل:\n{value}",
    en: "Our opening hours:\n{value}",
  },
  "info.detail_unset": {
    // The clinic has not configured the field. An answer, and the only safe
    // one: the alternative to saying so is inventing an address.
    ar: "المعلومة دي مش مسجلة عندنا دلوقتي، بس فريق العيادة هيقدر يساعدك فيها.",
    en: "That isn't recorded in our settings right now, but the clinic team can help you with it.",
  },
  // `{insurers}` arrives as a finished numbered block from
  // `renderInsuranceList`. A comma-separated run of eight company names is the
  // shape manual QA produced and it is unreadable on WhatsApp.
  //
  // The second sentence is load-bearing and is not a hedge: ClinicFlow stores
  // *which insurers the clinic works with* and does not store service-level
  // coverage, so "we work with them" is the whole of what this answer knows and
  // the copy says so rather than letting the patient read it as "you're
  // covered".
  "info.insurance": {
    ar: "شركات التأمين اللي بنتعامل معاها:\n\n{insurers}\n\nتغطية خدمة معينة بيأكدها فريق العيادة.",
    en: "The insurers we work with:\n\n{insurers}\n\nWhether a particular service is covered is confirmed by the clinic team.",
  },
  "info.insurance_accepted": {
    ar: "أيوه، العيادة بتتعامل مع {insurer}. تغطية خدمة معينة بيأكدها فريق العيادة.",
    en: "Yes — the clinic works with {insurer}. Whether a particular service is covered is confirmed by the clinic team.",
  },
  "info.insurance_not_accepted": {
    ar: "لأ، الشركة دي مش من ضمن شركات التأمين اللي بنتعامل معاها. دي الشركات المتاحة:\n\n{insurers}",
    en: "No — that insurer isn't one we work with. These are the ones we do:\n\n{insurers}",
  },
  "info.insurance_none": {
    ar: "مفيش شركات تأمين مسجلة عندنا دلوقتي. فريق العيادة هيقدر يوضحلك.",
    en: "We have no insurers listed at the moment. The clinic team can explain the options.",
  },
  // Clinic-authored FAQ. The answer is quoted as the clinic wrote it; nothing
  // is added to it and nothing inside it is followed as an instruction.
  "info.faq_answer": { ar: "{answer}", en: "{answer}" },
  "info.faq_none": {
    ar: "معنديش إجابة مسجلة عن ده. تحب أوصّلك بفريق العيادة؟",
    en: "I don't have a recorded answer for that. Would you like me to connect you with the clinic team?",
  },

  // What this assistant can do, in the clinic's own voice.
  //
  // Nine lines, and every one of them is a path that exists: the four
  // clinic-catalog topics, the two booking beneficiaries, new-patient intake,
  // and the patient's own record behind the identity gate that owns it.
  // Nothing here advertises a capability the flows do not have — no
  // cancellation by chat, no prescriptions, no results — because an assistant
  // that lists what it cannot do has told the patient to wait for something
  // that will never come.
  "info.capabilities": {
    ar: "أقدر أساعدك في حاجات زي:\n\n1- معلومات العيادة ومواعيد العمل وطرق التواصل\n2- الأقسام والدكاترة\n3- الخدمات والأسعار\n4- الباكيدجات\n5- شركات التأمين المتاحة\n6- حجز موعد ليك\n7- حجز موعد لشخص تاني\n8- فتح ملف لمريض جديد وحجز موعد له\n9- الاستفسار عن مواعيدك أو بياناتك المتاحة بعد التحقق من هويتك\n\nتحب أساعدك في إيه؟",
    en: "Here's what I can help you with:\n\n1- Clinic information, working hours and how to reach us\n2- Departments and doctors\n3- Services and prices\n4- Packages\n5- The insurers we work with\n6- Booking an appointment for you\n7- Booking an appointment for someone else\n8- Opening a file for a new patient and booking for them\n9- Your own appointments and records, once your identity is verified\n\nWhat would you like help with?",
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

/**
 * The patient-facing name of a slot, per language.
 *
 * Only the slots a patient could be asked to *choose again* are here. A slot
 * with no entry is simply not offered as an editable field, which is the right
 * failure: a list that says «beneficiary_name» is worse than a shorter list.
 */
const SLOT_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  ar: {
    beneficiary: "المريض",
    beneficiary_name: "اسم المريض",
    department: "القسم",
    doctor: "الدكتور",
    day: "اليوم",
    time: "الوقت",
    service: "الخدمة",
    full_name: "الاسم",
    national_id: "الرقم القومي",
    date_of_birth: "تاريخ الميلاد",
    email: "الإيميل",
    phone: "رقم التليفون",
    blood_type: "فصيلة الدم",
  },
  en: {
    beneficiary: "who it's for",
    beneficiary_name: "the patient's name",
    department: "the department",
    doctor: "the doctor",
    day: "the day",
    time: "the time",
    service: "the service",
    full_name: "the name",
    national_id: "the national ID",
    date_of_birth: "the date of birth",
    email: "the email address",
    phone: "the phone number",
    blood_type: "the blood type",
  },
};

/** Exported for the copy-parity test: both languages, for every slot. */
export const COMPOSER_SLOT_LABELS = SLOT_LABELS;

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
 * The one line an informational answer may end with.
 *
 * ## Why this exists
 *
 * The legacy assistant volunteered the next move — "shall I book you in?" after
 * a price list, "would you like their available times?" after a doctor roster —
 * because its prompt told it to. V2 removed the prompt and did not replace the
 * behaviour, so every answer ended flat and the conversation felt like a
 * lookup service. This restores it as **data**: a server-authored sentence per
 * copy key, chosen deterministically, never generated.
 *
 * ## The three rules that keep it from becoming noise
 *
 *   1. **Only after an answer.** A turn that asked the patient something —
 *      any `ask`, `offer` or `handoff` — appends nothing, because two questions
 *      in one message is the collision the whole engine is built to avoid, and
 *      an active booking must never be interrupted by an offer to start one.
 *   2. **One per turn, and only for the last thing said.** A compound answer
 *      about the address, the phone and the departments ends with one
 *      invitation, not three.
 *   3. **Not every key has one.** A privacy explanation, a handoff or a
 *      completed booking ends where it ends. Mechanically appending "anything
 *      else?" to everything is what makes an assistant feel automated.
 *
 * Server-authored strings only, so the grounding ledger and `introducesNumbers`
 * are unaffected — there is no number and no name in any of them.
 */
const NEXT_STEP: Record<string, Copy> = {
  "info.departments": {
    ar: "تحب أعرفك خدمات قسم معين، ولا نحجزلك موعد؟",
    en: "Would you like the services of a particular department, or shall I book you an appointment?",
  },
  "info.doctors": {
    ar: "تحب تحجز مع دكتور منهم؟",
    en: "Would you like to book with one of them?",
  },
  "info.services": {
    ar: "تحب تحجز موعد في القسم ده؟",
    en: "Would you like to book an appointment in that department?",
  },
  "info.packages": {
    ar: "تحب أساعدك تحجز موعد؟",
    en: "Would you like me to help you book an appointment?",
  },
  "info.address": {
    ar: "تحب أساعدك في حجز موعد؟",
    en: "Would you like help booking an appointment?",
  },
  "info.phone": {
    ar: "تحب أساعدك في حجز موعد؟",
    en: "Would you like help booking an appointment?",
  },
  "info.opening_hours": {
    ar: "تحب أشوفلك المواعيد المتاحة؟",
    en: "Shall I look up the available appointment times for you?",
  },
  "info.insurance": {
    ar: "تحب أساعدك في حجز موعد؟",
    en: "Would you like help booking an appointment?",
  },
  "info.insurance_accepted": {
    ar: "تحب أساعدك في حجز موعد؟",
    en: "Would you like help booking an appointment?",
  },
  "info.package_detail": {
    ar: "تحب أساعدك تحجز موعد؟",
    en: "Would you like me to help you book an appointment?",
  },
  // The end of a booking, and the start of whatever comes next.
  //
  // Without this the assistant said what it had recorded and then stopped
  // dead, which manual QA read — correctly — as the conversation being over.
  // It is deliberately an *open* question and not "would you like to book
  // another one": the answer may be a clinic question, a second booking, a
  // package or an insurer, and the engine's stack is already clear by the time
  // it is asked, so nothing about the finished booking leaks into whatever the
  // patient says next.
  //
  // Both booking keys carry it, because a repeated confirmation of a request
  // that was already in leaves the patient in exactly the same place.
  "booking.created": {
    ar: "أقدر أساعدك في حاجة تانية؟",
    en: "Is there anything else I can help you with?",
  },
  "booking.already_requested": {
    ar: "أقدر أساعدك في حاجة تانية؟",
    en: "Is there anything else I can help you with?",
  },
};

/** Exported for the copy-parity test: both languages, for every key. */
export const COMPOSER_NEXT_STEP = NEXT_STEP;

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

/**
 * Facts that arrive as a finished, multi-line block of server-rendered layout.
 *
 * The composer inserts them verbatim and, crucially, marks the message
 * `structured` — which is what keeps the polish pass away from it (see
 * {@link compose}). A model told to make a message "sound natural and brief"
 * turns a grouped price list back into a paragraph and a labelled summary back
 * into a sentence, and the grounding check cannot catch either: every name and
 * every number survives the flattening. These layouts are decided by
 * `lib/ai/v2/present.ts`, which is the only place in the system that decides
 * them, and they reach the patient exactly as it composed them.
 */
const LAYOUT_FACTS: ReadonlySet<string> = new Set([
  "summary",
  "services",
  // The package catalog, one package's detail block, and the numbered insurer
  // list. All three are rendered by `lib/ai/v2/present.ts` and all three are
  // exactly the kind of layout a "make this sound natural" pass flattens back
  // into the paragraph it replaced.
  "packages",
  "package",
  "insurers",
]);

/**
 * Fills a copy template, and reports whether the result carries a rendered
 * list.
 *
 * `structured` is what stops the polish pass from touching it — see
 * {@link compose}. A model asked to make a numbered list "sound natural" turns
 * it back into the comma-separated paragraph this whole change exists to
 * remove, and formatting is not a thing a generation should be responsible for
 * when the server already knows the answer.
 */
function fill(
  template: string,
  facts: Record<string, unknown>,
): { text: string; structured: boolean } {
  let structured = false;
  // A space in front of a list placeholder is absorbed by the renderer.
  //
  // The two shapes need different leading whitespace — an inline list wants one
  // space, a numbered block wants a blank line — and the template cannot know
  // which it will get. Letting `renderOptions` own the join means the copy
  // reads naturally either way and no template has to be written twice.
  const text = template.replace(/ ?\{(\w+)\}/g, (match, name: string) => {
    const value = facts[name];
    if (value === null || value === undefined) return "";
    if (!Array.isArray(value)) {
      if (LAYOUT_FACTS.has(name)) structured = true;
      return match.startsWith(" ") ? ` ${value}` : String(value);
    }
    const items = value.map((item) => String(item));
    if (items.length === 0) return "";
    const rendered = renderOptions(items);
    if (rendered.structured) structured = true;
    return rendered.text;
  });
  return { text, structured };
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
  /**
   * True when the message carries server-rendered structure — a numbered
   * choice list, or a block list of services. Such a message is not polished.
   */
  structured: boolean;
} {
  const parts: string[] = [];
  let structured = false;
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
    // Slot names are internal vocabulary and must never reach a patient. The
    // engine decides *which* fields are editable; the language they are named
    // in is a presentation decision and is made here, once, so no flow has to
    // carry a translation table.
    if (Array.isArray(facts.fields)) {
      facts.fields = (facts.fields as unknown[])
        .map((name) => SLOT_LABELS[input.locale][String(name)])
        .filter((label): label is string => Boolean(label));
    }
    // Out of the facts before anything renders or prompts with them.
    for (const key of LINK_FACTS) {
      const value = facts[key];
      delete facts[key];
      if (typeof value === "string" && value.length > 0) links.push(value);
    }
    // The one key that varies on a fact rather than on a step.
    if (key === "clarify.open" && facts.parked_flow) key = "clarify.open.with_parked";
    // A clarification that knows which field it was asking for says so.
    //
    // Most specific first — slot plus variant, then slot, then the generic line
    // the effect actually carried. The last of those is always present, so a
    // slot with no repair copy of its own is answered exactly as it was before
    // and no path here can end without a sentence.
    if (effect.kind === "ask" && effect.slot) {
      const bySlot = `${key}.${effect.slot}`;
      const byVariant = effect.variant ? `${bySlot}.${effect.variant}` : null;
      if (byVariant && COPY[byVariant]) key = byVariant;
      else if (COPY[bySlot]) key = bySlot;
    }
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
    // Merged for the polish grounding check, without letting one effect's facts
    // erase another's.
    //
    // A plain `Object.assign` was correct while a turn produced one effect. Now
    // that a compound question answers the address, the phone and the
    // departments in one message, three effects arrive carrying a `value` each
    // and the last one silently won — so the grounding check verified one third
    // of the reply and a polish that dropped the address passed it. Colliding
    // keys are suffixed instead; `polish` reads `Object.values`, so the names
    // are bookkeeping and only the set of values matters.
    for (const [name, value] of Object.entries(facts)) {
      if (!(name in allFacts)) {
        allFacts[name] = value;
        continue;
      }
      if (allFacts[name] === value) continue;
      allFacts[`${name}__${keys.length}`] = value;
    }
    const filled = fill(copy[input.locale], facts);
    if (filled.structured) structured = true;
    parts.push(filled.text.trim());
  }
  // The one invitation, chosen from the last thing actually said.
  //
  // `asked` is the same predicate `runEngine` uses to decide whether a turn has
  // already produced a question, restated here over effects rather than over
  // state — an informational turn that ended in an offer ("which department?")
  // is a question, and a question does not get a second one stapled to it.
  const asked = input.effects.some(
    (effect) =>
      effect.kind === "ask" || effect.kind === "offer" || effect.kind === "handoff",
  );
  const invitation = asked ? null : NEXT_STEP[keys[keys.length - 1] ?? ""];
  // Counted before the invitation is appended. "Several things were answered"
  // is what makes a message a structured one the polish pass must not touch,
  // and a single answer plus its follow-on line is still a single answer — it
  // would be a strange regression for adding a friendly sentence to be the
  // thing that stopped the clinic's dialect being applied to the one above it.
  const sections = parts.filter(Boolean).length;
  if (invitation && parts.length > 0) parts.push(invitation[input.locale]);

  // A blank line between sections, not a newline.
  //
  // One turn can now answer several things — the address, the phone number, the
  // departments and the price list, in the order the patient asked for them.
  // Joined with a single newline those run together into the dense paragraph
  // manual QA reported; the blank line is what makes each answer findable.
  const text = parts.filter(Boolean).join(SECTION_SEPARATOR);
  return {
    text: text || COPY["clarify.open"]![input.locale],
    facts: allFacts,
    keys,
    links,
    structured: structured || sections > 1,
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
        "Never mention systems, tools, fields or internal terms. Reply with the message only.\n" +
        // The clinic's configured register and its fenced style note, from the
        // same tables the legacy prompt is built from. See
        // `buildStyleNoteForRewrite`.
        buildStyleNoteForRewrite(input.style, input.locale),
      messages: [{ role: "user", content: input.text }],
    });
    const candidate = (result.text ?? "").trim();
    if (!candidate) return { text: input.text, outcome: "deterministic" };
    // The grounding check, at the granularity that matters here: every literal
    // the server supplied must survive the rewrite. A polish that dropped the
    // doctor's name or changed a time is not a polish.
    const kept = factValues.every((value) => candidate.includes(value));
    if (!kept) return { text: input.text, outcome: "deterministic" };
    // The other half of grounding, and the half that was missing: a rewrite
    // may not *add* a number either.
    //
    // Retention alone catches a polish that drops a price. It does not catch
    // one that keeps every price it was given and helpfully lists two more
    // services beside them — which is precisely what a catalog answer invites,
    // and a fabricated price is the worst thing on this surface to invent. Any
    // numeric literal in the rewrite that was not in the deterministic
    // sentence discards the rewrite, and the deterministic sentence was
    // already correct.
    if (introducesNumbers(input.text, candidate)) {
      return { text: input.text, outcome: "deterministic" };
    }
    return { text: candidate, outcome: "polished" };
  } catch (error) {
    Sentry.captureException(error, { tags: { area: "patient-ai-v2-composer" } });
    return { text: input.text, outcome: "deterministic" };
  }
}

/**
 * True when the rewrite contains a number the source did not.
 *
 * Digits are folded from Arabic-Indic first, so a model that renders ١٤٠٠ for
 * 1400 is preserving the fact rather than inventing one. Separators inside a
 * number are ignored for the same reason: 1,400 and 1400 are one number.
 */
export function introducesNumbers(source: string, candidate: string): boolean {
  const numbers = (text: string): Set<string> => {
    const folded = text
      .replace(/[٠-٩۰-۹]/g, (digit) => {
        const code = digit.codePointAt(0)!;
        return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
      })
      .replace(/(?<=\d)[,\u066c\s](?=\d{3}\b)/g, "");
    return new Set(
      [...folded.matchAll(/\d+(?:[.\u066b]\d+)?/g)].map((match) =>
        // Trailing zeros after a decimal point are formatting, not a different
        // amount.
        String(Number(match[0].replace("\u066b", "."))),
      ),
    );
  };
  const before = numbers(source);
  for (const value of numbers(candidate)) {
    if (!before.has(value)) return true;
  }
  return false;
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
  // Deterministic layout is not the model's to rewrite.
  //
  // A numbered list of doctors, a block of services with their prices, or a
  // multi-section answer to a compound question is *already* the presentation
  // the patient should get. Handing it to a rewrite whose instruction is "make
  // this sound natural and brief" invites exactly the flattening this change
  // removed — and the grounding check cannot catch it, because a paragraph that
  // keeps every name and every price passes. So the polish pass keeps the turns
  // it was written for, which are the prose ones, and structured output goes to
  // the patient exactly as the server composed it.
  const polished =
    input.execution && !base.structured
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
