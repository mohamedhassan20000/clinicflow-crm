import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const types = readFileSync("types/database.ts", "utf8");

describe("P2A generated database types", () => {
  it("exposes the user_ui_preferences store", () => {
    const start = types.indexOf("user_ui_preferences: {");
    expect(start).toBeGreaterThan(-1);

    const table = types.slice(start, start + 900);
    expect(table).toContain("user_id: string");
    expect(table).toContain("theme: string");
    expect(table).toContain("locale: string");
    expect(table).toContain("created_at: string");
    expect(table).toContain("updated_at: string");
  });

  it("keeps user_id required on insert — a row is always somebody's", () => {
    const start = types.indexOf("user_ui_preferences: {");
    const insert = types.slice(types.indexOf("Insert: {", start), types.indexOf("Update: {", start));
    expect(insert).toContain("user_id: string");
    // theme/locale are optional on insert: the database supplies light/en.
    expect(insert).toContain("theme?: string");
    expect(insert).toContain("locale?: string");
  });
});
