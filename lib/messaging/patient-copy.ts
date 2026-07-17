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
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export function isTemplateVariable(value: string): value is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

/** Template names the automated senders look up (documented in the templates UI). */
export const REMINDER_TEMPLATE_NAME = "appointment_reminder";
export const FOLLOWUP_TEMPLATE_NAME = "invoice_followup";

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

type FollowupCopyInput = {
  locale: PatientCopyLocale;
  patientName: string;
  clinicName: string;
  /** 0 = D0 invoice notice, 1 = gentle reminder, 2 = final reminder. */
  step: 0 | 1 | 2;
};

export function followupCopy(input: FollowupCopyInput): {
  subject: string;
  body: string;
} {
  if (input.locale === "ar") {
    const bodies = [
      `مرحباً ${input.patientName}، نشكركم لزيارتكم ${input.clinicName}. يوجد مبلغ مستحق على زيارتكم الأخيرة، يرجى التواصل مع العيادة لاستكمال الدفع.`,
      `مرحباً ${input.patientName}، نذكّركم بوجود مبلغ مستحق لدى ${input.clinicName}. يرجى التواصل مع العيادة لتسويته.`,
      `مرحباً ${input.patientName}، هذا تذكير أخير بوجود مبلغ مستحق لدى ${input.clinicName}. يرجى التواصل مع العيادة في أقرب وقت.`,
    ] as const;
    return {
      subject: `مستحقات زيارتكم في ${input.clinicName}`,
      body: bodies[input.step],
    };
  }
  const bodies = [
    `Hello ${input.patientName}, thank you for visiting ${input.clinicName}. There is an outstanding balance on your recent visit — please contact the clinic to complete the payment.`,
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
  values: Record<TemplateVariable, string>,
): string[] | null {
  const parameters: string[] = [];
  for (const name of declaredVariables) {
    if (!isTemplateVariable(name)) return null;
    parameters.push(values[name]);
  }
  return parameters;
}
