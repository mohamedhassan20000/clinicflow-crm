import "server-only";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  MAX_MERGED_ATTACHMENT_BYTES,
  MAX_MERGED_PDF_PAGES,
  type RosterProfileAttachment,
} from "@/lib/documents/resolvers/roster-profile";
import { createClient } from "@/lib/supabase/server";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const IMAGE_MARGIN = 36;

async function downloadAttachment(attachment: RosterProfileAttachment) {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(attachment.bucket).download(attachment.path);
  if (error || !data) throw new Error(`Attachment is unavailable: ${attachment.fileName}`);
  if (data.size !== attachment.sizeBytes || data.size > 10 * 1024 * 1024) {
    throw new Error(`Attachment changed after selection: ${attachment.fileName}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Appends immutable copies of selected source files to the canonical profile
 * PDF. The resulting bytes are stored as one artifact, so later source-file
 * deletion cannot change reprints.
 */
export async function mergeRosterProfileAttachments(
  canonicalPdf: Uint8Array,
  attachments: readonly RosterProfileAttachment[],
) {
  if (attachments.length === 0) {
    const document = await PDFDocument.load(canonicalPdf);
    return { pdf: canonicalPdf, pageCount: document.getPageCount() };
  }
  if (attachments.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_MERGED_ATTACHMENT_BYTES) {
    throw new Error("Selected attachments exceed the merged size limit");
  }

  const destination = await PDFDocument.load(canonicalPdf);
  for (const attachment of attachments) {
    const bytes = await downloadAttachment(attachment);
    if (attachment.mimeType === "application/pdf") {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: false });
      const copied = await destination.copyPages(source, source.getPageIndices());
      copied.forEach((page) => destination.addPage(page));
    } else {
      const normalized = attachment.mimeType === "image/jpeg"
        ? bytes
        : new Uint8Array(await sharp(bytes).png().toBuffer());
      const image = attachment.mimeType === "image/jpeg"
        ? await destination.embedJpg(normalized)
        : await destination.embedPng(normalized);
      const page = destination.addPage([A4_WIDTH, A4_HEIGHT]);
      const bounds = { width: A4_WIDTH - IMAGE_MARGIN * 2, height: A4_HEIGHT - IMAGE_MARGIN * 2 };
      const scale = Math.min(bounds.width / image.width, bounds.height / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, {
        x: (A4_WIDTH - width) / 2,
        y: (A4_HEIGHT - height) / 2,
        width,
        height,
      });
    }
    if (destination.getPageCount() > MAX_MERGED_PDF_PAGES) {
      throw new Error("Merged PDF exceeds the page limit");
    }
  }
  return { pdf: new Uint8Array(await destination.save()), pageCount: destination.getPageCount() };
}
