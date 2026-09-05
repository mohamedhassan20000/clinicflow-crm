import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260821210000_p8e_whatsapp_inbound_audio_storage.sql",
  ),
  "utf8",
);

describe("P8E inbound WhatsApp audio storage migration", () => {
  it("keeps the inbound bucket private while admitting every worker-supported audio base MIME", () => {
    expect(migration).toContain("'whatsapp-inbound',\n  'whatsapp-inbound',\n  false");
    for (const mime of [
      "audio/aac",
      "audio/flac",
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
    ]) {
      expect(migration).toContain(`'${mime}'`);
    }
    expect(migration).toContain("public = false");
    expect(migration).not.toMatch(/create\s+policy[\s\S]*whatsapp-inbound/i);
  });

  it("preserves the existing image and document allow-list", () => {
    for (const mime of ["image/jpeg", "image/png", "application/pdf", "text/plain"]) {
      expect(migration).toContain(`'${mime}'`);
    }
  });
});
