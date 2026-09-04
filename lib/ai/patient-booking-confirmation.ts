import { formatPatientDate, formatPatientTime } from "@/lib/ai/patient-fact-reply";

export type PatientBookingConfirmation = {
  doctorName: string;
  date: string;
  time: string;
};

export function buildPatientBookingConfirmationReply(
  locale: "ar" | "en",
  value: PatientBookingConfirmation,
): string {
  const date = formatPatientDate(value.date, locale);
  const time = formatPatientTime(value.time, locale);
  if (locale === "ar") {
    return [
      "راجع تفاصيل طلب الحجز قبل ما أبعته:",
      `الطبيب: ${value.doctorName}`,
      `التاريخ: ${date}`,
      `الوقت: ${time}`,
      "الحالة: طلب حجز منتظر تأكيد العيادة",
      "هل تؤكد إرسال الطلب بهذه التفاصيل؟",
    ].join("\n");
  }
  return [
    "Please review the booking request before I send it:",
    `Doctor: ${value.doctorName}`,
    `Date: ${date}`,
    `Time: ${time}`,
    "Status: pending request awaiting clinic confirmation",
    "Do you confirm sending this request with these details?",
  ].join("\n");
}

export function minutesToPatientTime(value: string | number | undefined): string | null {
  if (typeof value === "string" && /^\d{2}:\d{2}$/.test(value)) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= 1440) {
    return null;
  }
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/**
 * The review, again, after the patient moved the day or the time.
 *
 * Deliberately the *same* message with the new values rather than a new kind of
 * message: the review is the step that ends a booking, and an amendment must
 * return the patient to it, not to somewhere adjacent to it. The one-line
 * preamble exists so the change is visibly acknowledged; everything below it is
 * byte-for-byte what `buildPatientBookingConfirmationReply` produces.
 */
export function buildBookingAmendmentReply(
  locale: "ar" | "en",
  value: PatientBookingConfirmation,
): string {
  const preamble = locale === "ar" ? "تمام، عدّلت الموعد." : "Done — I have updated the appointment.";
  return `${preamble}\n${buildPatientBookingConfirmationReply(locale, value)}`;
}

export type BookingAmendmentAlternatives = {
  doctorName: string;
  date: string;
  /** The time the patient asked for, when there was exactly one reading of it. */
  requestedTime: string | null;
  /** Real, currently bookable times for the same doctor on the same day. */
  slots: readonly string[];
};

/**
 * "That time is not free — here is what is." The draft is untouched.
 *
 * Every time in `slots` came from the availability engine on this turn, so the
 * message can never offer something that is not bookable, and the patient is
 * left holding the same booking they had a moment ago.
 */
export function buildBookingAmendmentUnavailableReply(
  locale: "ar" | "en",
  value: BookingAmendmentAlternatives,
): string {
  const times = value.slots.map((slot) => formatPatientTime(slot, locale));
  const date = formatPatientDate(value.date, locale);
  if (locale === "ar") {
    const head = value.requestedTime
      ? `${formatPatientTime(value.requestedTime, locale)} مش متاحة مع ${value.doctorName} يوم ${date}.`
      : `مفيش المعاد ده متاح مع ${value.doctorName} يوم ${date}.`;
    if (times.length === 0) {
      return `${head}\nمفيش مواعيد تانية متاحة في اليوم ده. تحب أشوف لك يوم تاني؟`;
    }
    return [head, "المتاح:", ...times.map((time) => `- ${time}`), "تحب أنهي معاد؟"].join("\n");
  }
  const head = value.requestedTime
    ? `${formatPatientTime(value.requestedTime, locale)} is not available with ${value.doctorName} on ${date}.`
    : `That time is not available with ${value.doctorName} on ${date}.`;
  if (times.length === 0) {
    return `${head}\nThere is nothing else open that day. Would you like me to look at another day?`;
  }
  return [head, "Available:", ...times.map((time) => `- ${time}`), "Which one would you like?"].join("\n");
}

/**
 * The day moved and the day has several free times: the patient picks one, and
 * the review comes back on the next turn.
 */
export function buildBookingSlotChoiceReply(
  locale: "ar" | "en",
  value: { doctorName: string; date: string; slots: readonly string[] },
): string {
  const times = value.slots.map((slot) => formatPatientTime(slot, locale));
  const date = formatPatientDate(value.date, locale);
  if (locale === "ar") {
    return [
      `تمام، ${date} مع ${value.doctorName}.`,
      "المواعيد المتاحة:",
      ...times.map((time) => `- ${time}`),
      "تحب أنهي معاد؟",
    ].join("\n");
  }
  return [
    `${date} with ${value.doctorName}.`,
    "Available times:",
    ...times.map((time) => `- ${time}`),
    "Which one would you like?",
  ].join("\n");
}

/**
 * «تقصد الساعة 10 صباحًا ولا 10 مساءً؟» — the minimum question, and only it.
 *
 * A bare hour has exactly two readings and the doctor's own schedule usually
 * kills one of them, which is why the caller only ever reaches this builder when
 * *both* readings are genuinely bookable. Answering that with the whole day's
 * slot list — which is what the model did before there was a deterministic path
 * — throws away everything the patient just told us and asks them to start the
 * time again. So the question names the two readings and nothing else, and the
 * booking draft they are holding is not touched while it waits.
 */
export function buildBookingMeridiemQuestionReply(
  locale: "ar" | "en",
  value: { times: readonly string[] },
): string {
  const [first, second] = [...value.times].sort((a, b) => a.localeCompare(b));
  if (!first || !second) {
    return locale === "ar"
      ? "تقصد الوقت ده صباحًا ولا مساءً؟"
      : "Did you mean that time in the morning or in the evening?";
  }
  const morning = formatPatientTime(first, locale);
  const evening = formatPatientTime(second, locale);
  return locale === "ar"
    ? `تقصد ${morning} ولا ${evening}؟`
    : `Did you mean ${morning} or ${evening}?`;
}
