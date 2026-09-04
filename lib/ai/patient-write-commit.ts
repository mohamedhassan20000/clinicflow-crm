import type { BookingAuthority } from "@/lib/ai/booking-authority";
import type { GroundingLedger } from "@/lib/ai/patient-grounding";
import {
  formatPersonName,
  localizeEntityLabel,
} from "@/lib/ai/entity-labels";
import {
  buildIntakeQuestion,
  patientFacingFieldList,
} from "@/lib/ai/patient-intake-contract";

export type PatientWriteReplyEnforcement = {
  text: string;
  outcome:
    | "passthrough"
    | "committed"
    | "clarification"
    | "failed"
    | "unbacked_claim";
  operation: "register_patient" | "create_preliminary_booking" | null;
  entityId: string | null;
};

type RecordValue = Record<string, unknown>;

/**
 * P11H — the final patient-facing commit boundary.
 *
 * A tool call is not a commit receipt. A model sentence is not a commit
 * receipt. Only a validated tool result containing the entity returned by the
 * authoritative server write may produce success copy. Write turns therefore
 * finish with deterministic copy derived from that result, while failures and
 * missing receipts finish with an accurate recovery path.
 */
export function enforcePatientWriteReply(input: {
  locale: "ar" | "en";
  text: string;
  authority: BookingAuthority | null;
  ledger: GroundingLedger;
}): PatientWriteReplyEnforcement {
  const bookingResult = asRecord(input.ledger.resultFor("create_preliminary_booking"));
  if (bookingResult) {
    return bookingReply(input.locale, bookingResult);
  }

  const registrationResult = asRecord(input.ledger.resultFor("register_patient"));
  const registrationContinuation =
    input.ledger.resultFor("list_available_days") !== null ||
    input.ledger.resultFor("check_availability") !== null
      ? input.text.trim()
      : null;
  if (registrationResult && registrationCommitted(registrationResult)) {
    return registrationReply(input.locale, registrationResult, registrationContinuation);
  }
  if (
    registrationResult &&
    registrationNeedsClarification(
      registrationResult,
      readString(registrationResult.reason),
    )
  ) {
    return registrationReply(input.locale, registrationResult, registrationContinuation);
  }

  const operation = input.authority?.operation;
  if (input.authority?.requirement === "write_authority") {
    if (operation === "register_patient") {
      return registrationResult
        ? registrationReply(input.locale, registrationResult, registrationContinuation)
        : missingReceiptReply(input.locale, "register_patient");
    }
    if (operation === "create_preliminary_booking") {
      return missingReceiptReply(input.locale, "create_preliminary_booking");
    }
  }

  // A write can be attempted opportunistically on a stage whose opening
  // authority was a read. A failed registration may still be followed by a
  // useful roster answer in that same turn, so only replace it outside the
  // write rung when the final sentence itself claims a commit.
  if (
    registrationResult &&
    hasPatientWriteSuccessClaim(input.text)
  ) {
    return registrationReply(input.locale, registrationResult, registrationContinuation);
  }

  // Before `done`, success wording with no receipt is simulated success. This
  // is a final defensive check for a model that ignores both the stage prompt
  // and the forced tool choice.
  if (
    input.authority &&
    input.authority.step !== "done" &&
    hasPatientWriteSuccessClaim(input.text)
  ) {
    return {
      text: unbackedClaimReply(input.locale, input.authority.step),
      outcome: "unbacked_claim",
      operation: null,
      entityId: null,
    };
  }

  return {
    text: input.text,
    outcome: "passthrough",
    operation: null,
    entityId: null,
  };
}

/**
 * F-8 — the correction, plus the question the turn still owes the patient.
 *
 * The replacement used to end on the correction: *"لسه ما تمّش إنشاء ملف مريض
 * أو طلب حجز في النظام. خلّيني أكمّل الخطوة المطلوبة أولًا…"*. True, and a
 * conversational dead end — it restates no outstanding question, so a patient
 * reading it has nothing to answer, and on a turn that also owed them a
 * clarification the correction displaced the question entirely.
 *
 * The question is composed from the ladder step the server already computed for
 * this turn, so it names nothing the server has not established: every rung
 * before the current one is settled by definition, and the rung itself is asked
 * generically ("which day suits you?") rather than with a value that would have
 * to come from somewhere. Nothing here can invent a doctor, a day or a time.
 */
function unbackedClaimReply(locale: "ar" | "en", step: BookingAuthority["step"]): string {
  const ar = locale === "ar";
  const correction = ar
    ? "لسه ما تمّش إنشاء ملف مريض أو طلب حجز في النظام."
    : "No patient file or appointment request has been created in the system yet.";
  const question = OUTSTANDING_STEP_QUESTION[step]?.[ar ? "ar" : "en"] ?? null;
  if (!question) {
    return ar
      ? `${correction} خلّيني أكمّل الخطوة المطلوبة أولًا، ولو تعذّر هقولك بوضوح.`
      : `${correction} I need to complete the required step first, and I will tell you clearly if it cannot be completed.`;
  }
  return ar ? `${correction} ${question}` : `${correction} ${question}`;
}

/**
 * The one question each rung of the ladder is waiting on, in ordinary words.
 *
 * Generic by construction: no name, no date, no time, no department. A rung
 * whose question would need a server value it may not have — `confirm`, `done`
 * — has none, and falls back to the plain correction.
 */
const OUTSTANDING_STEP_QUESTION: Partial<
  Record<BookingAuthority["step"], { ar: string; en: string }>
> = {
  department: {
    ar: "تحب تحجز في أنهي قسم؟",
    en: "Which department would you like to book in?",
  },
  doctor: {
    ar: "تحب تحجز مع مين من الدكاترة اللي اتعرضوا عليك؟",
    en: "Which of the doctors you were shown would you like to book with?",
  },
  day: {
    ar: "تحب أنهي يوم من الأيام المتاحة اللي اتعرضت عليك؟",
    en: "Which of the available days you were shown suits you?",
  },
  time: {
    ar: "تحب أنهي معاد من المواعيد اللي اتعرضت عليك؟",
    en: "Which of the times you were shown suits you?",
  },
  intake: {
    ar: "نكمل بيانات الملف الأول؟",
    en: "Shall we finish the details for the file first?",
  },
};

/**
 * F-7 — the negations that turn a success claim into its opposite.
 *
 * The Arabic patterns below read "تم … حجز" as a completed write, and they read
 * it just as happily out of "لسه ما تمّش إنشاء ملف مريض أو طلب حجز في النظام" —
 * which is this module's *own* denial copy. Two costs, both real if minor: the
 * gate replaced an honest denial with its own denial, and the audit emitted
 * `fallback_reason: write_unbacked_claim` on turns where nothing had gone
 * wrong, which made the one metric built for triaging this class of defect
 * unusable for it.
 *
 * A negation marker is checked against the *whole* sentence containing the
 * claim rather than the whole message, so "لم يتم إنشاء طلب الموعد. تم حفظ
 * الملف." still reports the second half as a claim.
 */
/** The Arabic letter block plus its diacritics — `تمّش` carries a shadda. */
const AR = "\\u0621-\\u065F\\u0670-\\u06D3";
const WRITE_DENIAL_MARKERS: readonly RegExp[] = [
  // Arabic negative particles, as whole words. The boundaries are lookarounds
  // over the Arabic block rather than `\b`, which is defined against
  // `[A-Za-z0-9_]` and therefore never exists between two Arabic letters — so a
  // bare `ما` in the alternation would have matched inside `تمام`.
  new RegExp(`(?<![${AR}])(?:لم|لن|ما|مش|مافيش|مفيش|لسه|لسّه|لا|بدون|دون)(?![${AR}])`, "u"),
  // The colloquial ما…ش circumfix: `ما تمّش`, `متمش`, `ماتعملش`.
  new RegExp(`(?<![${AR}])(?:ما\\s?[${AR}]{2,10}ش|م[${AR}]{2,8}ش)(?![${AR}])`, "u"),
  new RegExp(`(?<![${AR}])(?:تعذّر|تعذر|فشل|غير)(?![${AR}])`, "u"),
  // English.
  /\b(?:no|not|never|nothing|cannot|can'?t|could\s*not|couldn'?t|has\s*not|hasn'?t|have\s*not|haven'?t|was\s*not|wasn'?t|is\s*not|isn'?t|yet\s*to|failed\s*to|unable\s*to)\b/i,
];

/** The sentence a match sits in — negation scopes to a sentence, not a message. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?؟\n])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDenied(sentence: string): boolean {
  return WRITE_DENIAL_MARKERS.some((pattern) => pattern.test(sentence));
}

/**
 * Bilingual success-claim detector for the only two languages this persona
 * emits. Negation-aware since F-7: a sentence that denies the write is not a
 * claim that it happened.
 */
export function hasPatientWriteSuccessClaim(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const sentences = sentencesOf(normalized);
  if (sentences.length > 1) {
    return sentences.some((sentence) => hasPatientWriteSuccessClaim(sentence));
  }
  if (isDenied(normalized)) return false;
  const english = [
    /\b(?:i have|i've|we have|we've)\s+(?:created|opened|registered|booked|reserved|submitted|sent)\b/,
    /\b(?:patient (?:file|record)|appointment(?: request)?|booking)\s+(?:has been|is|was)\s+(?:created|opened|registered|booked|reserved|submitted|sent)\b/,
    /\b(?:done|all set)\b[^.\n]{0,80}\b(?:appointment|booking|patient file|patient record)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (english) return true;
  return [
    /(?:تم|اتم|اتعمل|أنشأت|انشأت|فتحنا|فتحت|سجلنا|سجلت|حجزنا|حجزت|بعتنا|بعتّ|أرسلنا|ارسلت)[^\n.]{0,60}(?:ملف|مريض|حجز|موعد|طلب)/,
    /(?:ملف|حجز|موعد|طلب)[^\n.]{0,60}(?:تم|اتعمل|اتحجز|اتسجل|اترسل|اتبعث|جاهز)/,
  ].some((pattern) => pattern.test(normalized));
}

function bookingReply(
  locale: "ar" | "en",
  result: RecordValue,
): PatientWriteReplyEnforcement {
  const requestId = readId(result.request_id);
  const appointmentId = readId(result.appointment_id);
  const entityId = requestId ?? appointmentId;
  const entity = asRecord(result.created_entity);
  const doctor = asRecord(entity?.doctor);
  const department = asRecord(entity?.department);
  const doctorId = readId(doctor?.id);
  const doctorName = readString(doctor?.name);
  const departmentId = readId(department?.id);
  const departmentName = readString(department?.name);
  const subjectId = readId(entity?.subject_id);
  const subject = readString(entity?.booking_subject);
  const localDate = readString(entity?.scheduled_local_date);
  const localTime = readString(entity?.scheduled_local_time);
  const committed =
    result.created === true &&
    result.status === "pending" &&
    entityId !== null &&
    entity?.id === entityId &&
    entity.status === "pending" &&
    (subject === "linked_patient" ||
      subject === "patient_intake" ||
      subject === "third_party_intake") &&
    subjectId !== null &&
    doctorId !== null &&
    doctorName !== null &&
    departmentId !== null &&
    departmentName !== null &&
    Boolean(localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) &&
    Boolean(localTime && /^\d{2}:\d{2}$/.test(localTime)) &&
    typeof entity.scheduled_at === "string" &&
    typeof entity.expires_at === "string" &&
    result.expires_at === entity.expires_at;
  if (committed) {
    const doctorLabel = formatPersonName(doctorName, locale);
    const departmentLabel = localizeEntityLabel(departmentName, locale);
    return {
      text: locale === "ar"
        ? `تمام، تم إرسال طلب الحجز مع ${doctorLabel} في ${departmentLabel} يوم ${localDate} الساعة ${localTime}. الطلب حاليًا قيد التأكيد، وحد من فريق العيادة هيتواصل معاك لتأكيد الموعد.`
        : `Your appointment request with ${doctorLabel} in ${departmentLabel} on ${localDate} at ${localTime} has been submitted. It is pending confirmation, and the clinic team will contact you to confirm it.`,
      outcome: "committed",
      operation: "create_preliminary_booking",
      entityId,
    };
  }

  const reason = readString(result.reason);
  const text = bookingFailureCopy(locale, reason, readString(result.clinic_phone));
  return {
    text,
    outcome: "failed",
    operation: "create_preliminary_booking",
    entityId: null,
  };
}

function registrationReply(
  locale: "ar" | "en",
  result: RecordValue,
  continuation: string | null = null,
): PatientWriteReplyEnforcement {
  const intakeId = readId(result.intake_id);
  if (result.intake_staged === true && intakeId) {
    return {
      text: locale === "ar"
        ? `تم إنشاء ملف المريض بنجاح، وهو بانتظار مراجعة العيادة.${continuation ? `\n\n${continuation}` : " هنكمل دلوقتي باختيار الموعد المناسب."}`
        : `The patient file was created successfully and is awaiting clinic review.${continuation ? `\n\n${continuation}` : " We can now continue with choosing an appointment."}`,
      outcome: "committed",
      operation: "register_patient",
      entityId: intakeId,
    };
  }
  if (result.registered === true && result.matched_existing === true) {
    return {
      text: locale === "ar"
        ? `تمت مطابقة سجل مريض موجود بشكل موثوق.${continuation ? `\n\n${continuation}` : " هنكمل دلوقتي باختيار الموعد المناسب."}`
        : `An existing patient record was authoritatively matched.${continuation ? `\n\n${continuation}` : " We can now continue with choosing an appointment."}`,
      outcome: "committed",
      operation: "register_patient",
      entityId: null,
    };
  }

  const fields = Array.isArray(result.fields)
    ? result.fields.filter((field): field is string => typeof field === "string")
    : [];
  const reason = readString(result.reason);
  const recoverable = registrationNeedsClarification(result, reason);
  // P11J-2 — this is where `national_id, date_of_birth, phone` reached a real
  // patient. The tool's `fields` array is a machine-facing list of schema keys;
  // it is now translated through the patient-facing language layer and, for a
  // missing-data outcome, turned into an actual question instead of a list.
  const subject = result.for_someone_else === true ? "other" as const : "self" as const;
  const question =
    reason === "unreadable_fields" ? buildIntakeQuestion(fields, locale, { subject }) : null;
  const fieldList = fields.length > 0 ? patientFacingFieldList(fields, locale) : "";
  if (recoverable) {
    return {
      text:
        readString(result.patient_question) ??
        readString(result.clarification) ??
        registrationClarificationCopy(locale, reason, fieldList, question),
      outcome: "clarification",
      operation: "register_patient",
      entityId: null,
    };
  }
  return {
    text: locale === "ar"
      ? registrationFailureCopyAr(reason, fieldList, question)
      : registrationFailureCopyEn(reason, fieldList, question),
    outcome: "failed",
    operation: "register_patient",
    entityId: null,
  };
}

/**
 * Normalization refusals are questions, not failed writes.
 *
 * These results are returned before the registration RPC is called. Treating
 * them as a write failure was both inaccurate and terminal: the patient heard
 * that their file could not be saved when the server had only asked which date
 * they meant. The explicit flag is authoritative and the reason list keeps
 * compatibility with older tool results that predate it.
 */
function registrationNeedsClarification(
  result: RecordValue,
  reason: string | null,
): boolean {
  if (result.needs_clarification === true) return true;
  return reason !== null && [
    "ambiguous_date",
    "incomplete_date",
    "conflicting_date",
    "unrecognized",
    "unrecognized_date",
    "unrecognized_input",
  ].includes(reason);
}

function registrationClarificationCopy(
  locale: "ar" | "en",
  reason: string | null,
  fields: string,
  question: string | null,
): string {
  if (reason === "unreadable_fields") {
    return locale === "ar"
      ? question ?? "ممكن نكمل بيانات الملف؟"
      : question ?? "Could we finish the details for the file?";
  }
  if (reason === "conflicting_details") {
    return locale === "ar"
      ? fields
        ? `وصلني قيمتين مختلفتين لـ${fields}. أنهي واحدة الصح؟`
        : "وصلني قيمتين مختلفتين لنفس البيان. أنهي واحدة الصح؟"
      : fields
        ? `I have two different values for the ${fields.toLowerCase()}. Which one is correct?`
        : "I have two different values for the same detail. Which one is correct?";
  }
  if (locale === "ar") {
    if (reason === "ambiguous_date") {
      return "تاريخ الميلاد ممكن يتفهم بطريقتين. ممكن تكتب اليوم واسم الشهر بالكلمات والسنة؟";
    }
    if (reason === "conflicting_date") {
      return "وصلني تاريخين مختلفين للميلاد. أنهي تاريخ هو الصحيح؟";
    }
    if (
      reason === "incomplete_date" ||
      reason === "unrecognized" ||
      reason === "unrecognized_date" ||
      reason === "unrecognized_input"
    ) {
      return "ممكن تكتب تاريخ الميلاد كامل: اليوم واسم الشهر بالكلمات والسنة؟";
    }
    return "محتاج أوضّح بيان واحد قبل ما نكمل. ممكن تكتبه مرة تانية؟";
  }
  if (reason === "ambiguous_date") {
    return "That date of birth could be read in two ways. Could you send the day, the month in words, and the year?";
  }
  if (reason === "conflicting_date") {
    return "I have two different dates of birth. Which date is correct?";
  }
  if (
    reason === "incomplete_date" ||
    reason === "unrecognized" ||
    reason === "unrecognized_date" ||
    reason === "unrecognized_input"
  ) {
    return "Could you send the complete date of birth: day, month in words, and year?";
  }
  return "I need to clarify one detail before we continue. Could you send it again?";
}

function registrationCommitted(result: RecordValue): boolean {
  return (
    (result.intake_staged === true && readId(result.intake_id) !== null) ||
    (result.registered === true && result.matched_existing === true)
  );
}

function missingReceiptReply(
  locale: "ar" | "en",
  operation: "register_patient" | "create_preliminary_booking",
): PatientWriteReplyEnforcement {
  return {
    text: operation === "register_patient"
      ? locale === "ar"
        ? "تعذّر حفظ ملف المريض المقترح في النظام، لذلك لم يُنشأ ملف ولم يتم حجز موعد. سيتابع معك فريق العيادة."
        : "The proposed patient file could not be saved in the system, so no file or appointment was created. Clinic staff will follow up with you."
      : locale === "ar"
        ? "تعذّر إنشاء طلب الموعد في النظام، لذلك الموعد غير محجوز. يمكننا إعادة التحقق من المواعيد المتاحة أو تحويلك لفريق العيادة."
        : "The appointment request could not be created in the system, so the appointment is not booked. We can recheck availability or pass you to clinic staff.",
    outcome: "failed",
    operation,
    entityId: null,
  };
}

function bookingFailureCopy(
  locale: "ar" | "en",
  reason: string | null,
  clinicPhone: string | null,
): string {
  if (locale === "ar") {
    if (reason === "intake_required") return "لم يُنشأ طلب الموعد لأن ملف الاستقبال المقترح غير محفوظ بعد. سأجمع البيانات الناقصة أولًا، ولن أنسب الحجز إلى شخص آخر.";
    if (reason === "minimum_notice") return clinicPhone
      ? `الحجز عن طريق المساعد يحتاج يكون قبل الموعد بـ24 ساعة على الأقل. تقدر تتواصل مع العيادة على ${clinicPhone} وهم يساعدوك في الحجز.`
      : "الحجز عن طريق المساعد يحتاج يكون قبل الموعد بـ24 ساعة على الأقل. تقدر تتواصل مع فريق العيادة وهم يساعدوك في الحجز.";
    if (reason === "slot_unavailable" || reason === "slot_not_offered") return "لم يُنشأ طلب الموعد لأن الوقت المختار لم يعد متاحًا أو لم يكن ضمن الأوقات المعروضة. نحتاج لاختيار وقت متاح.";
    if (reason === "patient_pending_cap") return "لم يُنشأ طلب جديد لأن هناك طلب موعد معلّقًا بالفعل لهذا المريض. سيتابع فريق العيادة الطلب الحالي.";
    if (reason === "slot_pending_cap") return "لم يُنشأ طلب الموعد لأن هذا الوقت وصل إلى حد الطلبات المعلّقة. نحتاج لاختيار وقت آخر.";
    return "تعذّر إنشاء طلب الموعد في النظام، لذلك الموعد غير محجوز. يمكننا إعادة التحقق من المواعيد أو تحويلك لفريق العيادة.";
  }
  if (reason === "intake_required") return "The appointment request was not created because the proposed intake file has not been saved yet. I will collect what is missing first and will not book it under another person.";
  if (reason === "minimum_notice") return clinicPhone
    ? `Assistant booking requires at least 24 hours' notice. You can contact the clinic at ${clinicPhone} and the team will help you book.`
    : "Assistant booking requires at least 24 hours' notice. Please contact the clinic team and they will help you book.";
  if (reason === "slot_unavailable" || reason === "slot_not_offered") return "The appointment request was not created because that time is no longer available or was not one of the offered times. We need to choose an available time.";
  if (reason === "patient_pending_cap") return "No new request was created because this patient already has an active pending appointment request. Clinic staff will review the existing request.";
  if (reason === "slot_pending_cap") return "The appointment request was not created because that time has reached its pending-request limit. We need to choose another time.";
  return "The appointment request could not be created in the system, so the appointment is not booked. We can recheck availability or pass you to clinic staff.";
}

function registrationFailureCopyAr(
  reason: string | null,
  fields: string,
  question: string | null,
): string {
  // A missing detail is asked for, never listed. The question already reads as
  // something a person would say, so nothing is prefixed to it.
  if (reason === "unreadable_fields" && question) return question;
  if (reason === "unreadable_fields") return "ممكن نكمل بيانات الملف؟";
  if (reason === "conflicting_details") return fields
    ? `وصلني قيمتين مختلفتين لـ${fields}. أنهي واحدة الصح؟`
    : "وصلني قيمتين مختلفتين لنفس البيان. أنهي واحدة الصح؟";
  if (reason === "assignment_required") return "البيانات الشخصية معايا. تحب الملف يكون تابع لأنهي قسم، ومع أنهي دكتور؟";
  if (reason === "name_spelling_confirmation_required") return "لم يتم حفظ ملف المريض بعد لأن كتابة الاسم بالإنجليزية ما زالت تحتاج تأكيد المريض.";
  // The loop guard's own copy: it names nothing and asks for nothing, because
  // asking again is exactly what it exists to stop.
  if (reason === "intake_repeated_question") return "معلش، البيانات مش راكبة معايا صح. حد من فريق العيادة هيكمل الملف معاك ويأكدلك الموعد.";
  return "تعذّر حفظ ملف المريض المقترح في النظام، لذلك لم يتم إنشاء ملف أو طلب موعد. سيتابع معك فريق العيادة.";
}

function registrationFailureCopyEn(
  reason: string | null,
  fields: string,
  question: string | null,
): string {
  if (reason === "unreadable_fields" && question) return question;
  if (reason === "unreadable_fields") return "Could we finish the details for the file?";
  if (reason === "conflicting_details") return fields
    ? `I have two different values for the ${fields.toLowerCase()}. Which one is correct?`
    : "I have two different values for the same detail. Which one is correct?";
  if (reason === "assignment_required") return "I have the personal details. Which department should the file be under, and which doctor?";
  if (reason === "name_spelling_confirmation_required") return "The patient file has not been saved yet because the English spelling of the name still needs the patient's confirmation.";
  if (reason === "intake_repeated_question") return "I am not reading those details correctly. A member of the clinic team will finish the file with you and confirm the appointment.";
  return "The proposed patient file could not be saved in the system, so no file or appointment request was created. Clinic staff will follow up with you.";
}

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readId(value: unknown): string | null {
  const id = readString(value);
  return id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id : null;
}
