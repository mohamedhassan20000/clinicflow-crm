import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterProfileAttachment } from "@/lib/documents/resolvers/roster-profile";

const files = new Map<string, Uint8Array>();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ storage: { from: () => ({
    download: async (path: string) => {
      const bytes = files.get(path);
      return bytes
        ? { data: new Blob([Uint8Array.from(bytes).buffer]), error: null }
        : { data: null, error: new Error("missing") };
    },
  }) } }),
}));

import { mergeRosterProfileAttachments } from "@/lib/documents/pdf/merge-attachments";

async function onePagePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return new Uint8Array(await pdf.save());
}

describe("P7-5 canonical attachment merging", () => {
  beforeEach(() => files.clear());

  it("appends PDF and WebP sources and returns self-contained canonical bytes", async () => {
    const canonical = await onePagePdf();
    const attachedPdf = await onePagePdf();
    const webp = new Uint8Array(await sharp({ create: { width: 24, height: 24, channels: 4,
      background: { r: 20, g: 90, b: 180, alpha: 1 } } }).webp().toBuffer());
    files.set("patient.pdf", attachedPdf);
    files.set("photo.webp", webp);
    const attachments: RosterProfileAttachment[] = [
      { key: "one", bucket: "patient-assets", path: "patient.pdf", fileName: "patient.pdf",
        label: "Patient document", mimeType: "application/pdf", sizeBytes: attachedPdf.byteLength },
      { key: "two", bucket: "patient-assets", path: "photo.webp", fileName: "photo.webp",
        label: "Patient image", mimeType: "image/webp", sizeBytes: webp.byteLength },
    ];
    const merged = await mergeRosterProfileAttachments(canonical, attachments);
    expect(merged.pageCount).toBe(3);
    files.clear();
    expect((await PDFDocument.load(merged.pdf)).getPageCount()).toBe(3);
  });

  it("rejects a source whose bytes changed after issue-time selection", async () => {
    const canonical = await onePagePdf();
    const attachedPdf = await onePagePdf();
    files.set("changed.pdf", attachedPdf);
    await expect(mergeRosterProfileAttachments(canonical, [{ key: "changed",
      bucket: "clinic-assets", path: "changed.pdf", fileName: "changed.pdf", label: "Contract",
      mimeType: "application/pdf", sizeBytes: attachedPdf.byteLength + 1 }]))
      .rejects.toThrow("changed after selection");
  });
});
