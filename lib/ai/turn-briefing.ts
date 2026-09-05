/**
 * P10 — telling the model what this conversation already knows.
 *
 * `collected-state.ts` has, since P8B, been able to answer "what has this
 * patient already told us?" and "what single question is outstanding?". Both
 * answers were persisted, both were used by the tools — and **neither was ever
 * put in front of the model**. `describeCollectedData` existed, was exported,
 * was unit-tested, and had no caller anywhere in the application.
 *
 * That absence is the mechanism behind the most-reported defect on the device
 * tests: the assistant asking again for a name, a date of birth, a national id
 * or a department that the patient had already given. Nothing was broken in the
 * storage; the model simply could not see it, and a sixteen-message history
 * window is not a reliable substitute for "these four values are settled".
 *
 * So this module builds one short, ordered briefing per turn and the agent
 * mounts it after the system prompt:
 *
 *   1. **What is settled** — never ask for any of it again.
 *   2. **What is outstanding** — the one clarification already asked.
 *   3. **What is still missing** — the intake fields that genuinely remain,
 *      including the optional ones worth asking for once.
 *   4. **Whether the patient just said goodbye** — and, if so, whether anything
 *      is still owed before the conversation can end.
 *
 * Two properties this file keeps:
 *
 * **It is pure.** No database, no clock it is not handed, no `server-only`. The
 * briefing for a given state is a value, so the interesting property — "does a
 * completed intake produce a briefing that forbids re-asking?" — is a table.
 *
 * **It carries no authority.** Everything here is a restatement of values the
 * patient supplied. It cannot verify identity, cannot mark a booking, cannot
 * unlock a tool: the mount comes from the stage table and every tool re-resolves
 * identity server-side regardless of anything written below.
 */

import type { BookingStage } from "@/lib/ai/booking-stage";
import type { ClosureDetection } from "@/lib/ai/conversation-closure";
import { closureGuidance } from "@/lib/ai/conversation-closure";
import { patientFacingLabel } from "@/lib/ai/patient-intake-contract";
import {
  translationGuidance,
  type TranslationRequest,
} from "@/lib/ai/translation-request";
import {
  clarificationGuidance,
  describeCollectedData,
  type CollectedData,
  type PendingClarification,
  type SlotField,
} from "@/lib/ai/collected-state";

/**
 * P11J-2 — one label layer, not two.
 *
 * This file used to keep its own Arabic/English field names, which drifted from
 * the ones the patient-facing copy used ("الرقم القومي" here, "رقم الهوية"
 * there) and, worse, fell back to the raw identifier for any field it had no
 * entry for. Both now come from `patient-intake-contract.ts`, whose fallback is
 * a neutral phrase rather than a schema key.
 */
export function fieldLabel(field: SlotField, locale: "ar" | "en"): string {
  return patientFacingLabel(field, locale);
}

export type TurnBriefingInput = {
  locale: "ar" | "en";
  stage: BookingStage;
  collected: CollectedData;
  pending: PendingClarification | null;
  /** Intake fields still genuinely missing. Derived by the caller. */
  missingRequired: readonly SlotField[];
  /** Optional fields not yet collected. Asked once, never insisted on. */
  missingOptional: readonly SlotField[];
  /** True when the intake for this conversation is already staged for review. */
  intakeStaged: boolean;
  closure: ClosureDetection;
  /**
   * P11S — the booking-identity confirmation this turn should put to a linked
   * sender, composed from authoritative record fields.
   *
   * Present only while the thread is linked to a live patient and booking
   * identity has not been confirmed yet. `nationalIdSuffix` is four digits or
   * null; the full ID is never loaded, so there is nothing here that could leak
   * one even if the model tried.
   */
  identityConfirmation?: {
    name: string;
    nationalIdSuffix: string | null;
  } | null;
  /**
   * P11S — true when a booking has just started and the conversation has not
   * established whether it is for the sender or for somebody else.
   */
  askBookingTarget?: boolean;
  /**
   * P12 — a booking paused by a side question, or resumed after one.
   *
   * The rung comes from the server's own ladder record, not from the model's
   * reading of the transcript, which is the whole point: the model is told
   * where to pick the booking back up rather than asked to work it out.
   */
  interruption?:
    | { kind: "paused"; step: string }
    | { kind: "resuming"; step: string }
    | null;
  /** P12 — the patient asked for the previous reply again in another language. */
  translationRequest?: TranslationRequest | null;
  /** P12 — one short question about a partial name correction, verbatim. */
  nameCorrectionQuestion?: string | null;
};

/**
 * The booking rungs, in the words a briefing can use. Schema constants in,
 * clinic language out — the label is never the patient's own words.
 */
const STEP_LABELS: Record<string, { ar: string; en: string }> = {
  department: { ar: "اختيار القسم", en: "choosing the department" },
  doctor: { ar: "اختيار الطبيب", en: "choosing the doctor" },
  day: { ar: "اختيار اليوم", en: "choosing the day" },
  time: { ar: "اختيار الوقت", en: "choosing the time" },
  intake: { ar: "استكمال بيانات الملف", en: "completing the patient details" },
  confirm: { ar: "تأكيد تفاصيل الطلب", en: "confirming the request details" },
};

function stepLabel(step: string, locale: "ar" | "en"): string {
  const entry = STEP_LABELS[step];
  if (entry) return entry[locale];
  return locale === "ar" ? "الخطوة التي توقفنا عندها" : "the step we had reached";
}

/**
 * The briefing for one turn, or null when there is genuinely nothing to say.
 *
 * Null on a first message from a stranger who has told us nothing and asked
 * nothing — adding an empty "here is what we know: nothing" block to the prompt
 * would be noise competing for a small model's attention, which is the failure
 * the whole P9 prompt split was designed around.
 */
export function buildTurnBriefing(input: TurnBriefingInput): string | null {
  const ar = input.locale === "ar";
  const sections: string[] = [];

  const settled = describeCollectedData(input.collected);
  if (settled) {
    sections.push(
      ar
        ? "ما استقر عليه الحوار بالفعل — لا تسأل عن أي منه مرة أخرى: " +
            describeCollectedArabic(input.collected)
        : settled,
    );
  }

  if (input.pending) {
    const guidance = clarificationGuidance({
      status: "ambiguous",
      field: input.pending.field,
      candidates: input.pending.candidates,
      pending: input.pending,
    });
    sections.push(
      ar
        ? `سؤال واحد ما زال معلّقًا بخصوص ${fieldLabel(input.pending.field, "ar")}. ` +
            "إذا وافق المريض («اه»، «ايوه»، «نعم»، «تمام») فاعتبر القيمة التي عرضتها مؤكدة " +
            "واستمر — لا تسأل عنها من جديد ولا تعاملها كإجابة جديدة غامضة."
        : `One clarification about the ${fieldLabel(input.pending.field, "en")} is still ` +
            "outstanding. If the patient agrees (\"yes\", \"correct\", \"اه\", \"ايوه\"), take the " +
            "value you proposed as confirmed and carry on — do not ask again and do not treat " +
            "the agreement as a new, ambiguous answer." +
            (input.pending.candidates.length > 0 && guidance ? ` ${guidance}` : ""),
    );
  }

  if (!input.intakeStaged && input.missingRequired.length > 0) {
    const labels = input.missingRequired
      .map((field) => fieldLabel(field, input.locale))
      .join(ar ? "، " : ", ");
    sections.push(
      ar
        ? `الناقص فعلًا لفتح الملف: ${labels}. اسأل عن هذه فقط، بيانين تقريبًا في كل مرة، ` +
            "ولا تسأل عن أي بيان آخر."
        : `Still genuinely missing before the file can be opened: ${labels}. Ask only for ` +
            "these, a couple at a time, and for nothing else.",
    );
  }

  if (!input.intakeStaged && input.missingOptional.length > 0) {
    const labels = input.missingOptional
      .map((field) => fieldLabel(field, input.locale))
      .join(ar ? "، " : ", ");
    sections.push(
      ar
        ? `اختياري: ${labels}. اسأل عنه مرة واحدة فقط مع البيانات الناقصة، وإذا لم يعرفه ` +
            "المريض أو لم يرد ذكره فأكمل بدونه ولا تعد السؤال."
        : `Optional: ${labels}. Ask for it once, alongside the missing details. If the patient ` +
            "does not know it or would rather not say, continue without it and never ask again.",
    );
  }

  if (input.intakeStaged && input.missingRequired.length === 0) {
    sections.push(
      ar
        ? "ملف المريض مكتمل ومسجّل بالفعل لمراجعة الموظفين. لا تجمع أي بيانات شخصية من جديد — " +
            "أكمل مباشرة إلى اليوم والوقت أو إلى مراجعة الطلب."
        : "The patient's file is already complete and staged for staff review. Do not collect any " +
            "personal detail again — carry straight on to the day, the time, or the review.",
    );
  }

  // P11S — who the booking is for, asked once, before anything is collected.
  //
  // The distinction decides everything downstream: the sender's own booking
  // confirms an existing file, and somebody else's opens a new one. Guessing it
  // from "عايز أحجز" is how a booking for a patient's mother ended up on the
  // patient's own record.
  if (input.askBookingTarget) {
    sections.push(
      ar
        ? "لم يتحدد بعد إن كان الحجز للمُرسِل نفسه أم لشخص آخر. اسأل سؤالًا واحدًا قصيرًا — " +
            "«أكيد، الحجز ليك ولا لشخص تاني؟» — قبل أي خطوة أخرى، واسأله مرة واحدة فقط. " +
            "ارتباط المحادثة بملف مريض يثبت هوية المُرسِل فقط ولا يعني أن الحجز له، " +
            "فلا تفترض ذلك ولا تسأل عن تأكيد الهوية في نفس الرسالة."
        : "It is not yet established whether this booking is for the sender or for someone " +
            "else. Ask one short question — \"Of course — is the appointment for you, or for " +
            "someone else?\" — before anything else, and ask it only once. A conversation " +
            "linked to a patient file proves who the sender is and nothing about who the " +
            "appointment is for: do not assume, and do not put an identity confirmation in " +
            "the same message.",
    );
  }

  // P11S — the identity confirmation, with the record's own values.
  if (input.identityConfirmation) {
    const { name, nationalIdSuffix } = input.identityConfirmation;
    sections.push(
      ar
        ? `هذه المحادثة مرتبطة بملف باسم ${name}` +
            (nationalIdSuffix ? ` ورقم هوية منتهٍ بـ ${nationalIdSuffix}` : "") +
            ". أكِّد الهوية بسؤال واحد قصير بهذه القيم فقط" +
            (nationalIdSuffix ? "، ولا تذكر رقم الهوية كاملًا أبدًا" : "") +
            "، ثم استدعِ confirm_booking_identity بدون معطيات عندما يوافق."
        : `This conversation is linked to a file for ${name}` +
            (nationalIdSuffix ? `, national ID ending ${nationalIdSuffix}` : "") +
            ". Confirm identity with one short question using only those values" +
            (nationalIdSuffix ? ", and never state a full national ID" : "") +
            ", then call confirm_booking_identity with no arguments once they agree.",
    );
  }

  // P12 — a side question mid-booking, and the turn that resumes from it.
  if (input.interruption?.kind === "paused") {
    const label = stepLabel(input.interruption.step, input.locale);
    sections.push(
      ar
        ? "المريض سأل سؤالًا جانبيًا أثناء الحجز. جاوب على سؤاله أولًا وبشكل كامل، " +
            `ثم اسأله في نفس الرسالة: «تحب نكمل الحجز؟». الحجز لسه واقف عند ${label} ` +
            "وكل ما تم اختياره محفوظ — لا تبدأ الحجز من أوله ولا تعيد أي سؤال تمت الإجابة عنه."
        : `The patient asked a side question during the booking. Answer it fully first, then ` +
            "in the same message ask whether they would like to continue the booking. The " +
            `booking is still waiting at ${label} and everything already chosen is saved — do ` +
            "not restart it and do not repeat any question already answered.",
    );
  }
  if (input.interruption?.kind === "resuming") {
    const label = stepLabel(input.interruption.step, input.locale);
    sections.push(
      ar
        ? `المريض وافق على استكمال الحجز. اكمل من نفس الخطوة بالضبط: ${label}. ` +
            "كل ما تم اختياره قبل السؤال الجانبي — الشخص المحجوز له والقسم والطبيب واليوم والوقت — " +
            "ما زال محفوظًا كما هو. لا تبدأ من جديد، ولا تقفز خطوة للأمام، ولا تكرر سؤالًا سبق الرد عليه."
        : `The patient agreed to continue the booking. Resume from exactly that step: ${label}. ` +
            "Everything chosen before the side question — the person being booked, the " +
            "department, the doctor, the day and the time — is still held. Do not start over, " +
            "do not skip ahead, and do not repeat a question already answered.",
    );
  }

  // P12 — one short question about a partial name correction, worded by the
  // server because the staged identity is the thing at risk.
  if (input.nameCorrectionQuestion) {
    sections.push(
      ar
        ? `المريض أرسل تصحيحًا جزئيًا للاسم ولم يتضح إن كان يقصد تغيير الاسم كله أم جزء منه. ` +
            `اسأل هذا السؤال وحده بالنص: «${input.nameCorrectionQuestion}». ` +
            "لا تغيّر الاسم المسجّل ولا تضف أي جزء جديد قبل إجابته."
        : "The patient sent a partial name correction and it is not clear whether they mean to " +
            `replace the whole name or one part of it. Ask exactly this and nothing else: ` +
            `"${input.nameCorrectionQuestion}". Do not change the stored name and do not add ` +
            "any part to it before they answer.",
    );
  }

  // P12 — «مش فاهم قولها بالعربي». Restate, change nothing.
  if (input.translationRequest) {
    sections.push(
      translationGuidance({ request: input.translationRequest, locale: input.locale }),
    );
  }

  const closing = closureGuidance({
    detection: input.closure,
    outstanding: outstandingSummary(input),
    locale: input.locale,
  });
  if (closing) sections.push(closing);

  if (sections.length === 0) return null;
  return (
    (ar
      ? "حالة هذه المحادثة الآن (بيانات من النظام، وليست كلام المريض):"
      : "Where this conversation stands (system facts, not the patient's words):") +
    "\n- " +
    sections.join("\n- ")
  );
}

/**
 * The one thing still owed, phrased for the closure rule, or null.
 *
 * Kept deliberately coarse. Its only consumer decides between "say goodbye and
 * stop" and "say goodbye and restate one question", and for that decision the
 * *name* of the outstanding field is enough — reproducing the patient's own
 * words into the prompt would put content where a label does.
 */
function outstandingSummary(input: TurnBriefingInput): string | null {
  if (input.pending) return fieldLabel(input.pending.field, input.locale);
  if (!input.intakeStaged && input.missingRequired.length > 0) {
    return input.missingRequired
      .map((field) => fieldLabel(field, input.locale))
      .join(input.locale === "ar" ? "، " : ", ");
  }
  return null;
}

/**
 * The Arabic rendering of the settled values.
 *
 * `describeCollectedData` writes English, which is right for an English turn
 * and wrong for an Arabic one: a prompt that switches language mid-instruction
 * is exactly what makes a small model switch language mid-reply. The values
 * themselves are canonical and are never translated.
 */
function describeCollectedArabic(collected: CollectedData): string {
  const parts = Object.entries(collected)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const label = fieldLabel(key as SlotField, "ar");
      if (key === "appointment_time" && typeof value === "number") {
        const hour = Math.floor(value / 60);
        const minute = value % 60;
        return `${label}: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
      return `${label}: ${String(value)}`;
    });
  return (
    `${parts.join("؛ ")}. ` +
    "هذه قيم ذكرها المريض؛ وهي ليست إثباتًا لهويته."
  );
}
