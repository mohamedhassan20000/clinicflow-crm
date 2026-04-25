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
  );

export type BillingValues = z.infer<typeof billingSchema>;

export const depositSchema = z.object({
  patient_id: z.string().uuid(),
  amount: z.number().positive("Amount must be greater than zero"),
  payment_method: paymentMethodSchema,
  note: z.string().max(500).optional().nullable(),
});

export type DepositValues = z.infer<typeof depositSchema>;

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};
