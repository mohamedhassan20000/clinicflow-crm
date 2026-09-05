import "server-only";

/**
 * PHI-free lifecycle diagnostics for outbound WhatsApp media.
 *
 * Keep this deliberately narrower than a generic logger. Callers cannot attach
 * message text, recipients, filenames, object paths/URLs, provider errors, or
 * credentials because none of those fields exist in this input type.
 */
export type OutboundMediaDiagnosticStage =
  | "upload_started"
  | "upload_completed"
  | "media_claim_created"
  | "provider_request_started"
  | "finalize_success"
  | "finalize_failure";

export function logOutboundMediaDiagnostic(input: {
  stage: OutboundMediaDiagnosticStage;
  clinicId: string;
  mediaKind?: "image" | "document" | "audio" | null;
  source?: "upload" | "voice_note" | "patient_document" | "clinic_document" | null;
  bucket?: "whatsapp-outbound" | "patient-assets" | "clinic-documents" | null;
  byteSize?: number | null;
  outcome?: "started" | "completed" | "failed" | "released" | "held";
  reasonCode?: string | null;
  hasOutboundMessageId?: boolean;
}): void {
  console.info("outbound_media", {
    scope: "outbound_media",
    ...input,
  });
}
