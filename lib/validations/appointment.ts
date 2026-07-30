import "@/lib/validations/error-map";
import { z } from "zod";

export const appointmentSchema = z.object({
  patient_id: z.string().uuid("validation.invalidFormat"),
  doctor_id: z.string().uuid("validation.invalidFormat"),
  department_id: z.string().uuid().optional().nullable(),
  scheduled_at: z
    .string()
    .min(1, "validation.tooSmall")
    .refine((v) => !isNaN(Date.parse(v)), "validation.invalidFormat"),
  duration_minutes: z.number().int().min(15).max(240).default(30),
  insurance_provider_id: z.string().uuid().optional().nullable(),
  package_id: z.string().uuid("validation.invalidFormat").optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export type AppointmentFormValues = z.infer<typeof appointmentSchema>;

/** The dedicated Replace workflow: a new slot (and optionally a new doctor). */
export const replaceAppointmentSchema = z.object({
  original_id: z.string().uuid("validation.invalidFormat"),
  doctor_id: z.string().uuid("validation.invalidFormat"),
  department_id: z.string().uuid().optional().nullable(),
  scheduled_at: z
    .string()
    .min(1, "validation.tooSmall")
    .refine((v) => !isNaN(Date.parse(v)), "validation.invalidFormat"),
  duration_minutes: z.number().int().min(15).max(240).default(30),
  notes: z.string().max(1000).optional().nullable(),
});

export type ReplaceAppointmentValues = z.infer<typeof replaceAppointmentSchema>;

export const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
  "insurance",
] as const;

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const PATIENT_PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
] as const;
export const patientPaymentMethodSchema = z.enum(PATIENT_PAYMENT_METHODS);
export const insuranceCalculationModeSchema = z.enum(["amount", "percentage"]);

export const lineItemSchema = z.object({
  service_id: z.string().uuid().optional().nullable(),
  name: z.string().min(1, "validation.tooSmall").max(120),
  price: z.number().nonnegative("validation.tooSmall"),
  quantity: z.number().int().min(1, "validation.tooSmall").max(99),
});

export type LineItemValues = z.infer<typeof lineItemSchema>;

export const billingSchema = z
  .object({
    line_items: z
      .array(lineItemSchema)
      .min(1, "validation.tooSmall"),
    paid_amount: z.number().nonnegative(),
    payment_method: patientPaymentMethodSchema,
    insurance_amount: z.number().nonnegative().default(0),
    insurance_calculation_mode: insuranceCalculationModeSchema.default("amount"),
    insurance_percentage: z.number().nullable().optional(),
    patient_responsibility: z.number().nonnegative(),
    secondary_payment_method: patientPaymentMethodSchema.nullable().optional(),
    secondary_amount: z.number().nonnegative().default(0),
    deposit_amount: z.number().nonnegative().default(0),
    payment_note: z.string().max(500).nullable().optional(),
    previous_settlement_amount: z.number().default(0),
    previous_payment_method: patientPaymentMethodSchema.nullable().optional(),
    previous_note: z
      .string()
      .max(500, "validation.previousNoteTooLong")
      .nullable()
      .optional(),
  })
  .refine(
    (v) => {
      if (!v.secondary_payment_method) return true;
      return v.secondary_payment_method !== v.payment_method;
    },
    {
      path: ["secondary_payment_method"],
      message: "validation.invalidFormat",
    },
  )
  .superRefine((v, ctx) => {
    const total = Number(
      v.line_items
        .reduce(
          (sum, item) => sum + Number(item.price) * Number(item.quantity),
          0,
        )
        .toFixed(2),
    );
    const expectedInsurance =
      v.insurance_calculation_mode === "percentage"
        ? Number(
            (
              (total * Number(v.insurance_percentage ?? 0)) /
              100
            ).toFixed(2),
          )
        : Number(v.insurance_amount.toFixed(2));
    const expectedResponsibility = Number(
      Math.max(0, total - v.insurance_amount).toFixed(2),
    );

    if (
      v.insurance_calculation_mode === "percentage" &&
      v.insurance_percentage == null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["insurance_percentage"],
        message: "validation.insurancePercentageRequired",
      });
    }
    if (
      v.insurance_calculation_mode === "percentage" &&
      v.insurance_percentage != null &&
      (v.insurance_percentage < 0 || v.insurance_percentage > 100)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["insurance_percentage"],
        message: "validation.insurancePercentageOutOfRange",
      });
    }
    if (v.insurance_amount > total + 0.001) {
      ctx.addIssue({
        code: "custom",
        path: ["insurance_amount"],
        message: "validation.insuranceAmountExceedsInvoiceTotal",
      });
    }
    if (Math.abs(expectedInsurance - v.insurance_amount) > 0.001) {
      ctx.addIssue({
        code: "custom",
        path: ["insurance_amount"],
        message: "validation.insuranceAmountDoesNotMatchPercentage",
      });
    }
    if (
      Math.abs(expectedResponsibility - v.patient_responsibility) > 0.001
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["patient_responsibility"],
        message: "validation.patientResponsibilityMismatch",
      });
    }
    if (
      v.paid_amount + v.secondary_amount + v.deposit_amount >
      v.patient_responsibility + 0.001
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["paid_amount"],
        message: "validation.patientPaymentsExceedResponsibility",
      });
    }
    if (v.previous_settlement_amount < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["previous_settlement_amount"],
        message: "validation.previousSettlementNegative",
      });
    }
    if (v.previous_settlement_amount > 0 && !v.previous_payment_method) {
      ctx.addIssue({
        code: "custom",
        path: ["previous_payment_method"],
        message: "validation.previousPaymentMethodRequired",
      });
    }
  })
  .transform((v) => ({
    ...v,
    insurance_amount: Number(v.insurance_amount.toFixed(2)),
    insurance_percentage:
      v.insurance_calculation_mode === "percentage"
        ? Number((v.insurance_percentage ?? 0).toFixed(2))
        : null,
    patient_responsibility: Number(v.patient_responsibility.toFixed(2)),
    previous_settlement_amount: Number(
      v.previous_settlement_amount.toFixed(2),
    ),
    previous_note: v.previous_note?.trim() || null,
    previous_payment_method:
      v.previous_settlement_amount > 0 ? v.previous_payment_method : null,
  }))
  .refine(
    (v) => v.previous_settlement_amount <= 0 || !!v.previous_payment_method,
    {
      path: ["previous_payment_method"],
      message: "validation.previousPaymentMethodRequired",
    },
  );

export type BillingValues = z.input<typeof billingSchema>;

export const depositSchema = z.object({
  patient_id: z.string().uuid(),
  amount: z.number().positive("validation.tooSmall"),
  payment_method: paymentMethodSchema,
  note: z.string().max(500).optional().nullable(),
});

export type DepositValues = z.infer<typeof depositSchema>;

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  // Allow direct pending → completed so reception can charge a walk-in or a
  // same-day booking without first clicking Confirm.
  pending: ["confirmed", "completed", "cancelled"],
  confirmed: ["arrived", "completed", "cancelled", "no_show"],
  arrived: ["in_session", "completed", "confirmed", "cancelled", "no_show"],
  in_session: ["completed", "arrived", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
  // `replaced` is terminal and is only ever reached through the dedicated
  // replace workflow (replace_appointment RPC), never via a status transition.
  replaced: [],
};
