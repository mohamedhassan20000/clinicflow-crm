import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const types = readFileSync("types/database.ts", "utf8");
describe("P1.5D generated database type coverage", () => {
  it("contains all five phone validity columns and staff invitation phone shapes", () => {
    expect(types.match(/phone_e164_valid: boolean/g)).toHaveLength(5);
    const staff = types.slice(types.indexOf("staff_invitations:"), types.indexOf("subscriptions:"));
    expect(staff).toContain("phone: string | null");
    expect(staff).toContain("phone?: string | null");
  });
});

