/**
 * F-4 — is this message a clinic-information question rather than a booking?
 *
 * ## The defect this exists for
 *
 * `nextBookingStep` reports `department` for *every* thread with no collected
 * data, regardless of what the patient asked, because the ladder describes what
 * a booking still needs and not whether a booking is happening. So a thread
 * whose first message was "بتفتحوا امتى؟" arrived at `resolveBookingAuthority`
 * at step `department`, was answered `read_authority / prepare_booking /
 * needs_departments`, and had `prepare_booking` pinned onto an opening-hours
 * question.
 *
 * The consequence was not merely a wasted tool call. A booking tool having run
 * makes the thread permanently `workflowEngaged`, which makes `outstanding`
 * permanently true, which means `resolveConversationLifecycle` can never reach
 * `offer_end` or `close` — so the assistant never closed a thread it had
 * answered a question on, and the stage trace labelled FAQ threads as bookings.
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the same kind of thing as `isClinicDirectoryQuestion`: a narrow reader
 * over shapes the server can *prove*, used only to **withhold** a forced tool
 * call. It is allow-by-default in the direction that matters — a shape it does
 * not recognise keeps today's behaviour exactly, which is that the department
 * authority is pinned. Nothing here can unlock a tool, mount anything, or
 * change collected state.
 *
 * Two rules keep it honest:
 *
 *   1. **No clinic vocabulary.** Not one department, specialty, service,
 *      insurer or doctor name. Only question shapes over generic concepts —
 *      hours, address, phone, parking, price, insurance — so a clinic that
 *      opened yesterday behaves identically to one that opened a decade ago.
 *   2. **A booking frame always wins.** "بكام الكشف ولو حلو احجز" names a price
 *      *and* asks to book; a message carrying any booking verb, any appointment
 *      noun, or any availability question is not a pure information question and
 *      this returns `false` for it. The asymmetry is deliberate: reading a
 *      booking as a question costs the patient a turn, and reading a question as
 *      a booking is the defect.
 */

import { isServiceInquiry } from "@/lib/ai/service-intent";

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (pattern: string): RegExp => new RegExp(`${L}(?:${pattern})${R}`, "iu");
/**
 * Same, but tolerating the Arabic conjunction/preposition prefixes that fuse
 * onto a verb — "وأحجز", "فاحجز". Without it "عايز اعرف سعر الكشف وأحجز" read
 * as a pure price question, because the booking verb it ends on was hidden
 * behind a `و`.
 */
const verb = (pattern: string): RegExp =>
  new RegExp(`${L}[وف]?(?:${pattern})${R}`, "iu");

/**
 * Anything that makes the message about arranging a visit.
 *
 * Checked first and unconditionally. Deliberately generous: it is cheaper to
 * decline to classify a message as informational than to strip a real booking
 * turn of its authority.
 */
const BOOKING_FRAME_PATTERNS: readonly RegExp[] = [
  /\b(?:book|booking|reserve|reservation|appointment|appointments|schedule|reschedul(?:e|ing)|slot|slots|availab(?:le|ility)|cancel|change\s+my)\b/i,
  verb(
    "احجز|أحجز|اححز|نحجز|يحجز|حجز|حجزت|حجزي|موعد|مواعيد|ميعاد|معاد|معادي|" +
      "متاح|متاحة|متاحه|متاحين|المتاحين|فاضي|فاضية|الغاء|إلغاء|الغي|ألغي|اغير|أغير",
  ),
];

/**
 * The information questions themselves.
 *
 * Every entry is a question shape wrapped around a generic clinic concept. The
 * concepts are the ones a receptionist answers without opening a calendar:
 * opening hours, where the clinic is, how to reach it, what it charges, which
 * insurers it works with, and the free-form FAQ shapes ("do you have parking?").
 */
const INFORMATION_QUESTION_PATTERNS: readonly RegExp[] = [
  // Opening hours.
  /\b(?:opening|closing|working|business)\s+(?:hours?|times?)\b/i,
  /\b(?:when|what\s+time)\b[^?.!\n]{0,30}\b(?:open|close|opening|closed)\b/i,
  /\b(?:are\s+you|is\s+the\s+clinic)\s+open\b/i,
  /\bwhat\s+(?:are\s+)?(?:your|the)\s+(?:opening\s+|working\s+|clinic\s+)?hours\b/i,
  /\b(?:your|the)\s+hours\b[^?.!\n]{0,10}\?/i,
  word("بتفتحوا|بتقفلوا|بتفتح|بتقفل|مفتوحين|مفتوح|مواعيدكم|ساعات\\s*العمل|مواعيد\\s*العمل"),
  word("(?:امتى|إمتى|امتي|متى)\\s*(?:بتفتحوا|بتقفلوا|تفتحوا|تقفلوا)"),

  // Address, location, contact.
  /\b(?:where\s+are\s+you|where\s+is\s+the\s+clinic|what(?:'s|\s+is)\s+(?:your|the)\s+(?:address|location|phone|number))\b/i,
  /\b(?:address|location|directions|phone\s+number|telephone)\b[^?.!\n]{0,20}\?/i,
  word("العنوان|عنوانكم|فين\\s*العيادة|مكانكم|رقم\\s*التليفون|رقم\\s*الهاتف|تليفونكم"),

  // Prices and services, asked as a question rather than as a booking.
  /\b(?:how\s+much|what(?:'s|\s+is)\s+the\s+(?:price|cost|fee))\b/i,
  /\b(?:price\s+list|prices|your\s+(?:fees|charges)|what\s+services)\b/i,
  word("بكام|كام|سعر|أسعار|اسعار|الاسعار|الأسعار|تكلفة|التكلفة|خدمات|الخدمات"),

  // Insurance.
  /\b(?:do\s+you\s+(?:accept|take)|is\s+.{0,20}\s*accepted)\b[^?.!\n]{0,30}\binsurance\b/i,
  /\binsurance\b[^?.!\n]{0,25}\b(?:accept|cover|providers?|companies)\b/i,
  word("تأمين|تامين|التأمين|التامين|بتقبلوا|تقبلون"),

  // Free-form FAQ shapes the clinic authored answers for.
  /\b(?:do\s+you\s+have|is\s+there)\b[^?.!\n]{0,25}\b(?:parking|wheelchair|lift|elevator|waiting\s+room)\b/i,
  /\bwalk[-\s]?ins?\b/i,
  word("جراج|موقف|مواقف|انتظار\\s*السيارات"),
];

/**
 * True only for messages the server can prove are a clinic-information question
 * and not a booking.
 *
 * `false` means "not provable", never "not a question": the caller uses this
 * solely to *withhold* a forced booking tool, so a miss degrades to exactly the
 * behaviour that existed before this module.
 */
export function isClinicInformationQuestion(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  if (BOOKING_FRAME_PATTERNS.some((pattern) => pattern.test(text))) return false;
  // Item #2 — the services/prices half of this list now comes from the shared
  // reader, so this module and `patient-turn-intent` cannot disagree about
  // whether "بتقدموا إيه؟" is a question about what the clinic offers. The
  // booking-frame check above still runs first and still wins, which is the one
  // asymmetry that belongs here and not in the shared module.
  if (isServiceInquiry(text)) return true;
  return INFORMATION_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}
