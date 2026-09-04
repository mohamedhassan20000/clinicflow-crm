import "server-only";

import { tool } from "ai";
import {
  documentPreviewInputSchema,
  prepareDocumentIssue,
} from "@/lib/ai/documents/capability";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function previewDocumentTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Resolve a document snapshot without issuing anything. Auto-fills what the server can derive (reporting period, the active patient or appointment, the issuing user), then reports exactly which required inputs are still missing, turns validation problems into questions, reports any params key it did not recognise under 'unknown_keys', and otherwise returns a structured summary of the document that would be issued — including its language and, for an authored document, its full body. Nothing is written and no document number is consumed. Status 'transient_failure' means retry once, then offer the equivalent page in the app. Status 'unauthorized_scope' is permanent — never retry it, and never state which of an unknown document type, an unavailable one, a record that does not exist, or a record outside the caller's scope caused it. Once this returns status 'ready', call execute_action with 'documents.issue' and pass back the exact 'params' object it returned.",
    inputSchema: documentPreviewInputSchema,
    execute: async (input) =>
      prepareDocumentIssue(ctx.user, input, {
        // Server-derived conversation defaults only; the model never supplies
        // an identity here, and every id is re-authorized by the resolver.
        patientId:
          ctx.activeContext?.patient?.entity_id ?? ctx.activePatientId ?? null,
        appointmentId: ctx.activeContext?.appointment?.entity_id ?? null,
        locale: ctx.locale === "ar" ? "ar" : "en",
      }),
  });
}
