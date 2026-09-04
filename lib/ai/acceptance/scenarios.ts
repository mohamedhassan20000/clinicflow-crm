/**
 * The acceptance matrix.
 *
 * One entry per conversational flow the product actually supports, written the
 * way the flow arrives on WhatsApp rather than the way the code is organised.
 * Each entry states, for the whole conversation:
 *
 *   * the patient's messages, and one or more **paraphrases** of them — because
 *     a suite that pins one fixed phrase per intent measures the phrase, not
 *     the intent;
 *   * the intent/state progression expected of the ladder;
 *   * the tools that must run, and the tools that must never run;
 *   * the database effects that must happen, and the ones that must not;
 *   * whether the turn is required to **ask for clarification** rather than
 *     commit to a reading;
 *   * what the reply must and must not contain.
 *
 * The forbidden halves carry as much weight as the expected halves. "Did it
 * book the appointment?" is a product question; "did it book an appointment
 * nobody asked for, for a person it invented, at a time nobody offered?" is the
 * production question.
 */

import {
  FIXTURE_PATIENT,
  FIXTURE_NO_AVAILABILITY_DOCTOR,
} from "@/lib/ai/acceptance/fixture-clinic";
import type { BookingStep } from "@/lib/ai/booking-stage";
import {
  LINKED_UNCONFIRMED,
  LINKED_VERIFIED,
  SOFT_DELETED_STALE_PATIENT,
  STRANGER,
  type InjectedFailure,
  type SimulatedPatient,
} from "@/lib/ai/acceptance/simulator";

export type ScenarioCategory =
  | "first_contact"
  | "existing_patient"
  | "new_patient"
  | "third_party"
  | "partial_entry"
  | "all_at_once"
  | "random_order"
  | "mind_change"
  | "correction"
  | "cancellation"
  | "availability"
  | "services_prices"
  | "departments"
  | "doctors"
  | "faq_hours"
  | "insurance"
  | "lifecycle"
  | "takeover"
  | "incomplete"
  | "ambiguity"
  | "typo"
  | "language"
  | "short_message"
  | "multi_intent"
  | "duplicate"
  | "interruption"
  | "tool_failure"
  | "no_availability"
  | "stale_state"
  | "episode_isolation"
  | "identity"
  | "hallucination";

export type Register =
  | "egyptian_arabic"
  | "gulf_arabic"
  | "msa"
  | "english"
  | "mixed"
  | "arabizi";

export type Scenario = {
  id: string;
  category: ScenarioCategory;
  register: Register;
  locale: "ar" | "en";
  /** One line, for the report. */
  intent: string;
  patient: SimulatedPatient;
  /** The canonical wording. */
  turns: readonly string[];
  /**
   * Alternative wordings of the same conversation, run as separate cases. Each
   * must have the same number of turns as `turns`.
   */
  paraphrases?: readonly (readonly string[])[];
  /** Ladder steps the conversation must pass through, in order, as a subsequence. */
  expectedSteps?: readonly BookingStep[];
  /** Tools that must have executed by the end of the conversation. */
  expectedTools?: readonly string[];
  /** Tools that must never execute in this conversation. */
  forbiddenTools?: readonly string[];
  /** Writes that must be committed. */
  expectedWrites?: readonly ("register_patient" | "create_preliminary_booking" | "cancel_my_appointment")[];
  /** Writes that must never be committed. */
  forbiddenWrites?: readonly ("register_patient" | "create_preliminary_booking" | "cancel_my_appointment")[];
  /**
   * Turns that must ask which reading was meant.
   *
   * `candidates` is the point of the check and not decoration: a reply that
   * merely contains a question mark is not a clarification. To pass, the turn
   * must put a question to the patient **and** name at least two of the
   * competing readings, **and** must not have quietly committed the field.
   */
  clarificationRequiredAt?: readonly {
    turn: number;
    field: "doctor" | "department" | "date" | "time";
    candidates: readonly string[];
  }[];
  /** Patterns at least one reply must match. */
  replyMust?: readonly RegExp[];
  /** Patterns no reply may match. */
  replyMustNot?: readonly RegExp[];
  /**
   * P11S — assertions about one specific reply.
   *
   * `replyMust`/`replyMustNot` join the transcript before matching, which
   * cannot express "on this turn and not that one" — and that is precisely the
   * shape of the episode opening: mandatory on the first reply of an episode,
   * forbidden on the second.
   */
  replyShapeAt?: readonly {
    turn: number;
    must?: readonly RegExp[];
    mustNot?: readonly RegExp[];
  }[];
  /** The conversation must end in a closed episode. */
  expectClose?: boolean;
  /** Injected tool failures. */
  failures?: Partial<Record<string, InjectedFailure>>;
  /** Tools whose call hangs. */
  hang?: readonly string[];
  /** Turn indexes the transport delivers twice. */
  duplicateIndexes?: readonly number[];
  /** Turn index at which staff take over. */
  humanTakeoverAfter?: number;
};

const NEVER_CLINICAL = [/دواء|علاج مناسب|تشخيص/i] as const;

export const ACCEPTANCE_SCENARIOS: readonly Scenario[] = [
  // -- first contact / greetings -------------------------------------------
  {
    id: "first-contact-ar",
    category: "first_contact",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A bare greeting opens the thread without starting a booking or naming anything.",
    patient: STRANGER,
    turns: ["السلام عليكم"],
    paraphrases: [["اهلا"], ["مساء الخير"], ["هاي"], ["ازيك"]],
    forbiddenTools: ["create_preliminary_booking", "register_patient"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyMustNot: [/تم الحجز|حجزتلك|booked/i],
  },
  {
    id: "first-contact-en",
    category: "first_contact",
    register: "english",
    locale: "en",
    intent: "The same opening in English.",
    patient: STRANGER,
    turns: ["hello"],
    paraphrases: [["hi there"], ["good morning"]],
    forbiddenTools: ["create_preliminary_booking", "register_patient"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
  },

  // -- existing patient ------------------------------------------------------
  {
    id: "existing-patient-booking-ar",
    category: "existing_patient",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A linked, verified patient books end to end: treating doctor, day, time, request.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز معاد لو سمحت", "تمام", "أول يوم متاح", "١٠:٠٠", "أيوه، أكد الطلب"],
    paraphrases: [
      ["محتاج موعد من فضلك", "ماشي", "اول يوم", "10:00", "موافق، ابعته"],
      ["ممكن أحجز؟", "أيوه", "٧", "الساعة عشرة", "أكد"],
    ],
    expectedSteps: ["department", "day", "time", "confirm"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability"],
    expectedWrites: ["create_preliminary_booking"],
    replyMustNot: NEVER_CLINICAL,
  },
  {
    id: "existing-patient-identity-gate",
    category: "identity",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A linked patient whose booking identity is not settled cannot be walked into a booking.",
    patient: LINKED_UNCONFIRMED,
    turns: ["عايز احجز في الجلدية"],
    forbiddenTools: ["create_preliminary_booking"],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- new patient -----------------------------------------------------------
  {
    id: "new-patient-intake-ar",
    category: "new_patient",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A number the clinic has never seen: department, doctor, day, time, then the intake, " +
      "then a real-slot request. The phone number is never asked for.",
    patient: STRANGER,
    turns: [
      "انا اول مرة اتعامل معاكم، عايز احجز في الجلدية",
      "سارة علي",
      "أول يوم متاح",
      "١٠:٠٠",
      "عمر حسن، 29004121200345، 12/4/1990، omar@example.com",
    ],
    paraphrases: [
      [
        "first time here, I want a dermatology appointment",
        "Sara Ali",
        "the first available day",
        "10:00",
        "Omar Hassan, 29004121200345, 12/4/1990, omar@example.com",
      ],
    ],
    expectedSteps: ["department", "doctor", "day", "time", "intake"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability", "register_patient"],
    replyMustNot: [/رقم\s*(?:تليفونك|هاتفك|موبايلك)|your (?:phone|mobile) number/i],
  },
  {
    id: "new-patient-no-registration-claim",
    category: "new_patient",
    register: "english",
    locale: "en",
    intent:
      "A staged intake is not a registration. The reply may never say the patient is registered.",
    patient: STRANGER,
    turns: [
      "I would like to book with dermatology",
      "Sara Ali",
      "first available day",
      "10:00",
      "Omar Hassan, 29004121200345, 12/4/1990, omar@example.com",
    ],
    replyMustNot: [/you (?:are|have been) registered|تم تسجيلك/i],
  },

  // -- third-party booking ---------------------------------------------------
  {
    id: "third-party-booking-ar",
    category: "third_party",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A linked patient books for their son. The son's details must never overwrite the " +
      "sender's own patient file.",
    patient: LINKED_VERIFIED,
    turns: [
      "عايز احجز لابني علاج طبيعي",
      "محمد خالد",
      "أول يوم",
      "١٠:٠٠",
      "يوسف عمر حسن، 31005121200987، 5/6/2015، yousef@example.com",
    ],
    expectedTools: ["prepare_booking"],
    // The sender's own identity is permanent: nothing in this conversation may
    // rewrite the linked patient's stored name.
    replyMustNot: [/تم تسجيلك انت|you have been registered/i],
  },
  {
    id: "third-party-not-escalated",
    category: "third_party",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "'علاج طبيعي' is this clinic's department, not a request for clinical judgment. " +
      "Booking for a child must not be handed to a human before the agent runs.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز لابني علاج طبيعي"],
    replyMustNot: [/هحوّلك لحد من فريق العيادة/],
  },

  // -- partial entry points --------------------------------------------------
  {
    id: "entry-department-only",
    category: "partial_entry",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Only a department is given. The roster must follow without a restart.",
    patient: LINKED_VERIFIED,
    turns: ["الجلدية"],
    paraphrases: [["جلدية"], ["dermatology"], ["عايز الجلدية"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "entry-doctor-only",
    category: "partial_entry",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Only a doctor name is given; the department is inferred from the roster.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع دكتورة سارة علي"],
    paraphrases: [["with Sara Ali please"], ["د. سارة علي"]],
    expectedTools: ["prepare_booking"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "entry-service-only",
    category: "partial_entry",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Only a service is named. Services are per department, so this asks, never guesses.",
    patient: LINKED_VERIFIED,
    turns: ["عايز جلسة ليزر"],
    paraphrases: [["I want a laser session"], ["ليزر"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "entry-datetime-only",
    category: "partial_entry",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "Only a day and time are given, with no doctor. A booking must not be created from a " +
      "date alone.",
    patient: LINKED_VERIFIED,
    turns: ["عايز معاد يوم ٧ الساعة ١٠"],
    paraphrases: [["I want the 7th at 10"], ["يوم ٨ الساعة ١١"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- everything at once, and in random order -------------------------------
  {
    id: "all-details-one-message",
    category: "all_at_once",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Department, doctor, day and time in a single message.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية مع دكتورة سارة علي يوم ٧ الساعة ١٠"],
    paraphrases: [
      ["book me dermatology with Sara Ali on the 7th at 10:00"],
      ["احجزلي جلدية سارة علي ٧ الساعة ١٠"],
    ],
    forbiddenTools: ["register_patient"],
  },
  {
    id: "details-random-order",
    category: "random_order",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "The same facts, arriving backwards: time, then doctor, then department.",
    patient: LINKED_VERIFIED,
    turns: ["الساعة ١٠", "دكتورة سارة علي", "الجلدية", "يوم ٧"],
    expectedTools: ["prepare_booking"],
  },

  // -- changing mind and corrections ----------------------------------------
  {
    id: "mind-change-department",
    category: "mind_change",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A department change mid-flow. The old doctor and day must be dropped, not carried over.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "لا خلاص، أنا عايز الأسنان"],
    expectedTools: ["prepare_booking"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "correction-day-ar",
    category: "correction",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The reported correction phrasing. The department and the doctor must survive it; only " +
      "the day changes.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "يوم ٨", "لا قصدي الجمعة"],
    paraphrases: [
      ["dermatology please", "Sara Ali", "the 8th", "no sorry, the 10th"],
      ["جلدية", "ساره على", "٨", "لا قصدي يوم ١٠"],
    ],
    forbiddenWrites: ["create_preliminary_booking"],
    replyMustNot: [/أنهي قسم|which department/i],
  },

  // -- cancellation ----------------------------------------------------------
  {
    id: "cancellation-verified",
    category: "cancellation",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A verified patient cancels their own pending appointment.",
    patient: LINKED_VERIFIED,
    turns: ["عايز ألغي معادي"],
    paraphrases: [["I want to cancel my appointment"], ["الغاء الموعد"], ["ألغي الحجز من فضلك"]],
    expectedTools: ["list_my_appointments"],
  },
  {
    id: "cancellation-unverified",
    category: "cancellation",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "An unverified thread may not cancel anything.",
    patient: LINKED_UNCONFIRMED,
    turns: ["الغي معادي"],
    forbiddenWrites: ["cancel_my_appointment"],
  },

  // -- availability ----------------------------------------------------------
  {
    id: "availability-question",
    category: "availability",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A pure availability question, answered from the calendar and nothing else.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع سارة علي", "امتى المتاح؟"],
    paraphrases: [
      ["with Sara Ali", "when is she available?"],
      ["سارة علي", "ايه المواعيد المتاحة؟"],
    ],
    expectedTools: ["prepare_booking"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "no-availability",
    category: "no_availability",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A doctor with a genuinely empty calendar. The reply must say so and must not invent a day.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع تامر وجدي في القلب", "امتى متاح؟"],
    forbiddenWrites: ["create_preliminary_booking"],
    replyMustNot: [/2026-12-31|2027-/],
  },

  // -- services, prices, departments, doctors, FAQ, insurance ----------------
  {
    id: "services-and-prices",
    category: "services_prices",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Services and their prices, read from settings. No price may be invented.",
    patient: LINKED_VERIFIED,
    turns: ["الجلدية بكام؟"],
    paraphrases: [["how much is a dermatology visit?"], ["اسعار الجلدية ايه؟"], ["بكام الكشف؟"]],
    forbiddenWrites: ["create_preliminary_booking"],
    replyMustNot: [/777|2499/],
  },
  {
    id: "departments-directory",
    category: "departments",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A clinic-wide department question, asked mid-booking. It must not be answered with the " +
      "one selected department, and it must not move the booking.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "ايه الاقسام الموجودة عندكم؟"],
    paraphrases: [
      ["I want dermatology", "what departments do you have?"],
      ["جلدية", "عندكم اقسام ايه؟"],
    ],
    replyMustNot: [/Oncology|المناظير/],
  },
  {
    id: "doctors-roster",
    category: "doctors",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "'Are there other doctors?' must produce the rest of the roster, not a restart.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز معاد", "في دكاترة غيره؟"],
    paraphrases: [
      ["I would like to book", "are there other doctors?"],
      ["محتاج موعد", "مين تاني متاح؟"],
    ],
    expectedTools: ["prepare_booking"],
    replyMustNot: [/أنهي قسم|which department/i],
  },
  {
    id: "opening-hours",
    category: "faq_hours",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "Opening hours, from stored clinic settings only.",
    patient: STRANGER,
    turns: ["بتفتحوا امتى؟"],
    paraphrases: [["what are your opening hours?"], ["مواعيد العيادة ايه؟"], ["العنوان فين؟"]],
    replyMustNot: [/٢٤ ساعة|24 hours/i],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
  },
  {
    id: "faq-unanswered",
    category: "faq_hours",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A question with no clinic-authored answer must be answered with 'I do not know'.",
    patient: STRANGER,
    turns: ["بتقبلوا الدفع بالتقسيط؟"],
    replyMustNot: [/أيوه بنقبل التقسيط|yes we accept installments/i],
  },
  {
    id: "insurance-accepted",
    category: "insurance",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "An insurer that is on the list.",
    patient: STRANGER,
    turns: ["بتقبلوا أكسا؟"],
    paraphrases: [["do you take AXA?"], ["عندكم ميتلايف؟"]],
    replyMustNot: [/Bupa/i],
  },
  {
    id: "insurance-not-accepted",
    category: "insurance",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "An insurer that is not on the list must be refused, never accepted to be polite.",
    patient: STRANGER,
    turns: ["بتقبلوا بوبا جلوبال؟"],
    replyMustNot: [/أيوه بنقبل بوبا|yes,? we accept bupa/i],
  },

  // -- ambiguity, the headline requirement -----------------------------------
  {
    id: "ambiguous-doctor-truncated",
    category: "ambiguity",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The reported case: 'دكتور احم' matches two real doctors. The assistant must ask which " +
      "one, and then continue from the same point — not restart the workflow.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "عايز احجز مع دكتور احم", "احمد نبيل"],
    paraphrases: [
      ["dermatology please", "I want doctor Ahm", "Ahmed Nabil"],
      ["الجلدية", "دكتور احمد", "احمد مصطفى"],
    ],
    clarificationRequiredAt: [
      { turn: 1, field: "doctor", candidates: ["Ahmed Nabil", "Ahmed Mostafa"] },
    ],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "ambiguous-doctor-firstname",
    category: "ambiguity",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A bare shared first name is ambiguous and must be asked about.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "أحمد"],
    clarificationRequiredAt: [
      { turn: 1, field: "doctor", candidates: ["Ahmed Nabil", "Ahmed Mostafa"] },
    ],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "ambiguous-date",
    category: "ambiguity",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A bare day number with no offer behind it is not a date. It must be asked about, never " +
      "invented into one.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز يوم ١٢"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "ambiguous-time",
    category: "ambiguity",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "'الساعة ٩' with no morning/evening word and both offered resolves nothing and must be asked.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع سارة علي", "أول يوم", "الساعة ٤"],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- typos, missing letters, dialect, language ----------------------------
  {
    id: "typo-department",
    category: "typo",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A misspelled department must resolve or ask — never silently pick another one.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلديه"],
    paraphrases: [["عايز احجز في الجلديةة"], ["dermatolgy please"], ["عايز الاسنان"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "missing-letters-doctor",
    category: "typo",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A truncated doctor surname.",
    patient: LINKED_VERIFIED,
    turns: ["الجلدية", "سار"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "msa-booking",
    category: "language",
    register: "msa",
    locale: "ar",
    intent: "Modern Standard Arabic must be understood as readily as the dialect.",
    patient: LINKED_VERIFIED,
    turns: ["أرغب في حجز موعد في قسم الجلدية", "الدكتورة سارة علي"],
    expectedTools: ["prepare_booking"],
  },
  {
    id: "gulf-dialect-booking",
    category: "language",
    register: "gulf_arabic",
    locale: "ar",
    intent: "Gulf phrasing of the same request.",
    patient: LINKED_VERIFIED,
    turns: ["أبغى أحجز موعد", "زين"],
    expectedTools: ["prepare_booking"],
  },
  {
    id: "english-booking",
    category: "language",
    register: "english",
    locale: "en",
    intent: "The English thread must stay in English.",
    patient: LINKED_VERIFIED,
    turns: ["I'd like to book an appointment", "yes please", "first available day"],
    expectedTools: ["prepare_booking"],
  },
  {
    id: "mixed-language",
    category: "language",
    register: "mixed",
    locale: "ar",
    intent: "Arabic and English in one message.",
    patient: LINKED_VERIFIED,
    turns: ["عايز book appointment في dermatology"],
    paraphrases: [["I want موعد مع Sara Ali"]],
    expectedTools: ["prepare_booking"],
  },
  {
    id: "arabizi",
    category: "language",
    register: "arabizi",
    locale: "ar",
    intent: "Latin-script Egyptian Arabic, which is how a large share of patients type.",
    patient: LINKED_VERIFIED,
    turns: ["3ayez a7gez maw3ed"],
    paraphrases: [["3ayez a7gez fe el geldeya"], ["momken ma3ad?"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- register coverage ----------------------------------------------------
  //
  // F-16 — the four non-Egyptian registers, carried through the flows that
  // actually break rather than through one greeting each.
  //
  // The pre-existing language block establishes that each register is
  // *recognised*: one or two turns, ending before the ladder gets interesting.
  // What the managed live run showed is that recognition is not the hard part —
  // three of its six failures were a booking that opened fine and then stalled.
  // So these carry Gulf Arabic, MSA, Arabizi and code-switched Arabic/English
  // through the whole of it: opening, roster continuation, day, time, the
  // commit, a correction, an ambiguity that must be asked about, and a
  // cancellation.
  //
  // Every phrase here is written the way a patient types it, not the way a
  // lexicon would like them to. Several of them found real gaps — MSA says the
  // hour as an ordinal ("العاشرة", never "عشرة"), Gulf says "متوفر" where Egypt
  // says "متاح", and Arabizi spells consonants with digits, so "el sa3a 10"
  // contains two "numbers" and read as neither a time nor a day. See F-15.
  {
    id: "gulf-booking-full",
    category: "existing_patient",
    register: "gulf_arabic",
    locale: "ar",
    intent:
      "A Gulf-register booking carried end to end, including the day and time answers.",
    patient: LINKED_VERIFIED,
    turns: ["أبي أحجز موعد", "زين", "أول يوم متوفر", "الساعة عشرة", "أكد"],
    paraphrases: [
      ["أبغى موعد لو تكرمت", "تمام", "اول يوم متوفر", "عشرة الصبح", "أيوه، أكد الطلب"],
    ],
    expectedSteps: ["department", "day", "time", "confirm"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability"],
    expectedWrites: ["create_preliminary_booking"],
    replyMustNot: NEVER_CLINICAL,
  },
  {
    id: "msa-booking-full",
    category: "existing_patient",
    register: "msa",
    locale: "ar",
    intent:
      "Modern Standard Arabic through the whole ladder, with the hour said as an ordinal.",
    patient: LINKED_VERIFIED,
    turns: [
      "أرغب في حجز موعد من فضلك",
      "نعم",
      "اليوم الأول المتاح",
      "الساعة العاشرة صباحاً",
      "تأكيد",
    ],
    paraphrases: [
      ["أود حجز موعد", "أجل", "أول يوم متاح", "العاشرة", "نعم"],
    ],
    expectedSteps: ["department", "day", "time", "confirm"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability"],
    expectedWrites: ["create_preliminary_booking"],
    replyMustNot: NEVER_CLINICAL,
  },
  {
    id: "arabizi-booking-full",
    category: "existing_patient",
    register: "arabizi",
    locale: "ar",
    intent:
      "Latin-script Egyptian Arabic through the whole ladder. The digits inside " +
      "the words are letters, not numbers.",
    patient: LINKED_VERIFIED,
    turns: ["3ayez a7gez maw3ed", "tamam", "awel yom", "el sa3a 10", "yes"],
    paraphrases: [
      ["momken a7gez ma3ad?", "aywa", "awal yom", "10:00", "confirm"],
    ],
    expectedSteps: ["department", "day", "time", "confirm"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability"],
    expectedWrites: ["create_preliminary_booking"],
    replyMustNot: NEVER_CLINICAL,
  },
  {
    id: "mixed-booking-full",
    category: "existing_patient",
    register: "mixed",
    locale: "ar",
    intent: "Code-switched Arabic/English through the whole ladder.",
    patient: LINKED_VERIFIED,
    turns: ["عايز book موعد please", "ok", "first يوم", "10:00", "yes"],
    expectedSteps: ["department", "day", "time", "confirm"],
    expectedTools: ["prepare_booking", "list_available_days", "check_availability"],
    expectedWrites: ["create_preliminary_booking"],
    replyMustNot: NEVER_CLINICAL,
  },
  {
    id: "msa-roster-continuation",
    category: "doctors",
    register: "msa",
    locale: "ar",
    intent:
      "'Are there other doctors?' in MSA continues the roster instead of restarting the funnel.",
    patient: LINKED_VERIFIED,
    turns: ["أرغب في حجز موعد", "هل يوجد أطباء آخرون؟"],
    paraphrases: [["أود حجز موعد", "من الأطباء المتاحون غيره؟"]],
    expectedTools: ["prepare_booking"],
    replyMustNot: [/أنهي قسم|أي قسم|which department/i],
  },
  {
    id: "gulf-roster-continuation",
    category: "doctors",
    register: "gulf_arabic",
    locale: "ar",
    intent: "The same continuation in Gulf register, including the plural form.",
    patient: LINKED_VERIFIED,
    turns: ["أبغى أحجز موعد", "في دكاترة ثانيين؟"],
    paraphrases: [["أبي موعد", "مين الأطباء الثانيين؟"]],
    expectedTools: ["prepare_booking"],
    replyMustNot: [/أنهي قسم|أي قسم|which department/i],
  },
  {
    id: "mixed-doctor-correction",
    category: "correction",
    register: "mixed",
    locale: "ar",
    intent:
      "A code-switched correction replaces the doctor without restarting the booking.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "Sara Ali", "لا قصدي Ahmed Mostafa"],
    expectedTools: ["prepare_booking"],
    forbiddenWrites: ["register_patient"],
    replyMustNot: [/أنهي قسم|which department/i],
  },
  {
    id: "msa-doctor-ambiguity",
    category: "ambiguity",
    register: "msa",
    locale: "ar",
    intent:
      "A first name shared by two doctors of the same department must be asked about, " +
      "not guessed, whatever the register.",
    patient: LINKED_VERIFIED,
    turns: ["أرغب في حجز موعد في قسم الجلدية", "الدكتور أحمد"],
    clarificationRequiredAt: [
      { turn: 1, field: "doctor", candidates: ["Ahmed Nabil", "Ahmed Mostafa"] },
    ],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "gulf-cancellation",
    category: "cancellation",
    register: "gulf_arabic",
    locale: "ar",
    intent: "A Gulf-register cancellation reaches the appointment list, not a new booking.",
    patient: LINKED_VERIFIED,
    turns: ["أبي ألغي موعدي"],
    paraphrases: [["أبغى إلغاء الموعد"]],
    expectedTools: ["list_my_appointments"],
    replyMustNot: [/أنهي قسم|which department/i],
  },
  {
    id: "msa-cancellation",
    category: "cancellation",
    register: "msa",
    locale: "ar",
    intent: "The same request in Modern Standard Arabic.",
    patient: LINKED_VERIFIED,
    turns: ["أرغب في إلغاء موعدي"],
    paraphrases: [["أود إلغاء الحجز من فضلك"]],
    expectedTools: ["list_my_appointments"],
    replyMustNot: [/أنهي قسم|which department/i],
  },
  {
    id: "arabizi-cancellation",
    category: "cancellation",
    register: "arabizi",
    locale: "ar",
    intent: "The same request in Latin-script Egyptian Arabic.",
    patient: LINKED_VERIFIED,
    turns: ["3ayez alghi el maw3ad"],
    paraphrases: [["momken cancel el maw3ad?"]],
    expectedTools: ["list_my_appointments"],
  },
  {
    id: "arabizi-intake-natural",
    category: "incomplete",
    register: "arabizi",
    locale: "ar",
    intent:
      "A stranger in Arabizi is asked for the rest of their details in ordinary words, " +
      "and nothing is committed from details they never gave.",
    patient: STRANGER,
    turns: ["3ayez a7gez fe el geldeya", "Sara Ali", "awel yom", "10:00", "Omar Hassan"],
    replyMustNot: [/national_id|date_of_birth|full_name|department_id|doctor_id/],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- short messages, multiple intents -------------------------------------
  {
    id: "short-message",
    category: "short_message",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A one-word message must not be treated as a full booking instruction.",
    patient: LINKED_VERIFIED,
    turns: ["حجز"],
    paraphrases: [["موعد"], ["؟"], ["تمام"]],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "multi-intent",
    category: "multi_intent",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "Two questions and a booking request in one message. Nothing may be silently dropped and " +
      "nothing may be answered by invention.",
    patient: LINKED_VERIFIED,
    turns: ["بتفتحوا امتى؟ وبتقبلوا أكسا؟ وعايز احجز في الجلدية"],
    paraphrases: [
      ["what are your hours, do you take AXA, and can I book dermatology?"],
    ],
    replyMustNot: [/Bupa|٢٤ ساعة/i],
  },

  // -- duplicates, interruptions, stale state --------------------------------
  {
    id: "duplicate-inbound",
    category: "duplicate",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The transport delivers the same message twice. The assistant must not act on it twice.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "أول يوم", "١٠:٠٠", "أيوه، أكد"],
    duplicateIndexes: [4],
    // Exactly one booking, never two.
    expectedWrites: ["create_preliminary_booking"],
  },
  {
    id: "interrupted-conversation",
    category: "interruption",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A booking interrupted by an unrelated question and then resumed must continue from where " +
      "it stopped.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "بتفتحوا امتى؟", "طب كمل الحجز، أول يوم"],
    replyMustNot: [/أنهي قسم|which department/i],
  },
  {
    id: "stale-state-old-name",
    category: "stale_state",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A name from earlier in the thread must not be reused as the booking subject once the " +
      "patient has moved on.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز لصاحبي محمود سيد", "لا خلاص، الحجز ليا انا", "الجلدية"],
    replyMustNot: [/محمود سيد/],
  },
  {
    id: "soft-deleted-patient-fresh-booking-ar",
    category: "stale_state",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A same-number conversation linked to a soft-deleted patient is normalized before the " +
      "turn, so a fresh Dermatology request enters the department/doctor flow and never intake.",
    patient: SOFT_DELETED_STALE_PATIENT,
    turns: ["مساء الخير، كنت عايز أحجز عند دكتور جلدية لو سمحت"],
    expectedTools: ["prepare_booking"],
    forbiddenTools: ["register_patient"],
    forbiddenWrites: ["register_patient", "create_preliminary_booking"],
    replyMustNot: [
      /Previous Deleted Patient/i,
      /تاريخ الميلاد|رقم الهوية|date of birth|national id/i,
      /تعذر حفظ|تعذّر حفظ|could not be saved/i,
    ],
  },

  // -- lifecycle: close, reopen, fresh episode ------------------------------
  {
    id: "assistant-auto-close",
    category: "lifecycle",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A goodbye closes the thread and resets the assistant's state.",
    patient: LINKED_VERIFIED,
    turns: ["بتفتحوا امتى؟", "شكرا، مع السلامة"],
    paraphrases: [["what are your hours?", "thanks, bye"], ["مواعيدكم ايه؟", "تمام شكرا"]],
    expectClose: true,
  },
  {
    id: "fresh-episode-after-close",
    category: "episode_isolation",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The headline isolation property: after a close, 'السلام عليكم' starts a new episode. " +
      "The previous department, doctor and name must not reappear.",
    patient: LINKED_VERIFIED,
    turns: [
      "عايز احجز في الجلدية",
      "سارة علي",
      "شكرا، مع السلامة",
      "السلام عليكم",
    ],
    // The leakage property is owned by the `no_episode_leakage` gate, which
    // compares *after* the boundary against *before* it. A blanket pattern here
    // would also match the pre-close turn that legitimately named the doctor.
    expectClose: false,
  },

  // -- P11S: the mandatory episode opening ----------------------------------
  {
    id: "episode-opening-islamic-greeting",
    category: "first_contact",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A first-ever 'السلام عليكم' is answered the way it is answered, then the clinic "
      + "introduces itself by name and offers the two things it can do.",
    patient: STRANGER,
    turns: ["السلام عليكم"],
    paraphrases: [["السلام عليكم ورحمة الله"], ["سلام عليكم"]],
    forbiddenTools: ["create_preliminary_booking", "register_patient"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [
      {
        turn: 0,
        must: [
          /وعليكم السلام ورحمة الله وبركاته/,
          /Nile Care Clinic/,
          /المساعد الآلي للعيادة/,
          /تحب تحجز موعد، ولا عندك استفسار آخر؟/,
        ],
      },
    ],
  },
  {
    id: "episode-opening-plain-greeting-en",
    category: "first_contact",
    register: "english",
    locale: "en",
    intent: "The same guarantee in English, without the Islamic response.",
    patient: STRANGER,
    turns: ["hello"],
    paraphrases: [["hi"], ["good morning"]],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [
      {
        turn: 0,
        must: [/Welcome to Nile Care Clinic/, /automated assistant/, /book an appointment/],
        mustNot: [/Wa alaykum/],
      },
    ],
  },
  {
    id: "episode-opening-with-clear-intent",
    category: "first_contact",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A first message that already carries a request is greeted, introduced and answered in "
      + "ONE message — the greeting must never cost the patient an extra turn.",
    patient: STRANGER,
    turns: ["السلام عليكم، عايز أعرف عنوانكم"],
    paraphrases: [["السلام عليكم عايز العنوان بتاعكم"]],
    forbiddenTools: ["create_preliminary_booking", "register_patient"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [
      {
        turn: 0,
        must: [/وعليكم السلام ورحمة الله وبركاته/, /المساعد الآلي للعيادة/],
        // The redundant menu question is the failure this scenario exists for.
        mustNot: [/تحب تحجز موعد، ولا عندك استفسار آخر؟/],
      },
    ],
  },
  {
    id: "episode-opening-not-repeated",
    category: "lifecycle",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The introduction belongs to the episode, not to every message: a second turn inside the "
      + "same episode must not welcome the patient again.",
    patient: STRANGER,
    turns: ["السلام عليكم", "عندكم أنهي أقسام؟"],
    paraphrases: [["اهلا", "الأقسام عندكم ايه؟"]],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [
      { turn: 0, must: [/المساعد الآلي للعيادة/] },
      { turn: 1, mustNot: [/المساعد الآلي للعيادة/, /أهلًا وسهلًا بك في/] },
    ],
  },
  {
    id: "episode-opening-again-after-done",
    category: "episode_isolation",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "Done is the end of an episode, not of the thread: the next inbound opens a new episode "
      + "and is welcomed and introduced again, exactly like a first contact.",
    patient: STRANGER,
    turns: ["بتفتحوا امتى؟", "شكرا، مع السلامة", "السلام عليكم"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [
      { turn: 0, must: [/المساعد الآلي للعيادة/] },
      // The goodbye is a closing line and nothing else.
      { turn: 1, mustNot: [/المساعد الآلي للعيادة/] },
      { turn: 2, must: [/وعليكم السلام ورحمة الله وبركاته/, /المساعد الآلي للعيادة/] },
    ],
  },
  {
    id: "inquiry-ends-with-offer-then-closes",
    category: "lifecycle",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "P11S: a completed inquiry is offered an ending, and a plain 'لا' takes it. Without the "
      + "offer an answered question had no ending at all and the thread stayed open forever.",
    patient: STRANGER,
    turns: ["عندكم أنهي أقسام؟", "لا شكرا"],
    paraphrases: [["الأقسام المتاحة ايه؟", "لأ خلاص"]],
    forbiddenTools: ["create_preliminary_booking", "register_patient"],
    forbiddenWrites: ["create_preliminary_booking", "register_patient"],
    replyShapeAt: [{ turn: 0, must: [/حاجة تانية/] }],
    expectClose: true,
  },

  // -- human takeover --------------------------------------------------------
  {
    id: "human-takeover",
    category: "takeover",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "Once a staff member holds the thread, nothing is generated, nothing is sent, and no " +
      "write happens.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "أول يوم", "١٠:٠٠"],
    humanTakeoverAfter: 2,
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "human-requested",
    category: "takeover",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "An explicit request for a person is escalated before the model runs.",
    patient: LINKED_VERIFIED,
    turns: ["عايز اكلم موظف"],
    paraphrases: [["I want to speak to a human"], ["وصلني بحد من العيادة"]],
    forbiddenTools: ["prepare_booking", "create_preliminary_booking"],
  },

  // -- incomplete requests ---------------------------------------------------
  {
    id: "incomplete-intake",
    category: "incomplete",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A stranger who gives half their details must be asked for the rest in ordinary words — " +
      "never a list of schema keys.",
    patient: STRANGER,
    turns: ["عايز احجز في الجلدية", "سارة علي", "أول يوم", "١٠:٠٠", "عمر حسن"],
    replyMustNot: [/national_id|date_of_birth|full_name|department_id|doctor_id/],
    forbiddenWrites: ["create_preliminary_booking"],
  },

  // -- tool failure / timeout ------------------------------------------------
  {
    id: "tool-failure-availability",
    category: "tool_failure",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The availability read fails. The patient gets one apology and the clinic's stored phone " +
      "number, never a Postgres error and never an invented day.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع سارة علي", "امتى المتاح؟"],
    failures: { list_available_days: "raw_db_error", check_availability: "raw_db_error" },
    replyMustNot: [/Postgrest|row-level security|relation "public|42501/i],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "tool-timeout-booking",
    category: "tool_failure",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "The booking write times out. Nothing may be reported as booked.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "أول يوم", "١٠:٠٠"],
    failures: { create_preliminary_booking: "timeout" },
    forbiddenWrites: ["create_preliminary_booking"],
    replyMustNot: [/تم إرسال طلب الحجز|has been submitted/i],
  },

  // -- hallucination resistance ---------------------------------------------
  {
    id: "hallucination-doctor-request",
    category: "hallucination",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "A patient asks for a doctor who does not exist. The reply must say so and offer the real " +
      "roster — never confirm the invented one.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز مع دكتور كريم سليم"],
    paraphrases: [["I want to book with Dr Karim Selim"]],
    replyMustNot: [/كريم سليم|Karim Selim/i],
    forbiddenWrites: ["create_preliminary_booking"],
  },
  {
    id: "hallucination-price-request",
    category: "hallucination",
    register: "egyptian_arabic",
    locale: "ar",
    intent: "A price for a service the clinic does not sell must not be invented.",
    patient: LINKED_VERIFIED,
    turns: ["بكام باقة البوتوكس؟"],
    replyMustNot: [/\b\d{3,4}\s*(?:جنيه|EGP)/i],
  },
  {
    id: "hallucination-slot-request",
    category: "hallucination",
    register: "egyptian_arabic",
    locale: "ar",
    intent:
      "The offered-options guard: a time no tool ever offered must be refused server-side, even " +
      "if the model tries.",
    patient: LINKED_VERIFIED,
    turns: ["عايز احجز في الجلدية", "سارة علي", "أول يوم", "الساعة ٤ العصر"],
    forbiddenWrites: ["create_preliminary_booking"],
  },
];

/** Every case the suite runs: each scenario, plus each of its paraphrases. */
export type ScenarioCase = {
  caseId: string;
  scenario: Scenario;
  turns: readonly string[];
  paraphraseIndex: number;
};

export function expandScenarios(
  scenarios: readonly Scenario[] = ACCEPTANCE_SCENARIOS,
): readonly ScenarioCase[] {
  const cases: ScenarioCase[] = [];
  for (const scenario of scenarios) {
    cases.push({
      caseId: scenario.id,
      scenario,
      turns: scenario.turns,
      paraphraseIndex: 0,
    });
    for (const [index, turns] of (scenario.paraphrases ?? []).entries()) {
      cases.push({
        caseId: `${scenario.id}#p${index + 1}`,
        scenario,
        turns,
        paraphraseIndex: index + 1,
      });
    }
  }
  return cases;
}

export { FIXTURE_PATIENT, FIXTURE_NO_AVAILABILITY_DOCTOR };
