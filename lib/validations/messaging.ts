import "@/lib/validations/error-map";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone/registry";

/**
 * §7.4 — Unicode bidirectional control characters. These reorder rendered
 * text independently of its logical order, so an attacker can craft a
 * template or message body that displays differently from what is stored and
 * approved (the "Trojan Source" class). We reject them at the shared
 * validation boundary — applied to every user-controlled messaging/template
 * string, not just the UI — because normal Arabic and Hebrew text needs none
 * of them: the bidi algorithm handles right-to-left script from the
 * characters' own strong directionality. Newlines/tabs/normal spaces are
 * unaffected.
 *
 * Blocked: the explicit embedding/override formatters U+202A–U+202E, the
 * isolate formatters U+2066–U+2069, and the deprecated marks U+200E/U+200F/
 * U+061C. Left unblocked: ordinary Arabic letters, diacritics, and
 * presentation forms.
 */
const UNICODE_BIDI_CONTROLS =
  /[‪-‮⁦-⁩‎‏؜]/u;

export function hasUnsafeBidiControls(value: string): boolean {
  return UNICODE_BIDI_CONTROLS.test(value);
}

/** Shared refinement: rejects strings carrying Unicode bidi control characters. */
export function noBidiControls<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((value) => !hasUnsafeBidiControls(value), {
    message: "validation.unsafeText",
  });
}

/**
 * §7.4 allowed template-variable set. Mirrored (not imported) from
 * lib/messaging/patient-copy.ts because that module is server-only and this
 * schema is shared with client-side forms.
 */
export const TEMPLATE_VARIABLE_OPTIONS = [
  "patient_name",
  "clinic_name",
  "doctor_name",
  "appointment_date",
  "appointment_time",
] as const;

export const dialog360ConnectionSchema = z.object({
  apiKey: z.string().trim().min(16, "validation.tooSmall").max(500),
  phoneNumberId: z.string().trim().regex(/^\d{5,32}$/, "validation.invalidFormat"),
  displayPhoneNumber: z
    .string()
    .trim()
    .refine((value) => normalizePhone(value) !== null, "validation.invalidFormat"),
});

export const templateSubmissionSchema = z.object({
  templateId: z.string().uuid("validation.invalidFormat"),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
});

export const inboxReplySchema = z
  .object({
    conversationId: z.string().uuid("validation.invalidFormat"),
    body: noBidiControls(z.string().trim().max(4096, "validation.tooBig")).default(""),
    templateId: z.string().uuid("validation.invalidFormat").nullable().optional(),
    templateParameters: z
      .array(
        noBidiControls(
          z.string().trim().min(1, "validation.tooSmall").max(1000, "validation.tooBig"),
        ),
      )
      .max(20, "validation.tooBig")
      .default([]),
  })
  .refine((value) => value.body.length > 0 || Boolean(value.templateId), {
    message: "validation.tooSmall",
    path: ["body"],
  });

export const conversationAssignmentSchema = z.object({
  conversationId: z.string().uuid("validation.invalidFormat"),
  assignedTo: z.string().uuid("validation.invalidFormat").nullable(),
});

export const conversationPatientSchema = z.object({
  conversationId: z.string().uuid("validation.invalidFormat"),
  patientId: z.string().uuid("validation.invalidFormat").nullable(),
});

export const conversationStatusSchema = z.object({
  conversationId: z.string().uuid("validation.invalidFormat"),
  status: z.enum(["open", "closed"]),
});

export const messageTemplateSchema = z
  .object({
    id: z.string().uuid("validation.invalidFormat").nullable().optional(),
    channel: z.enum(["whatsapp", "email"]),
    name: noBidiControls(
      z.string().trim().min(1, "validation.tooSmall").max(200, "validation.tooBig"),
    ),
    language: z.enum(["ar", "en"]),
    body: noBidiControls(
      z.string().trim().min(1, "validation.tooSmall").max(1024, "validation.tooBig"),
    ),
    variables: z
      .array(z.enum(TEMPLATE_VARIABLE_OPTIONS))
      .max(10, "validation.tooBig")
      .default([]),
  })
  .superRefine((value, ctx) => {
    // WhatsApp template names must satisfy the provider contract.
    if (value.channel === "whatsapp" && !/^[a-z0-9_]{1,64}$/.test(value.name)) {
      ctx.addIssue({
        code: "custom",
        message: "validation.invalidFormat",
        path: ["name"],
      });
    }
    if (new Set(value.variables).size !== value.variables.length) {
      ctx.addIssue({
        code: "custom",
        message: "validation.invalidFormat",
        path: ["variables"],
      });
    }
    // Every {{token}} in the body must resolve to a declared variable (by
    // name, or positionally as {{1}}..{{n}}).
    const tokens = [...value.body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(
      (match) => match[1],
    );
    for (const token of tokens) {
      const positional = /^\d+$/.test(token)
        ? Number.parseInt(token, 10)
        : null;
      const valid =
        positional !== null
          ? positional >= 1 && positional <= value.variables.length
          : (value.variables as readonly string[]).includes(token);
      if (!valid) {
        ctx.addIssue({
          code: "custom",
          message: "validation.invalidFormat",
          path: ["body"],
        });
        break;
      }
    }
  });

export const messageTemplateDeleteSchema = z.object({
  id: z.string().uuid("validation.invalidFormat"),
});

export const notificationIdSchema = z.object({
  id: z.string().uuid("validation.invalidFormat"),
});
