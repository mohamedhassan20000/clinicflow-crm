import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260821180000_p8d_whatsapp_inbound_audio.sql",
  ),
  "utf8",
);

describe("P8D inbound WhatsApp audio migration", () => {
  it("extends the generic audio model without changing its compatible media kinds", () => {
    expect(migration).toContain("add column if not exists voice_note boolean not null default false");
    expect(migration).toContain("add column if not exists duration_seconds integer");
    expect(migration).toContain("not voice_note or media_kind = 'audio'");
    expect(migration).toContain("duration_seconds between 0 and 604800");
    expect(migration).not.toMatch(/alter\s+type/i);
  });

  it("repairs only unambiguous historical voice markers", () => {
    expect(migration).toContain("message.body = '[voice message]'");
    expect(migration).toContain("attachment.media_kind = 'audio'");
    expect(migration).toContain("set voice_note = true");
  });
});

