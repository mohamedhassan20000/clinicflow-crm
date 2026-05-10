import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511003000_allow_staff_document_mime_types.sql",
  ),
  "utf8",
);

describe("staff document storage mime migration", () => {
  it("adds PDF and preserves existing staff document MIME types on clinic-assets", () => {
    expect(migration).toContain("where id = 'clinic-assets'");
    expect(migration).toContain("'application/pdf'");
    expect(migration).toContain("'image/png'");
    expect(migration).toContain("'image/jpeg'");
    expect(migration).toContain("'image/webp'");
    expect(migration).toContain("'application/msword'");
    expect(migration).toContain(
      "'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
    );
  });
});
