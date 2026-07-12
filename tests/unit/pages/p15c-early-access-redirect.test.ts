import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P1.5C legacy early-access route", () => {
  it("uses a permanent redirect to the integrated section", () => {
    const source = readFileSync("app/(public)/early-access/page.tsx", "utf8");
    expect(source).toContain('permanentRedirect("/#early-access")');
  });
});
