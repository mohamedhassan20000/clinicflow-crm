import { z } from "zod";
import { documentPresentationLifecycle } from "@/components/documents/engine";
import {
  getDocumentCatalogEntry,
  isRegisteredDocumentType,
} from "@/lib/documents/catalog";
import type { DocumentIssueReservation } from "@/lib/documents/issuance";
import { getDocumentPdfRenderer } from "@/lib/documents/renderers/registry";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const documentIdSchema = z.string().uuid();

function unavailable(): Response {
  return new Response("Document PDF unavailable", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function safeFilename(documentNumber: string): string {
  const base = documentNumber.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${base || "document"}.pdf`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const parsedId = documentIdSchema.safeParse(id);
  if (!parsedId.success) return unavailable();

  const supabase = await createClient();
  const { data: document, error } = await supabase
    .from("documents")
    .select(
      "id, doc_type, document_number, verification_token, status, locale, params, snapshot, watermark_snapshot, pdf_storage_path",
    )
    .eq("clinic_id", user.clinicId)
    .eq("id", parsedId.data)
    .maybeSingle();

  if (
    error
    || !document
    || !isRegisteredDocumentType(document.doc_type)
    || !getDocumentCatalogEntry(document.doc_type).pageRoles.includes(user.role)
    || (document.status !== "issued"
      && document.status !== "void"
      && document.status !== "cancelled")
    || (document.locale !== "ar" && document.locale !== "en")
    || !document.pdf_storage_path
  ) {
    return unavailable();
  }

  try {
    if (document.status === "issued") {
      const signed = await supabase.storage
        .from("clinic-documents")
        .createSignedUrl(document.pdf_storage_path, 60);
      if (signed.error || !signed.data?.signedUrl) {
        throw signed.error ?? new Error("Canonical PDF signed URL was not created");
      }
      return new Response(null, {
        status: 307,
        headers: {
          "Cache-Control": "private, no-store",
          Location: signed.data.signedUrl,
        },
      });
    }

    const reservation: DocumentIssueReservation = {
      documentId: document.id,
      documentNumber: document.document_number,
      verificationToken: document.verification_token,
      status: "issued",
      reused: true,
      documentType: document.doc_type,
      locale: document.locale,
      params: document.params,
      snapshot: document.snapshot,
      watermark: document.watermark_snapshot,
      presentationLifecycle: documentPresentationLifecycle(document.status),
    };
    const artifact = await getDocumentPdfRenderer(document.doc_type)(reservation);
    const body = Uint8Array.from(artifact.pdf).buffer;

    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${safeFilename(document.document_number)}"`,
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (renderError) {
    console.error("document_pdf_presentation_failed", {
      clinicId: user.clinicId,
      documentId: document.id,
      documentType: document.doc_type,
      status: document.status,
      message: renderError instanceof Error ? renderError.message : "unknown",
    });
    return unavailable();
  }
}
