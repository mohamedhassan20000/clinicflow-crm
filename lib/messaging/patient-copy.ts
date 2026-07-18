import "server-only";

/**
 * Patient-facing message copy for the P3D automated sends (§7.2, §7.3).
 *
 * This is content data (like prompts), not UI copy: the recipient is a
 * patient, so the language follows the clinic's locale, never a staff user's
 * UI preference. Bodies follow the §5.4 minimal-PHI rule — appointment
 * time, doctor name, and clinic name only; never diagnoses, notes, or
 * balance amounts (the follow-up mentions that a balance exists, not what it
 * is).
 */

export type PatientCopyLocale = "ar" | "en";

export function patientCopyLocale(locale: string | null | undefined): PatientCopyLocale {
  return locale === "ar" ? "ar" : "en";
}

/**
 * The variable vocabulary clinic templates may declare (§7.4 "validated
 * against the allowed set"). The cron supplies values for exactly these.
 */
export const TEMPLATE_VARIABLES = [
  "patient_name",
  "clinic_name",
  "doctor_name",
  "appointment_date",
  "appointment_time",
  // Invoice-issued delivery (§7.3a). The invoice, unlike the dunning
  // follow-up, may state amounts (it is the patient's own invoice). Formatted
  // strings (with currency) are supplied by the caller.
  "invoice_total",
  "invoice_outstanding",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export function isTemplateVariable(value: string): value is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

/** Template names the automated senders look up (documented in the templates UI). */
export const REMINDER_TEMPLATE_NAME = "appointment_reminder";
export const FOLLOWUP_TEMPLATE_NAME = "invoice_followup";
export const INVOICE_TEMPLATE_NAME = "invoice_issued";

/**
 * Event-driven appointment notifications (§7.2a). One approved WhatsApp
 * template per lifecycle event, each looked up by these names.
 */
export type AppointmentEvent =
  | "created"
  | "confirmed"
  | "rescheduled"
  | "cancelled";

export const APPOINTMENT_EVENT_TEMPLATE_NAME: Record<AppointmentEvent, string> = {
  created: "appointment_created",
  confirmed: "appointment_confirmed",
  rescheduled: "appointment_rescheduled",
  cancelled: "appointment_cancelled",
};

type ReminderCopyInput = {
  locale: PatientCopyLocale;
  patientName: string;
  clinicName: string;
  doctorName: string;
  dateText: string;
  timeText: string;
};

export function reminderCopy(input: ReminderCopyInput): {
  subject: string;
  body: string;
} {
  if (input.locale === "ar") {
    return {
      subject: `تذكير بموعدك في ${input.clinicName}`,
      body:
        `مرحباً ${input.patientName}، نذكّركم بموعدكم في ${input.clinicName} ` +
        `مع ${input.doctorName} يوم ${input.dateText} الساعة ${input.timeText}. ` +
        `إذا رغبتم بتغيير الموعد يرجى التواصل مع العيادة.`,
    };
  }
  return {
    subject: `Appointment reminder — ${input.clinicName}`,
    body:
      `Hello ${input.patientName}, this is a reminder of your appointment at ` +
      `${input.clinicName} with ${input.doctorName} on ${input.dateText} at ` +
      `${input.timeText}. Please contact the clinic if you need to reschedule.`,
  };
}

type AppointmentEventCopyInput = {
  locale: PatientCopyLocale;
  event: AppointmentEvent;
  patientName: string;
  clinicName: string;
  doctorName: string;
  dateText: string;
  timeText: string;
};

/**
 * Immediate appointment-lifecycle notification copy (§7.2a) for the email
 * fallback. Minimal PHI (§5.4): patient name, clinic, doctor, date/time only.
 */
export function appointmentEventCopy(input: AppointmentEventCopyInput): {
  subject: string;
  body: string;
} {
  const { clinicName, patientName, doctorName, dateText, timeText } = input;
  if (input.locale === "ar") {
    const when = `مع ${doctorName} يوم ${dateText} الساعة ${timeText}`;
    const bodies: Record<AppointmentEvent, { subject: string; body: string }> = {
      created: {
        subject: `تم استلام طلب موعدك في ${clinicName}`,
        body: `مرحباً ${patientName}، تم استلام طلب موعدكم في ${clinicName} ${when}. موعدكم قيد المراجعة وسنؤكده قريباً.`,
      },
      confirmed: {
        subject: `تم تأكيد موعدك في ${clinicName}`,
        body: `مرحباً ${patientName}، تم تأكيد موعدكم في ${clinicName} ${when}. نتطلع لرؤيتكم.`,
      },
      rescheduled: {
        subject: `تم تغيير موعدك في ${clinicName}`,
        body: `مرحباً ${patientName}، تم تغيير موعدكم في ${clinicName} ليصبح ${when}. إذا كان هذا لا يناسبكم يرجى التواصل مع العيادة.`,
      },
      cancelled: {
        subject: `تم إلغاء موعدك في ${clinicName}`,
        body: `مرحباً ${patientName}، تم إلغاء موعدكم في ${clinicName} ${when}. لحجز موعد جديد يرجى التواصل مع العيادة.`,
      },
    };
    return bodies[input.event];
  }
  const when = `with ${doctorName} on ${dateText} at ${timeText}`;
  const bodies: Record<AppointmentEvent, { subject: string; body: string }> = {
    created: {
      subject: `Appointment request received — ${clinicName}`,
      body: `Hello ${patientName}, we have received your appointment request at ${clinicName} ${when}. It is pending review and we will confirm it shortly.`,
    },
    confirmed: {
      subject: `Appointment confirmed — ${clinicName}`,
      body: `Hello ${patientName}, your appointment at ${clinicName} ${when} is confirmed. We look forward to seeing you.`,
    },
    rescheduled: {
      subject: `Appointment rescheduled — ${clinicName}`,
      body: `Hello ${patientName}, your appointment at ${clinicName} has been rescheduled to ${when}. Please contact the clinic if this does not suit you.`,
    },
    cancelled: {
      subject: `Appointment cancelled — ${clinicName}`,
      body: `Hello ${patientName}, your appointment at ${clinicName} ${when} has been cancelled. Please contact the clinic to book a new time.`,
    },
  };
  return bodies[input.event];
}

type InvoiceCopyInput = {
  locale: PatientCopyLocale;
  patientName: string;
  clinicName: string;
  /** Pre-formatted amount strings including currency (e.g. "KWD 45.000"). */
  totalText: string;
  outstandingText: string;
  hasOutstanding: boolean;
};

/**
 * Immediate invoice-issued delivery copy (§7.3a) for the email fallback.
 * Template-agnostic: this is the minimal P3 invoice summary; the professional
 * rendered document arrives in P7 behind the same delivery workflow. Unlike
 * the dunning follow-up, the invoice may state amounts — it is the patient's
 * own invoice.
 */
export function invoiceIssuedCopy(input: InvoiceCopyInput): {
  subject: string;
  body: string;
} {
  const { clinicName, patientName, totalText, outstandingText } = input;
  if (input.locale === "ar") {
    const outstandingLine = input.hasOutstanding
      ? ` المبلغ المتبقي: ${outstandingText}.`
      : " تم سداد المبلغ بالكامل، شكراً لكم.";
    return {
      subject: `فاتورة زيارتكم في ${clinicName}`,
      body:
        `مرحباً ${patientName}، شكراً لزيارتكم ${clinicName}. ` +
        `إجمالي الفاتورة: ${totalText}.${outstandingLine}`,
    };
  }
  const outstandingLine = input.hasOutstanding
    ? ` Outstanding balance: ${outstandingText}.`
    : " Paid in full — thank you.";
  return {
    subject: `Invoice for your visit — ${clinicName}`,
    body:
      `Hello ${patientName}, thank you for visiting ${clinicName}. ` +
      `Invoice total: ${totalText}.${outstandingLine}`,
  };
}

type FollowupCopyInput = {
  locale: PatientCopyLocale;
  patientName: string;
  clinicName: string;
  /**
   * Dunning message index (§7.3b): 0 = gentle reminder (D+3), 1 = final
   * reminder (D+7). The D0 invoice notice is now the immediate §7.3a delivery,
   * not a dunning step.
   */
  step: 0 | 1;
};

export function followupCopy(input: FollowupCopyInput): {
  subject: string;
  body: string;
} {
  if (input.locale === "ar") {
    const bodies = [
      `مرحباً ${input.patientName}، نذكّركم بوجود مبلغ مستحق لدى ${input.clinicName}. يرجى التواصل مع العيادة لتسويته.`,
      `مرحباً ${input.patientName}، هذا تذكير أخير بوجود مبلغ مستحق لدى ${input.clinicName}. يرجى التواصل مع العيادة في أقرب وقت.`,
    ] as const;
    return {
      subject: `مستحقات زيارتكم في ${input.clinicName}`,
      body: bodies[input.step],
    };
  }
  const bodies = [
    `Hello ${input.patientName}, a friendly reminder that you have an outstanding balance at ${input.clinicName}. Please contact the clinic to settle it.`,
    `Hello ${input.patientName}, this is a final reminder about your outstanding balance at ${input.clinicName}. Please contact the clinic at your earliest convenience.`,
  ] as const;
  return {
    subject: `Outstanding balance — ${input.clinicName}`,
    body: bodies[input.step],
  };
}

/**
 * Orders values by the template's declared variable list. Returns null when a
 * declared variable is outside the allowed vocabulary, which makes the
 * template unusable for automated sends.
 */
export function templateParameterValues(
  declaredVariables: readonly string[],
  values: Partial<Record<TemplateVariable, string>>,
): string[] | null {
  const parameters: string[] = [];
  for (const name of declaredVariables) {
    if (!isTemplateVariable(name)) return null;
    const value = values[name];
    // A template that declares a variable the sender has no value for is
    // unusable for this send (the send layer would reject an empty parameter).
    if (value === undefined) return null;
    parameters.push(value);
  }
  return parameters;
}
