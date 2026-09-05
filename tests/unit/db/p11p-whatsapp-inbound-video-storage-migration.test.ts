import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260902120000_p11p_whatsapp_inbound_video_storage.sql";

const migration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");

/**
 * P11P — the bucket must admit what the worker now stores.
 *
 * This is the exact shape of the P8E bug repeating itself: the worker learned a
 * new media kind, the bucket's MIME backstop did not, and every one of those
 * files downloaded and sniffed successfully before dying at Storage. The
 * allow-list is the second half of "the worker stores video", so it is asserted
 * alongside it.
 */
describe("P11P inbound WhatsApp video storage migration", () => {
  it("admits every video MIME the worker can resolve", () => {
    for (const mime of ["video/mp4", "video/3gpp", "video/quicktime", "video/webm"]) {
      expect(migration).toContain(`'${mime}'`);
    }
  });

  it("keeps the bucket private — these are patient files", () => {
    expect(migration).toContain("'whatsapp-inbound',\n  'whatsapp-inbound',\n  false");
    expect(migration).toContain("public = false");
    // The bucket deliberately has no `authenticated` storage policy; media is
    // served through signed URLs and the voice endpoint instead.
    expect(migration).not.toMatch(/create\s+policy[\s\S]*whatsapp-inbound/i);
  });

  /**
   * The upsert rewrites `allowed_mime_types` wholesale, so anything missing
   * from this migration is silently *revoked* from a bucket that is already
   * storing it. Every previously admitted type is re-asserted here.
   */
  it("re-admits every type earlier migrations allowed, since the upsert replaces the list", () => {
    for (const mime of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "audio/aac",
      "audio/flac",
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
    ]) {
      expect(migration, `${mime} would be revoked`).toContain(`'${mime}'`);
    }
  });

  it("is additive: it changes no table, column, policy or existing row", () => {
    expect(migration).not.toMatch(/\b(drop|delete|truncate|alter\s+table)\b/i);
    expect(migration).not.toMatch(/update\s+public\./i);
  });

  it("leaves the size limit where the previous migration set it", () => {
    expect(migration).toContain("16777216");
  });
});
