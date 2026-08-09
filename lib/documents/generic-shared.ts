import { z } from "zod";

/**
 * P7 Phase 4 — client-safe schema/types/parsing for the generic free-form
 * ("Create document from scratch") document. Kept out of the server-only
 * resolver so the authoring composer (a client component) can validate + parse
 * the authored body without pulling `server-only` into the browser bundle.
 *
 * The body is a constrained block model (headings + paragraphs) — never raw
 * HTML — honoring the engine's primitive discipline.
 */

export const GENERIC_DOCUMENT_CODE = "GENERIC_DOCUMENT" as const;

export const MAX_GENERIC_TITLE_LENGTH = 160;
export const MAX_GENERIC_BLOCKS = 60;
export const MAX_GENERIC_BLOCK_LENGTH = 4000;

const blockSchema = z.object({
  kind: z.enum(["heading", "paragraph"]),
  text: z.string().trim().min(1).max(MAX_GENERIC_BLOCK_LENGTH),
});
export type GenericDocumentBlock = z.infer<typeof blockSchema>;

export const genericDocumentParamsSchema = z.object({
  documentType: z.literal(GENERIC_DOCUMENT_CODE),
  title: z.string().trim().min(1).max(MAX_GENERIC_TITLE_LENGTH),
  blocks: z.array(blockSchema).min(1).max(MAX_GENERIC_BLOCKS),
});
export type GenericDocumentParams = z.infer<typeof genericDocumentParamsSchema>;

const brandingSchema = z.object({
  name: z.string(), logoSrc: z.string().nullable(), address: z.string().nullable(),
  phone: z.string().nullable(), email: z.string().nullable(), website: z.string().nullable(),
  licenseNo: z.string().nullable(), taxId: z.string().nullable(), footerText: z.string().nullable(),
});
const settingsSchema = z.object({
  watermark: z.string().nullable(), qrEnabled: z.boolean(), numberingPrefix: z.string(),
  numberingYearlyReset: z.boolean(), sequencePadding: z.number().int().min(1).max(12),
});

export const genericDocumentSnapshotSchema = z.object({
  version: z.literal(1),
  documentType: z.literal(GENERIC_DOCUMENT_CODE),
  generatedAt: z.string(),
  title: z.string(),
  blocks: z.array(blockSchema),
  branding: brandingSchema,
  format: z.object({ timeZone: z.string(), timeFormat: z.enum(["12h", "24h"]) }),
  settings: settingsSchema,
});
export type GenericDocumentSnapshot = z.infer<typeof genericDocumentSnapshotSchema>;

/**
 * Parse a plain textarea into the constrained block model: a line starting with
 * `# ` becomes a heading; consecutive non-blank lines join into a paragraph; a
 * blank line ends the paragraph. Never produces raw HTML.
 */
export function parseGenericBody(raw: string): GenericDocumentBlock[] {
  const blocks: GenericDocumentBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text: text.slice(0, MAX_GENERIC_BLOCK_LENGTH) });
    paragraph = [];
  };
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const heading = /^#{1,3}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1].trim().slice(0, MAX_GENERIC_BLOCK_LENGTH) });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks.slice(0, MAX_GENERIC_BLOCKS);
}

export function parseGenericDocumentSnapshot(value: unknown): GenericDocumentSnapshot {
  return genericDocumentSnapshotSchema.parse(value);
}
