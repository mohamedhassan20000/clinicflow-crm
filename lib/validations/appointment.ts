import { z } from "zod";

export const appointmentSchema = z.object({
  patient_id: z.string().uuid("Select a patient"),
  doctor_id: z.string().uuid("Select a doctor"),
  department_id: z.string().uuid().optional().nullable(),
  scheduled_at: z
    .string()
    .min(1, "Select a date and time")
    .refine((v) => !isNaN(Date.parse(v)), "Invalid date/time"),
  duration_minutes: z.number().int().min(15).max(240).default(30),
  insurance_provider_id: z.string().uuid().optional().nullable(),
  package_id: z.string().uuid("Select a valid package").optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export type AppointmentFormValues = z.infer<typeof appointmentSchema>;

export const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
  "insurance",
] as const;

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export const lineItemSchema = z.object({
  service_id: z.string().uuid().optional().nullable(),
  name: z.string().min(1, "Service name is required").max(120),
  price: z.number().nonnegative("Price cannot be negative"),
  quantity: z.number().int().min(1, "Quantity must be at least 1").max(99),
});

export type LineItemValues = z.infer<typeof lineItemSchema>;

export const billingSchema = z
  .object({
    line_items: z
      .array(lineItemSchema)
      .min(1, "Add at least one service to the invoice"),
    paid_amount: z.number().nonnegative(),
    payment_method: paymentMethodSchema,
    insurance_amount: z.number().nonnegative().default(0),
    secondary_payment_method: paymentMethodSchema.nullable().optional(),
    secondary_amount: z.number().nonnegative().default(0),
    deposit_amount: z.number().nonnegative().default(0),
    payment_note: z.string().max(500).nullable().optional(),
    previous_settlement_amount: z.number().default(0),
    previous_payment_method: paymentMethodSchema.nullable().optional(),
    previous_note: z
      .string()
      .max(500, "Previous note must be 500 characters or less.")
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
      message: "Secondary method must differ from primary.",
    },
  )
  .superRefine((v, ctx) => {
    if (v.previous_settlement_amount < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["previous_settlement_amount"],
        message: "Previous settlement amount cannot be negative.",
      });
    }
    if (v.previous_settlement_amount > 0 && !v.previous_payment_method) {
      ctx.addIssue({
        code: "custom",
        path: ["previous_payment_method"],
        message: "Select a payment method for previous balance.",
      });
    }
  })
  .transform((v) => ({
    ...v,
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
      message: "Select a payment method for previous balance.",
    },
  );

export type BillingValues = z.input<typeof billingSchema>;

export const depositSchema = z.object({
  patient_id: z.string().uuid(),
  amount: z.number().positive("Amount must be greater than zero"),
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
};
